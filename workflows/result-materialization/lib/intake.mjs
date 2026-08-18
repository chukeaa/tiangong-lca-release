import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { canonicalJson, fail, sha256Bytes, sha256File } from "./common.mjs";
import { extractZip } from "./zip.mjs";

export async function createIntake({ bundle, outDir }) {
  const source = path.resolve(bundle);
  const target = path.resolve(outDir);
  const staging = await mkdtemp(`${target}.tmp-`);
  const bundleDir = path.join(staging, "calculation-bundle");
  try {
    const sourceStat = await stat(source);
    if (sourceStat.isDirectory()) {
      await assertNoSymlinks(source);
      await cp(source, bundleDir, { recursive: true, errorOnExist: true });
    } else {
      await mkdir(bundleDir, { recursive: true });
      await extractZip(source, bundleDir);
    }

    const manifestPath = await locateManifest(bundleDir);
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    validateManifestShape(manifest);
    const declaredHash = manifest.bundleContentHash;
    const hashInput = structuredClone(manifest);
    delete hashInput.bundleContentHash;
    const observedBundleHash = sha256Bytes(
      Buffer.from(canonicalJson(hashInput).trimEnd()),
    );
    if (observedBundleHash !== declaredHash) {
      fail(
        "bundle_content_hash_mismatch",
        "Calculation Bundle content hash does not match",
        {
          expected: declaredHash,
          observed: observedBundleHash,
        },
      );
    }

    const artifacts = [];
    for (const artifact of manifest.artifacts) {
      const artifactPath = safeArtifactPath(
        path.dirname(manifestPath),
        artifact.path,
      );
      const observed = await sha256File(artifactPath);
      const artifactStat = await stat(artifactPath);
      if (
        observed !== artifact.sha256 ||
        artifactStat.size !== artifact.byteSize
      ) {
        fail(
          "artifact_integrity_mismatch",
          `Artifact integrity mismatch: ${artifact.path}`,
          {
            expectedSha256: artifact.sha256,
            observedSha256: observed,
            expectedByteSize: artifact.byteSize,
            observedByteSize: artifactStat.size,
          },
        );
      }
      const ndjson = await verifyUncompressedArtifact(artifactPath, artifact);
      artifacts.push({
        kind: artifact.kind,
        path: path.relative(bundleDir, artifactPath),
        sha256: observed,
        recordCount: ndjson.recordCount,
      });
    }

    const intake = {
      schemaVersion: "tiangong.release.materialization-intake.v1",
      source: {
        adapter: "worker-calculation-bundle.v2",
        calculationId: manifest.calculationId,
        bundleContentHash: declaredHash,
        manifestSha256: sha256Bytes(manifestBytes),
      },
      artifacts,
      verification: { manifest: "verified", artifacts: "verified" },
    };
    await writeFile(
      path.join(staging, "intake-manifest.json"),
      canonicalJson(intake),
    );
    await writeFile(
      path.join(staging, "verification-report.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.materialization-verification.v1",
        outcome: "verified",
        artifactCount: artifacts.length,
        calculationId: manifest.calculationId,
        bundleContentHash: declaredHash,
      }),
    );
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await rename(staging, target);
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
        fail(
          "intake_exists",
          `Refusing to overwrite existing intake: ${target}`,
        );
      }
      throw error;
    }
    return { intake, path: target };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function locateManifest(root) {
  const direct = path.join(root, "calculation-bundle.json");
  try {
    await stat(direct);
    return direct;
  } catch {}
  const children = await import("node:fs/promises").then(({ readdir }) =>
    readdir(root, { withFileTypes: true }),
  );
  const candidates = [];
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const candidate = path.join(root, child.name, "calculation-bundle.json");
    try {
      await stat(candidate);
      candidates.push(candidate);
    } catch {}
  }
  if (candidates.length !== 1) {
    fail(
      "bundle_manifest_not_found",
      "Expected exactly one calculation-bundle.json",
    );
  }
  return candidates[0];
}

function validateManifestShape(manifest) {
  if (
    manifest?.schemaVersion !== "tiangong.calculation-bundle.v2" ||
    !Array.isArray(manifest.artifacts) ||
    !/^[0-9a-f]{64}$/.test(manifest.bundleContentHash ?? "")
  ) {
    fail(
      "unsupported_bundle",
      "Only Worker Calculation Bundle v2 is supported",
    );
  }
}

function safeArtifactPath(root, relative) {
  if (typeof relative !== "string" || path.isAbsolute(relative)) {
    fail("unsafe_artifact_path", `Unsafe artifact path: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    fail("unsafe_artifact_path", `Unsafe artifact path: ${relative}`);
  }
  return resolved;
}

async function verifyUncompressedArtifact(file, artifact) {
  if (artifact.compression !== "gzip") {
    return { recordCount: artifact.recordCount };
  }
  const hash = createHash("sha256");
  let byteSize = 0;
  let lineCount = 0;
  let finalByte = null;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      for (const byte of chunk) if (byte === 10) lineCount += 1;
      if (chunk.length) finalByte = chunk[chunk.length - 1];
      callback(null, chunk);
    },
  });
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(createReadStream(file), createGunzip(), meter, sink);
  if (finalByte !== null && finalByte !== 10) lineCount += 1;
  const observedHash = hash.digest("hex");
  if (
    (artifact.uncompressedSha256 &&
      artifact.uncompressedSha256 !== observedHash) ||
    (artifact.uncompressedByteSize != null &&
      artifact.uncompressedByteSize !== byteSize) ||
    artifact.recordCount !== lineCount
  ) {
    fail(
      "artifact_uncompressed_integrity_mismatch",
      `Uncompressed integrity mismatch: ${artifact.path}`,
    );
  }
  return { recordCount: lineCount };
}

async function assertNoSymlinks(root) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if ((await lstat(candidate)).isSymbolicLink()) {
      fail(
        "bundle_symlink_rejected",
        `Bundle directory contains symlink: ${candidate}`,
      );
    }
    if (entry.isDirectory()) await assertNoSymlinks(candidate);
  }
}
