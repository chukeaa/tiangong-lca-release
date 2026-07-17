#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("tiangong-lca 0.0.0-fixture\n");
  process.exit(0);
}
if (argv[0] !== "release" || !argv[1]) {
  process.stderr.write(
    `${JSON.stringify({ code: "fake_release_command_required", message: "release action required" })}\n`,
  );
  process.exit(2);
}

const action = argv[1];
const option = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const statePath = path.join(process.cwd(), ".fake-lca-cli-state.json");
const invocationPath = path.join(
  process.cwd(),
  ".fake-lca-cli-invocations.jsonl",
);
const remoteDirectory = path.join(process.cwd(), ".fake-remote");
const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const writeJson = (filePath, value) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};
const readState = () => {
  try {
    return readJson(statePath);
  } catch {
    return { artifacts: [] };
  }
};
const writeState = (state) => writeJson(statePath, state);
const fail = (code, message, exitCode = 1) => {
  process.stderr.write(
    `${JSON.stringify({ schemaVersion: "tiangong.cli.error.v1", code, message })}\n`,
  );
  process.exit(exitCode);
};

appendFileSync(invocationPath, `${JSON.stringify({ argv })}\n`, "utf8");
if (process.env.FAKE_LCA_CLI_FAIL_ACTION === action) {
  fail(
    process.env.FAKE_LCA_CLI_FAIL_CODE || "not_data_product_manager",
    "Fake manager authorization failed.",
    3,
  );
}

const inputPath = option("--input");
const outputPath = option("--output");
if (!outputPath) fail("fake_output_required", "--output is required", 2);
let outputData;
let state = readState();

