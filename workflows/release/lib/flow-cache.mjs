import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import pg from "pg";
import QueryStream from "pg-query-stream";

import { canonicalJson, fail } from "./common.mjs";

const { Pool } = pg;
export const DEFAULT_FLOW_CACHE = ".release/release/cache/elementary-flows";
export const DEFAULT_FLOW_CACHE_EXECUTION = "remote";
const REMOTE_TRANSFER_SCHEMA =
  "tiangong.release.elementary-flow-cache-transfer.v1";
const REMOTE_EXPORT_SCRIPT = fileURLToPath(
  new URL("../scripts/remote-flow-cache-export.py", import.meta.url),
);
const SSH_TRANSPORT_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

export async function inspectFlowCache({
  cacheDir,
  env = process.env,
  poolFactory = createPool,
}) {
  const root = path.resolve(cacheDir);
  const manifest = await readManifest(root, false);
  const pool = poolFactory(env);
  try {
    const database = await readWatermark(pool);
    if (!manifest) return { status: "missing", root, database };
    const current = await verifyArtifact(root, manifest).catch(() => false);
    if (!current) return { status: "invalid", root, database, manifest };
    const fresh = sameWatermark(manifest.databaseWatermark, database);
    return { status: fresh ? "fresh" : "stale", root, database, manifest };
  } finally {
    await pool.end();
  }
}

export async function refreshFlowCache({
  cacheDir,
  env = process.env,
  execution = DEFAULT_FLOW_CACHE_EXECUTION,
  remoteHost,
  poolFactory = createPool,
  remoteExporter = runRemoteFlowCacheExport,
  fetchImpl = globalThis.fetch,
}) {
  if (execution === "local")
    return refreshFlowCacheLocal({ cacheDir, env, poolFactory });
  if (execution !== "remote")
    fail(
      "flow_cache_execution_invalid",
      `Unsupported cache refresh execution: ${execution}`,
      { execution, supported: ["remote", "local"] },
    );
  return refreshFlowCacheRemote({
    cacheDir,
    env,
    remoteHost: remoteHost ?? env.RELEASE_FLOW_CACHE_REMOTE_HOST?.trim(),
    remoteExporter,
    fetchImpl,
  });
}

