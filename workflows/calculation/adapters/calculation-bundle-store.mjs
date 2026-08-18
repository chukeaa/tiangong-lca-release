import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";

import { isUuid } from "../contracts/result-set.mjs";

const { Pool } = pg;
const SHA256 = /^[0-9a-f]{64}$/;

export class CalculationBundleStoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "CalculationBundleStoreError";
    this.code = code;
    this.details = details;
  }
}

const required = (env, key) => {
  const value = env[key]?.trim();
  if (!value)
    throw new CalculationBundleStoreError(
      "data_plane_configuration_required",
      `${key} is required for the Calculation Bundle data plane`,
      { missingKey: key },
    );
  return value;
};

function bundleFromRow(row, { includeLocators = false, summary = false } = {}) {
  const ref = row.artifact_manifest?.calculationBundle;
  if (!ref || typeof ref !== "object")
    throw new CalculationBundleStoreError(
      "calculation_bundle_not_available",
      `Package ${row.id} does not contain a Calculation Bundle`,
      { packageId: row.id },
    );
  const result = {
    packageId: row.id,
    packageVersion: row.package_version,
    packageStatus: row.status,
    snapshotId: row.snapshot_id,
    resultId: row.result_id,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    bundle: {
      schemaVersion: ref.schemaVersion ?? null,
      bundleContentHash: ref.bundleContentHash ?? null,
      manifestSha256: ref.manifestSha256 ?? null,
      manifestByteSize: Number(ref.manifestByteSize),
      artifactCount: Number(ref.artifactCount),
    },
    availableImpactCategoryCount: Array.isArray(row.available_impact_categories)
      ? row.available_impact_categories.length
      : 0,
    productDownloadCount: Array.isArray(ref.downloads)
      ? ref.downloads.length
      : 0,
    ...(summary
      ? {}
      : {
          availableImpactCategories: Array.isArray(
            row.available_impact_categories,
          )
            ? row.available_impact_categories
            : [],
          productDownloads: Array.isArray(ref.downloads)
            ? ref.downloads.map((entry) => ({
                role: entry.role ?? null,
                group: entry.group ?? null,
                fileName: entry.fileName ?? null,
                mediaType: entry.mediaType ?? null,
                sha256: entry.sha256 ?? null,
                byteSize: Number(entry.byteSize),
                recordCount: Number(entry.recordCount),
                ...(includeLocators
                  ? { artifactUrl: entry.artifactUrl ?? null }
                  : {}),
              }))
            : [],
        }),
  };
  if (includeLocators)
    result.storage = { manifestUrl: ref.manifestUrl ?? null };
  return result;
}

function poolFor(env) {
  const connectionString = required(env, "CONN");
  let normalizedConnectionString = connectionString;
  let ssl;
  try {
    const parsed = new URL(connectionString);
    const sslMode = parsed.searchParams.get("sslmode");
    if (["require", "prefer"].includes(sslMode)) {
      parsed.searchParams.delete("sslmode");
      normalizedConnectionString = parsed.toString();
      ssl = { rejectUnauthorized: false };
    }
  } catch {
    // Let pg report malformed libpq connection strings without echoing them.
  }
  return new Pool({
    connectionString: normalizedConnectionString,
    ...(ssl ? { ssl } : {}),
    max: 2,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    application_name: "tiangong-lca-release-calculation",
    options: "-c statement_timeout=15000 -c default_transaction_read_only=on",
  });
}

const SELECT_COLUMNS = `
  id, package_version, status, snapshot_id, result_id, created_at,
  artifact_manifest, available_impact_categories
`;