if (action === "calculation-bundle") {
  const packageId = option("--package-id");
  if (
    !process.env.FAKE_CALCULATION_PACKAGE_ID ||
    packageId !== process.env.FAKE_CALCULATION_PACKAGE_ID
  ) {
    fail("package_not_found", "Fake calculation package was not found.", 2);
  }
  const bundleDirectory = process.env.FAKE_CALCULATION_BUNDLE_DIRECTORY;
  const manifestPath = path.join(bundleDirectory, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  outputData = {
    packageId,
    calculationBundle: {
      schemaVersion: manifest.schemaVersion,
      calculationId: manifest.calculationId,
      bundleContentHash: manifest.bundleContentHash,
      manifest,
      manifestDownload: {
        sha256: sha256(manifestBytes),
        byteSize: manifestBytes.byteLength,
        mediaType: "application/json",
        signedDownloadUrl: `data:application/json;base64,${manifestBytes.toString("base64")}`,
      },
      artifacts: manifest.artifacts.map((artifact) => ({
        ...artifact,
        signedDownloadUrl: `https://download.invalid/${artifact.path}`,
      })),
    },
  };
} else if (action === "calculation-artifact") {
  const packageId = option("--package-id");
  if (
    !process.env.FAKE_CALCULATION_PACKAGE_ID ||
    packageId !== process.env.FAKE_CALCULATION_PACKAGE_ID
  ) {
    fail("package_not_found", "Fake calculation package was not found.", 2);
  }
  const bundleDirectory = process.env.FAKE_CALCULATION_BUNDLE_DIRECTORY;
  const artifactPath = option("--artifact-path");
  const manifest = readJson(path.join(bundleDirectory, "manifest.json"));
  const artifact = manifest.artifacts.find(
    (candidate) => candidate.path === artifactPath,
  );
  if (!artifact) {
    fail("calculation_artifact_not_found", "Fake artifact was not found.", 2);
  }
  const bytes = readFileSync(path.join(bundleDirectory, artifact.path));
  if (
    bytes.byteLength !== artifact.byteSize ||
    sha256(bytes) !== artifact.sha256
  ) {
    fail("calculation_artifact_drift", "Fake artifact integrity drifted.");
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, { mode: 0o600 });
} else if (action === "prepare") {
  const input = readJson(inputPath);
  state = {
    ...state,
    ...input,
    status: "prepared",
    artifacts: state.artifacts || [],
  };
  writeState(state);
  outputData = {
    releaseRunId: input.releaseRunId,
    releaseVersion: input.releaseVersion,
    status: "prepared",
    publishPlanHash: input.publishPlanHash,
  };
} else if (action === "upload") {
  const input = readJson(inputPath);
  mkdirSync(remoteDirectory, { recursive: true });
  const artifacts = input.artifacts.map((artifact, index) => {
    const sourcePath = path.resolve(path.dirname(inputPath), artifact.path);
    const artifactId = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const remotePath = path.join(remoteDirectory, `${artifactId}.zip`);
    copyFileSync(sourcePath, remotePath);
    return {
      artifactId,
      profileId: artifact.profileId,
      format: artifact.format,
      storageBucket: "lca_results",
      objectKey: `lca-releases/v1/${input.releaseRunId}/${input.publishPlanHash}/${artifact.profileId}/${artifact.format}/${artifact.sha256}.zip`,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
      mediaType: artifact.mediaType,
      remotePath,
      pinned: false,
    };
  });
  state = { ...state, artifacts };
  writeState(state);
  outputData = {
    schemaVersion: "tiangong.release-upload-receipt.v1",
    releaseRunId: input.releaseRunId,
    publishPlanHash: input.publishPlanHash,
    artifacts: artifacts.map(
      ({
        artifactId: _artifactId,
        remotePath: _remotePath,
        pinned: _pinned,
        ...artifact
      }) => artifact,
    ),
  };
} else if (action === "finalize") {
  const input = readJson(inputPath);
  state = {
    ...state,
    releaseManifestHash: input.releaseManifestHash,
    artifactSetHash: input.releaseManifest.artifactSetHash,
    status: "ready_for_approval",
  };
  writeState(state);
  outputData = {
    releaseRunId: input.releaseRunId,
    status: "ready_for_approval",
    releaseManifestHash: input.releaseManifestHash,
    artifactCount: 4,
    datasetCount: input.releaseManifest.datasets.length,
  };
} else if (action === "approve") {
  const input = readJson(inputPath);
  state = {
    ...state,
    approvalId: "20000000-0000-4000-8000-000000000001",
    approvalHash: "a".repeat(64),
    status: "approved",
  };
  writeState(state);
  outputData = {
    approvalId: state.approvalId,
    approvalHash: state.approvalHash,
    publishPlanHash: input.publishPlanHash,
    approvedBy: "30000000-0000-4000-8000-000000000001",
    approvedAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-17T00:00:00.000Z",
  };
} else if (action === "publish") {
  const input = readJson(inputPath);
  if (
    input.approvalId !== state.approvalId ||
    input.approvalHash !== state.approvalHash ||
    input.publishPlanHash !== state.publishPlanHash
  ) {
    fail("approval_invalid", "Fake approval did not bind the prepared plan.");
  }
  state = {
    ...state,
    publicationId: "40000000-0000-4000-8000-000000000001",
    status: "published",
    artifacts: state.artifacts.map((artifact) => ({
      ...artifact,
      pinned: true,
    })),
  };
  writeState(state);
  outputData = {
    publicationId: state.publicationId,
    releaseRunId: state.releaseRunId,
    releaseVersion: state.releaseVersion,
    status: "current",
    publishedAt: "2026-07-16T01:00:00.000Z",
  };
} else if (action === "status") {
  outputData = {
    releaseRunId: state.releaseRunId,
    releaseVersion: state.releaseVersion,
    status: state.status,
    selectionManifestHash: state.selectionManifestHash,
    calculationBundleHash: state.calculationBundleHash,
    publishPlanHash: state.publishPlanHash,
    releaseManifestHash: state.releaseManifestHash,
    artifactSetHash: state.artifactSetHash,
    artifacts: state.artifacts.map(
      ({ remotePath: _remotePath, ...artifact }) => artifact,
    ),
  };
} else if (action === "artifact-download") {
  const artifact = state.artifacts.find(
    (candidate) => candidate.artifactId === option("--artifact-id"),
  );
  if (!artifact) fail("release_artifact_not_found", "Fake artifact not found.");
  const bytes = readFileSync(artifact.remotePath);
  if (bytes.byteLength !== artifact.byteSize) {
    fail("LCA_RELEASE_DOWNLOAD_SIZE_MISMATCH", "Fake artifact size drifted.");
  }
  if (sha256(bytes) !== artifact.sha256) {
    fail("LCA_RELEASE_DOWNLOAD_HASH_MISMATCH", "Fake artifact hash drifted.");
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, { mode: 0o600 });
} else if (action === "readback-verify") {
  const input = readJson(inputPath);
  const expected = new Map(
    state.artifacts.map((artifact) => [artifact.artifactId, artifact.sha256]),
  );
  if (
    input.releaseManifestHash !== state.releaseManifestHash ||
    input.artifactHashes.length !== 4 ||
    input.artifactHashes.some(
      (artifact) => expected.get(artifact.artifactId) !== artifact.sha256,
    )
  ) {
    fail("readback_artifact_hash_mismatch", "Fake readback mismatch.");
  }
  state = { ...state, status: "readback_verified" };
  writeState(state);
  outputData = {
    releaseRunId: state.releaseRunId,
    status: "readback_verified",
    releaseManifestHash: state.releaseManifestHash,
    verifiedAt: "2026-07-16T02:00:00.000Z",
  };
} else {
  fail("fake_action_unknown", `Unknown fake action: ${action}`, 2);
}

if (action !== "artifact-download" && action !== "calculation-artifact") {
  writeJson(outputPath, outputData);
}
const bytes = readFileSync(outputPath);
const report = {
  schemaVersion: "tiangong.cli.lca-release.v1",
  action,
  status: "completed",
  complete: true,
  summary: { releaseRunId: state.releaseRunId || null },
  output: {
    path: path.resolve(outputPath),
    sha256: sha256(bytes),
    byteSize: statSync(outputPath).size,
    mediaType:
      action === "artifact-download"
        ? "application/zip"
        : action === "calculation-artifact"
          ? "application/octet-stream"
          : "application/json",
  },
  warnings: [],
  nextCommands: [],
};
process.stdout.write(`${JSON.stringify(report)}\n`);