export async function refreshFlowCacheLocal({
  cacheDir,
  env = process.env,
  poolFactory = createPool,
}) {
  const target = path.resolve(cacheDir);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  const artifact = path.join(staging, "elementary-flows.ndjson");
  const pool = poolFactory(env);
  const client = await pool.connect();
  let writer;
  try {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    await client.query("set local statement_timeout = '30min'");
    const watermark = await readWatermark(client);
    writer = createWriteStream(artifact, { flags: "wx" });
    const hash = createHash("sha256");
    let recordCount = 0;
    const stream = client.query(
      new QueryStream(
        `select id::text, btrim(version::text) as version,
              coalesce(json, json_ordered::jsonb) as document
         from public.flows
        where state_code between 100 and 199
        order by id, btrim(version::text)`,
        [],
        { batchSize: 2_000 },
      ),
    );
    for await (const row of stream) {
      if (!isElementaryFlow(row.document)) continue;
      const line = `${JSON.stringify({ datasetType: "flow", uuid: row.id.toLowerCase(), version: row.version, document: row.document })}\n`;
      hash.update(line);
      recordCount += 1;
      if (!writer.write(line)) await once(writer, "drain");
    }
    writer.end();
    await once(writer, "finish");
    writer = undefined;
    await client.query("commit");
    const manifest = {
      schemaVersion: "tiangong.release.elementary-flow-cache.v1",
      databaseWatermark: watermark,
      artifact: {
        path: "elementary-flows.ndjson",
        sha256: hash.digest("hex"),
        recordCount,
      },
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(staging, "cache-manifest.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    );
    await installStagingDirectory(staging, target);
    return { root: target, manifest, execution: "local" };
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {}
    throw error;
  } finally {
    if (writer) writer.destroy();
    client.release();
    await pool.end();
    await rm(staging, { recursive: true, force: true });
  }
}

export async function refreshFlowCacheRemote({
  cacheDir,
  env = process.env,
  remoteHost,
  remoteExporter = runRemoteFlowCacheExport,
  fetchImpl = globalThis.fetch,
}) {
  validateRemoteHost(remoteHost);
  if (typeof fetchImpl !== "function")
    fail(
      "flow_cache_remote_fetch_unavailable",
      "Remote cache refresh requires the runtime fetch API",
    );
  const target = path.resolve(cacheDir);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  let transfer;
  try {
    transfer = await remoteExporter({ env, remoteHost });
    transfer = validateRemoteTransfer(transfer);
    const compressed = path.join(staging, "elementary-flows.ndjson.gz");
    const compressedEvidence = await downloadToFile({
      url: transfer.downloadUrl,
      destination: compressed,
      fetchImpl,
      maximumByteSize: transfer.compressedByteSize,
    });
    if (
      compressedEvidence.sha256 !== transfer.compressedSha256 ||
      compressedEvidence.byteSize !== transfer.compressedByteSize
    )
      fail(
        "flow_cache_remote_compressed_artifact_mismatch",
        "Downloaded cache transfer does not match the remote artifact evidence",
        {
          expectedSha256: transfer.compressedSha256,
          observedSha256: compressedEvidence.sha256,
          expectedByteSize: transfer.compressedByteSize,
          observedByteSize: compressedEvidence.byteSize,
        },
      );
    const artifact = path.join(staging, "elementary-flows.ndjson");
    const artifactEvidence = await expandAndValidateArtifact({
      source: compressed,
      destination: artifact,
      maximumByteSize: transfer.artifactByteSize,
    });
    if (
      artifactEvidence.sha256 !== transfer.artifactSha256 ||
      artifactEvidence.recordCount !== transfer.recordCount ||
      artifactEvidence.byteSize !== transfer.artifactByteSize
    )
      fail(
        "flow_cache_remote_artifact_mismatch",
        "Expanded cache does not match the remote snapshot evidence",
        {
          expectedSha256: transfer.artifactSha256,
          observedSha256: artifactEvidence.sha256,
          expectedRecordCount: transfer.recordCount,
          observedRecordCount: artifactEvidence.recordCount,
          expectedByteSize: transfer.artifactByteSize,
          observedByteSize: artifactEvidence.byteSize,
        },
      );
    const completedTransfer = transfer;
    await deleteTemporaryObject({ transfer: completedTransfer, fetchImpl });
    transfer = undefined;
    await rm(compressed, { force: true });
    const manifest = {
      schemaVersion: "tiangong.release.elementary-flow-cache.v1",
      databaseWatermark: completedTransfer.databaseWatermark,
      artifact: {
        path: "elementary-flows.ndjson",
        sha256: artifactEvidence.sha256,
        recordCount: artifactEvidence.recordCount,
      },
      createdAt: completedTransfer.createdAt,
    };
    await writeFile(
      path.join(staging, "cache-manifest.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    );
    await installStagingDirectory(staging, target);
    return {
      root: target,
      manifest,
      execution: "remote",
      remoteHost,
      transferExpiresAt: completedTransfer.expiresAt,
    };
  } catch (error) {
    error.details = {
      ...(error.details ?? {}),
      cacheDir: target,
      execution: "remote",
      remoteHost,
    };
    throw error;
  } finally {
    if (transfer)
      await deleteTemporaryObject({ transfer, fetchImpl }).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

export async function runRemoteFlowCacheExport({
  env = process.env,
  remoteHost,
  spawnCommand = runCommand,
}) {
  validateRemoteHost(remoteHost);
  const config = remoteExportConfig(env);
  let remoteDir;
  try {
    const created = await spawnCommand(
      "ssh",
      [
        ...SSH_TRANSPORT_OPTIONS,
        remoteHost,
        "mktemp -d /tmp/tiangong-release-flow-cache.XXXXXXXX",
      ],
      { maxOutputBytes: 4_096 },
    );
    requireCommandSuccess(created, "flow_cache_remote_workspace_failed");
    remoteDir = created.stdout.trim();
    if (!/^\/tmp\/tiangong-release-flow-cache\.[A-Za-z0-9]+$/u.test(remoteDir))
      fail(
        "flow_cache_remote_workspace_invalid",
        "Remote host returned an invalid cache workspace path",
      );
    const remoteScript = `${remoteDir}/remote-flow-cache-export.py`;
    const copied = await spawnCommand(
      "scp",
      [
        "-q",
        ...SSH_TRANSPORT_OPTIONS,
        REMOTE_EXPORT_SCRIPT,
        `${remoteHost}:${remoteScript}`,
      ],
      { maxOutputBytes: 65_536 },
    );
    requireCommandSuccess(copied, "flow_cache_remote_script_copy_failed");
    const executed = await spawnCommand(
      "ssh",
      [...SSH_TRANSPORT_OPTIONS, remoteHost, "python3", remoteScript],
      {
        input: `${JSON.stringify(config)}\n`,
        maxOutputBytes: 1_048_576,
      },
    );
    if (executed.code !== 0) {
      const remoteError = parseJsonObject(executed.stderr);
      fail(
        remoteError?.code ?? "flow_cache_remote_export_failed",
        remoteError?.message ??
          "Remote host could not produce the Elementary Flow cache transfer",
        remoteError?.details ?? {},
      );
    }
    const result = parseJsonObject(executed.stdout);
    if (!result)
      fail(
        "flow_cache_remote_protocol_invalid",
        "Remote host did not return one valid cache transfer result",
      );
    return result;
  } finally {
    if (remoteDir)
      await spawnCommand(
        "ssh",
        [...SSH_TRANSPORT_OPTIONS, remoteHost, "rm", "-rf", "--", remoteDir],
        { maxOutputBytes: 65_536 },
      ).catch(() => {});
  }
}

async function downloadToFile({
  url,
  destination,
  fetchImpl,
  maximumByteSize,
}) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch {
    fail(
      "flow_cache_remote_download_failed",
      "Could not download the temporary cache artifact",
    );
  }
  if (!response?.ok || !response.body)
    fail(
      "flow_cache_remote_download_failed",
      `Temporary cache download returned HTTP ${response?.status ?? "unknown"}`,
      { status: response?.status ?? null },
    );
  const output = await open(destination, "wx");
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      hash.update(chunk);
      byteSize += chunk.byteLength;
      if (byteSize > maximumByteSize)
        fail(
          "flow_cache_remote_compressed_artifact_mismatch",
          "Temporary cache download exceeded its declared byte size",
          { expectedByteSize: maximumByteSize },
        );
      await output.write(chunk);
    }
    await output.close();
  } catch (error) {
    await output.close().catch(() => {});
    if (String(error.code).startsWith("flow_cache_")) throw error;
    fail(
      "flow_cache_remote_download_failed",
      "Temporary cache download was interrupted",
      { cause: error.code ?? error.name ?? "stream_error" },
    );
  }
  return { sha256: hash.digest("hex"), byteSize };
}

async function expandAndValidateArtifact({
  source,
  destination,
  maximumByteSize,
}) {
  const reader = createReadStream(source).pipe(createGunzip());
  const output = await open(destination, "wx");
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let recordCount = 0;
  let byteSize = 0;
  try {
    for await (const chunk of reader) {
      hash.update(chunk);
      byteSize += chunk.byteLength;
      if (byteSize > maximumByteSize)
        fail(
          "flow_cache_remote_artifact_mismatch",
          "Expanded cache exceeded its declared byte size",
          { expectedByteSize: maximumByteSize },
        );
      pending += decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        validateCacheRecord(line, recordCount + 1);
        recordCount += 1;
      }
      await output.write(chunk);
    }
    pending += decoder.end();
    if (pending)
      fail(
        "flow_cache_remote_artifact_invalid",
        "Expanded cache must end with a newline",
      );
    await output.close();
  } catch (error) {
    await output.close().catch(() => {});
    if (String(error.code).startsWith("flow_cache_")) throw error;
    fail(
      "flow_cache_remote_artifact_invalid",
      "Temporary cache could not be decompressed or validated",
      { cause: error.name ?? "stream_error" },
    );
  }
  return { sha256: hash.digest("hex"), recordCount, byteSize };
}

function validateCacheRecord(line, lineNumber) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    fail(
      "flow_cache_remote_artifact_invalid",
      "Expanded cache contains invalid NDJSON",
      { line: lineNumber },
    );
  }
  if (
    record?.datasetType !== "flow" ||
    typeof record.uuid !== "string" ||
    record.uuid !== record.uuid.toLowerCase() ||
    typeof record.version !== "string" ||
    !isElementaryFlow(record.document)
  )
    fail(
      "flow_cache_remote_artifact_invalid",
      "Expanded cache contains an invalid Elementary Flow record",
      { line: lineNumber },
    );
}

