import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import pg from "pg";
import QueryStream from "pg-query-stream";

import { canonicalJson, fail } from "./common.mjs";

const { Pool } = pg;
export const DEFAULT_FLOW_CACHE = ".release/release/cache/elementary-flows";

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
        where state_code between 100 and 199`,
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
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    return { root: target, manifest };
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