export function createCalculationBundleStore({
  env = process.env,
  poolFactory = poolFor,
} = {}) {
  const withConfiguredPool = async (operation) => {
    const pool = poolFactory(env);
    try {
      return await operation(pool);
    } catch (error) {
      if (error instanceof CalculationBundleStoreError) throw error;
      throw new CalculationBundleStoreError(
        "database_read_failed",
        "Calculation Bundle database read failed",
        {
          phase: "database_read",
          cause:
            error instanceof Error ? (error.code ?? error.name) : "unknown",
        },
      );
    } finally {
      await pool.end();
    }
  };
  return {
    async list(limit) {
      return withConfiguredPool(async (pool) => {
        const result = await pool.query(
          `select ${SELECT_COLUMNS}
             from private.lcia_result_packages
            where artifact_manifest ? 'calculationBundle'
            order by created_at desc, id desc
            limit $1`,
          [limit + 1],
        );
        return {
          items: result.rows
            .slice(0, limit)
            .map((row) => bundleFromRow(row, { summary: true })),
          completeness: {
            status: result.rows.length > limit ? "bounded" : "complete",
            limit,
            returned: Math.min(result.rows.length, limit),
            mayHaveMore: result.rows.length > limit,
            source: "direct_read_only_database",
          },
        };
      });
    },
    async get(packageId, { includeLocators = false } = {}) {
      if (!isUuid(packageId))
        throw new CalculationBundleStoreError(
          "invalid_request",
          "packageId must be an exact UUID",
        );
      return withConfiguredPool(async (pool) => {
        const result = await pool.query(
          `select ${SELECT_COLUMNS}
             from private.lcia_result_packages
            where id = $1::uuid`,
          [packageId],
        );
        if (!result.rows.length)
          throw new CalculationBundleStoreError(
            "package_not_found",
            `Package ${packageId} was not found`,
            { packageId },
          );
        return bundleFromRow(result.rows[0], { includeLocators });
      });
    },
  };
}