async function deleteTemporaryObject({ transfer, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(transfer.deleteUrl, {
      method: "DELETE",
      redirect: "follow",
    });
  } catch {
    fail(
      "flow_cache_remote_cleanup_failed",
      "Could not delete the temporary cache object",
    );
  }
  if (![200, 204].includes(response?.status))
    fail(
      "flow_cache_remote_cleanup_failed",
      `Temporary cache deletion returned HTTP ${response?.status ?? "unknown"}`,
      { status: response?.status ?? null },
    );
}

function validateRemoteTransfer(value) {
  const hashPattern = /^[0-9a-f]{64}$/u;
  if (
    value?.schemaVersion !== REMOTE_TRANSFER_SCHEMA ||
    !hashPattern.test(value.artifactSha256 ?? "") ||
    !hashPattern.test(value.compressedSha256 ?? "") ||
    !Number.isSafeInteger(value.artifactByteSize) ||
    value.artifactByteSize < 0 ||
    !Number.isSafeInteger(value.recordCount) ||
    value.recordCount < 0 ||
    value.recordCount > 10_000_000 ||
    !Number.isSafeInteger(value.compressedByteSize) ||
    value.compressedByteSize < 1 ||
    value.artifactByteSize > 4 * 1024 * 1024 * 1024 ||
    value.compressedByteSize > 4 * 1024 * 1024 * 1024 ||
    !Number.isSafeInteger(value.databaseWatermark?.publishedCount) ||
    (value.databaseWatermark?.maxModifiedAt !== null &&
      typeof value.databaseWatermark?.maxModifiedAt !== "string") ||
    !validHttpsUrl(value.downloadUrl) ||
    !validHttpsUrl(value.deleteUrl) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.expiresAt)
  )
    fail(
      "flow_cache_remote_protocol_invalid",
      "Remote host returned invalid cache transfer evidence",
    );
  const lifetime = Date.parse(value.expiresAt) - Date.now();
  if (lifetime <= 0 || lifetime > 65 * 60 * 1_000)
    fail(
      "flow_cache_remote_protocol_invalid",
      "Remote cache transfer expiry is outside the one-hour contract",
    );
  return value;
}

function remoteExportConfig(env) {
  const required = [
    "CONN",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length)
    fail(
      "flow_cache_remote_configuration_missing",
      `Remote cache refresh requires: ${missing.join(", ")}`,
      { missing },
    );
  return {
    schemaVersion: "tiangong.release.elementary-flow-cache-export-request.v1",
    connectionString: env.CONN.trim(),
    s3Endpoint: env.S3_ENDPOINT.trim(),
    s3Region: env.S3_REGION.trim(),
    s3Bucket: env.S3_BUCKET.trim(),
    s3AccessKeyId: env.S3_ACCESS_KEY_ID.trim(),
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY.trim(),
    s3SessionToken: env.S3_SESSION_TOKEN?.trim() || null,
    expectedProjectRef: env.RELEASE_FLOW_CACHE_PROJECT_REF?.trim() || null,
    objectPrefix:
      env.RELEASE_FLOW_CACHE_S3_PREFIX?.trim() ||
      "_temporary/release/elementary-flow-cache",
  };
}

function validateRemoteHost(host) {
  if (!host)
    fail(
      "flow_cache_remote_host_missing",
      "Remote cache refresh requires --remote-host or RELEASE_FLOW_CACHE_REMOTE_HOST",
    );
  if (!/^[A-Za-z0-9._-]+$/u.test(host ?? ""))
    fail(
      "flow_cache_remote_host_invalid",
      "Remote host must be one configured SSH host name",
      { remoteHost: host },
    );
}

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function requireCommandSuccess(result, code) {
  if (result.code !== 0)
    fail(code, "Remote cache transport command failed", {
      exitCode: result.code,
    });
}