function storageRef(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "s3:") {
      const objectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      return url.hostname && objectKey
        ? { bucket: url.hostname, objectKey }
        : null;
    }
    const marker = "/storage/v1/s3/";
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    const remainder = url.pathname.slice(index + marker.length);
    const split = remainder.indexOf("/");
    if (split <= 0 || split === remainder.length - 1) return null;
    return {
      bucket: decodeURIComponent(remainder.slice(0, split)),
      objectKey: decodeURIComponent(remainder.slice(split + 1)),
    };
  } catch {
    return null;
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) return null;
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  )
    return null;
  return normalized;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function existingVerified(file, expected) {
  try {
    const info = await stat(file);
    return (
      info.isFile() &&
      info.size === expected.byteSize &&
      (await sha256File(file)) === expected.sha256
    );
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function downloadVerified(client, ref, target, expected) {
  if (
    !Number.isSafeInteger(expected.byteSize) ||
    expected.byteSize < 0 ||
    !SHA256.test(expected.sha256)
  )
    throw new CalculationBundleStoreError(
      "artifact_metadata_invalid",
      `Artifact metadata is invalid for ${expected.path}`,
      { phase: "metadata_validation", path: expected.path },
    );
  if (await existingVerified(target, expected)) return { reused: true };
  try {
    await stat(target);
    throw new CalculationBundleStoreError(
      "local_artifact_conflict",
      `Existing local artifact does not match expected integrity: ${expected.path}`,
      { phase: "local_write", path: expected.path },
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.part-${process.pid}`;
  const hash = createHash("sha256");
  let byteSize = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      byteSize += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }),
    );
    if (!response.Body) throw new Error("S3 response contained no body");
    await pipeline(
      response.Body,
      meter,
      createWriteStream(temporary, { mode: 0o600 }),
    );
    const observedSha256 = hash.digest("hex");
    if (byteSize !== expected.byteSize || observedSha256 !== expected.sha256)
      throw new CalculationBundleStoreError(
        "artifact_integrity_mismatch",
        `Downloaded artifact failed integrity validation: ${expected.path}`,
        {
          phase: "artifact_verification",
          path: expected.path,
          expectedByteSize: expected.byteSize,
          observedByteSize: byteSize,
          expectedSha256: expected.sha256,
          observedSha256,
        },
      );
    await rename(temporary, target);
    return { reused: false };
  } catch (error) {
    await unlink(temporary).catch(() => {});
    if (error instanceof CalculationBundleStoreError) throw error;
    throw new CalculationBundleStoreError(
      "artifact_download_failed",
      `S3 download failed for ${expected.path}`,
      {
        phase: "artifact_download",
        path: expected.path,
        cause: error instanceof Error ? error.name : "unknown",
      },
    );
  }
}

async function boundedMap(items, concurrency, operation) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

export async function downloadCalculationBundle({
  metadata,
  outDir,
  env = process.env,
  concurrency = 8,
  includeProducts = false,
  s3Client,
}) {
  const manifestRef = storageRef(metadata.storage?.manifestUrl);
  const configuredBucket = required(env, "S3_BUCKET");
  if (!manifestRef || manifestRef.bucket !== configuredBucket)
    throw new CalculationBundleStoreError(
      "bundle_storage_ref_invalid",
      "Calculation Bundle manifest is not in the configured S3 bucket",
      { phase: "metadata_validation", packageId: metadata.packageId },
    );
  const client =
    s3Client ??
    new S3Client({
      endpoint: required(env, "S3_ENDPOINT"),
      region: required(env, "S3_REGION"),
      forcePathStyle: true,
      credentials: {
        accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
        secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
      },
    });
  const root = path.resolve(outDir);
  await mkdir(root, { recursive: true });
  const manifestPath = path.join(root, "calculation-bundle.json");
  await downloadVerified(client, manifestRef, manifestPath, {
    path: "calculation-bundle.json",
    sha256: metadata.bundle.manifestSha256,
    byteSize: metadata.bundle.manifestByteSize,
  });
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new CalculationBundleStoreError(
      "bundle_manifest_invalid_json",
      "Calculation Bundle manifest is not valid JSON",
      { phase: "manifest_validation", packageId: metadata.packageId },
    );
  }
  if (
    manifest.schemaVersion !== metadata.bundle.schemaVersion ||
    manifest.bundleContentHash !== metadata.bundle.bundleContentHash ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== metadata.bundle.artifactCount
  )
    throw new CalculationBundleStoreError(
      "bundle_manifest_binding_mismatch",
      "Calculation Bundle manifest does not match its database identity",
      { phase: "manifest_validation", packageId: metadata.packageId },
    );
  const parent = path.posix.dirname(manifestRef.objectKey);
  const artifacts = manifest.artifacts.map((entry) => {
    const relative = safeRelativePath(entry?.path);
    if (!relative)
      throw new CalculationBundleStoreError(
        "unsafe_artifact_path",
        "Calculation Bundle contains an unsafe artifact path",
        { phase: "manifest_validation" },
      );
    return {
      ref: {
        bucket: manifestRef.bucket,
        objectKey: path.posix.join(parent, relative),
      },
      target: path.join(root, ...relative.split("/")),
      expected: {
        path: relative,
        sha256: entry.sha256,
        byteSize: Number(entry.byteSize),
      },
    };
  });
  const artifactResults = await boundedMap(artifacts, concurrency, (entry) =>
    downloadVerified(client, entry.ref, entry.target, entry.expected),
  );
  const productResults = [];
  if (includeProducts) {
    for (const product of metadata.productDownloads) {
      const ref = storageRef(product.artifactUrl);
      const relative = safeRelativePath(`downloads/${product.fileName}`);
      if (!ref || ref.bucket !== configuredBucket || !relative)
        throw new CalculationBundleStoreError(
          "product_storage_ref_invalid",
          `Product download storage reference is invalid: ${product.role}`,
          { phase: "metadata_validation", role: product.role },
        );
      productResults.push({
        ref,
        target: path.join(root, ...relative.split("/")),
        expected: { ...product, path: relative },
      });
    }
    await boundedMap(productResults, concurrency, (entry) =>
      downloadVerified(client, entry.ref, entry.target, entry.expected),
    );
  }
  const receipt = {
    schemaVersion: "tiangong.calculation-bundle-download-receipt.v1",
    packageId: metadata.packageId,
    packageVersion: metadata.packageVersion,
    bundle: metadata.bundle,
    localRoot: root,
    artifactCount: artifacts.length,
    productDownloadCount: productResults.length,
    reusedArtifactCount: artifactResults.filter((entry) => entry.reused).length,
    verification: {
      manifest: "verified",
      artifacts: "verified",
      products: includeProducts ? "verified" : "not_requested",
    },
    completedAt: new Date().toISOString(),
  };
  const receiptPath = path.join(root, "download-receipt.json");
  const temporaryReceipt = `${receiptPath}.tmp-${process.pid}`;
  await writeFile(temporaryReceipt, `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryReceipt, receiptPath);
  if (!s3Client) client.destroy();
  return { receipt, receiptPath, bundleDirectory: root };
}