async function runCommand(
  command,
  args,
  { input, maxOutputBytes = 1_048_576 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    const capture = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > maxOutputBytes) {
        exceeded = true;
        child.kill("SIGTERM");
        return next.subarray(0, maxOutputBytes);
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (exceeded) {
        const error = new Error(
          "Remote cache transport exceeded its bounded output contract",
        );
        error.code = "flow_cache_remote_output_too_large";
        reject(error);
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function installStagingDirectory(staging, target) {
  const backup = `${target}.previous-${randomUUID()}`;
  let hadTarget = false;
  try {
    await rename(target, backup);
    hadTarget = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, target);
  } catch (error) {
    if (hadTarget) await rename(backup, target);
    throw error;
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true });
}

export async function requireFreshFlowCache({
  cacheDir,
  env = process.env,
  poolFactory,
}) {
  const result = await inspectFlowCache({ cacheDir, env, poolFactory });
  if (result.status !== "fresh")
    fail(
      `elementary_flow_cache_${result.status}`,
      `Elementary Flow cache is ${result.status}`,
      { cacheDir: result.root, databaseWatermark: result.database },
    );
  return {
    root: result.root,
    manifest: result.manifest,
    artifact: path.join(result.root, result.manifest.artifact.path),
  };
}

async function readWatermark(pool) {
  const { rows } =
    await pool.query(`select count(*)::bigint::text as published_count,
    max(modified_at)::text as max_modified_at from public.flows where state_code between 100 and 199`);
  return {
    publishedCount: Number(rows[0].published_count),
    maxModifiedAt: rows[0].max_modified_at ?? null,
  };
}

function sameWatermark(left, right) {
  return (
    left?.publishedCount === right.publishedCount &&
    left?.maxModifiedAt === right.maxModifiedAt
  );
}
function isElementaryFlow(document) {
  return (
    document?.flowDataSet?.modellingAndValidation?.LCIMethod?.typeOfDataSet ===
    "Elementary flow"
  );
}
async function readManifest(root, required = true) {
  try {
    return JSON.parse(
      await readFile(path.join(root, "cache-manifest.json"), "utf8"),
    );
  } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    throw error;
  }
}
async function verifyArtifact(root, manifest) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(
    path.join(root, manifest.artifact.path),
  ))
    hash.update(chunk);
  return hash.digest("hex") === manifest.artifact.sha256;
}
function createPool(env) {
  const connectionString = env.CONN?.trim();
  if (!connectionString)
    fail(
      "database_configuration_missing",
      "CONN is required to inspect or refresh the Elementary Flow cache",
    );
  let normalizedConnectionString = connectionString;
  let ssl;
  try {
    const parsed = new URL(connectionString);
    if (["require", "prefer"].includes(parsed.searchParams.get("sslmode"))) {
      parsed.searchParams.delete("sslmode");
      normalizedConnectionString = parsed.toString();
      ssl = { rejectUnauthorized: false };
    }
  } catch {}
  return new Pool({
    connectionString: normalizedConnectionString,
    ...(ssl ? { ssl } : {}),
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: "tiangong-lca-release-flow-cache",
    options: "-c default_transaction_read_only=on",
  });
}
