import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertCalculationBundleManifest,
  calculateBundleContentHash,
} from "../bundle/manifest.js";
import { readNdjsonFile } from "../bundle/ndjson.js";
import type {
  CalculationBundleArtifact,
  CalculationBundleManifest,
} from "../bundle/types.js";
import { verifyBundleArtifacts } from "../bundle/verify.js";
import { canonicalSha256, canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import {
  normalizeUuid,
  NS_TG_RELEASE_ROOT_V1,
  uuidV5,
} from "../identity/uuid.js";
import {
  ensureDirectory,
  readJsonFile,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic,
} from "../io/files.js";
import {
  assertSourceClosureManifest,
  type SourceClosureEntry,
  type SourceClosureManifest,
  type SourceDatasetType,
} from "../source/closure.js";
import {
  resolveConfiguredReleaseTarget,
  targetPlanReference,
} from "../target/profile.js";
import {
  ExternalCommandError,
  runJsonCommand,
  tiangongCliExecutable,
} from "../tools/external.js";
import {
  assertReleaseRequest,
  initializeReleaseWorkspace,
  readReleaseRun,
  type ReleaseRequest,
} from "../workspace/run-store.js";

type JsonRecord = Record<string, unknown>;

export type BootstrapReport = {
  schemaVersion: "tiangong.release-bootstrap-report.v1";
  status: "completed";
  complete: true;
  truncated: false;
  packageId: string;
  target: { targetId: string; targetFingerprint: string };
  calculationBundle: {
    calculationId: string;
    bundleContentHash: string;
    manifestPath: string;
    manifestSha256: string;
    artifactCount: number;
  };
  sourceClosure: {
    directory: string;
    manifestHash: string;
    datasetCount: number;
  };
  releaseRunId: string;
  runDirectory: string;
  reused: boolean;
  artifactPaths: string[];
  warnings: Array<{ code: string; message: string }>;
  nextCommands: string[];
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{3}$/u;
const SOURCE_DATASET_TYPES = new Set<SourceDatasetType>([
  "process",
  "lifecyclemodel",
  "flow",
  "flowproperty",
  "unitgroup",
  "lciamethod",
  "source",
  "contact",
]);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as JsonRecord;
}

function stringField(source: JsonRecord, field: string, code: string): string {
  const value = source[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

function integerField(source: JsonRecord, field: string, code: string): number {
  const value = source[field];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function specPath(name: string): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "specs",
    name,
  );
}

function containedOutputPath(
  rootDirectory: string,
  relativePath: string,
): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(`calculation_bundle_artifact_path_invalid:${relativePath}`);
  }
  const root = path.resolve(rootDirectory);
  const output = path.resolve(root, relativePath);
  if (!output.startsWith(`${root}${path.sep}`)) {
    throw new Error(`calculation_bundle_artifact_path_invalid:${relativePath}`);
  }
  ensureDirectory(root);
  ensureDirectory(path.dirname(output));
  const realRoot = realpathSync(root);
  const realParent = realpathSync(path.dirname(output));
  if (
    realParent !== realRoot &&
    !realParent.startsWith(`${realRoot}${path.sep}`)
  ) {
    throw new Error(`calculation_bundle_artifact_path_invalid:${relativePath}`);
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error(
      `calculation_bundle_artifact_symlink_forbidden:${relativePath}`,
    );
  }
  return path.join(realParent, path.basename(output));
}

function containedDirectory(
  rootDirectory: string,
  relativePath: string,
): string {
  const sentinel = containedOutputPath(
    rootDirectory,
    `${relativePath}/.containment-check`,
  );
  return path.dirname(sentinel);
}

async function invokeCalculationBundleProjection(input: {
  packageId: string;
  outputPath: string;
  cwd: string;
}): Promise<void> {
  const report = record(
    await runJsonCommand({
      executable: tiangongCliExecutable(),
      args: [
        "release",
        "calculation-bundle",
        "--package-id",
        input.packageId,
        "--output",
        input.outputPath,
        "--force",
        "--json",
      ],
      cwd: input.cwd,
    }),
    "calculation_bundle_projection_report_invalid",
  );
  if (
    report.schemaVersion !== "tiangong.cli.lca-release.v1" ||
    report.action !== "calculation-bundle" ||
    report.status !== "completed" ||
    report.complete !== true ||
    !existsSync(input.outputPath)
  ) {
    throw new Error("calculation_bundle_projection_report_invalid");
  }
}

async function downloadManifest(
  metadata: JsonRecord,
  outputPath: string,
): Promise<{ sha256: string; byteSize: number }> {
  const expectedSha256 = stringField(
    metadata,
    "sha256",
    "calculation_bundle_manifest_hash_missing",
  );
  const expectedByteSize = integerField(
    metadata,
    "byteSize",
    "calculation_bundle_manifest_size_invalid",
  );
  const signedDownloadUrl = stringField(
    metadata,
    "signedDownloadUrl",
    "calculation_bundle_manifest_download_missing",
  );
  if (
    !SHA256_PATTERN.test(expectedSha256) ||
    expectedByteSize > MAX_MANIFEST_BYTES
  ) {
    throw new Error("calculation_bundle_manifest_reference_invalid");
  }
  const response = await fetch(signedDownloadUrl, {
    method: "GET",
    headers: { Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `calculation_bundle_manifest_download_failed:${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== expectedByteSize ||
    observedSha256 !== expectedSha256
  ) {
    throw new Error("calculation_bundle_manifest_download_mismatch");
  }
  writeTextAtomic(outputPath, bytes.toString("utf8"));
  if ((await sha256File(outputPath)) !== expectedSha256) {
    throw new Error("calculation_bundle_manifest_persistence_mismatch");
  }
  return { sha256: observedSha256, byteSize: bytes.byteLength };
}

async function downloadBundleArtifact(input: {
  packageId: string;
  artifact: CalculationBundleArtifact;
  outputPath: string;
  cwd: string;
}): Promise<void> {
  if (
    existsSync(input.outputPath) &&
    statSync(input.outputPath).isFile() &&
    statSync(input.outputPath).size === input.artifact.byteSize &&
    (await sha256File(input.outputPath)) === input.artifact.sha256
  ) {
    return;
  }
  ensureDirectory(path.dirname(input.outputPath));
  const report = record(
    await runJsonCommand({
      executable: tiangongCliExecutable(),
      args: [
        "release",
        "calculation-artifact",
        "--package-id",
        input.packageId,
        "--artifact-path",
        input.artifact.path,
        "--output",
        input.outputPath,
        "--force",
        "--json",
      ],
      cwd: input.cwd,
    }),
    "calculation_bundle_artifact_report_invalid",
  );
  if (
    report.schemaVersion !== "tiangong.cli.lca-release.v1" ||
    report.action !== "calculation-artifact" ||
    report.status !== "completed" ||
    report.complete !== true ||
    !existsSync(input.outputPath) ||
    statSync(input.outputPath).size !== input.artifact.byteSize ||
    (await sha256File(input.outputPath)) !== input.artifact.sha256
  ) {
    throw new Error(
      `calculation_bundle_artifact_download_mismatch:${input.artifact.path}`,
    );
  }
}

function sourceRecord(value: unknown): {
  entry: SourceClosureEntry;
  document: JsonValue;
} {
  const item = record(value, "source_closure_record_invalid");
  const datasetType = stringField(
    item,
    "datasetType",
    "source_closure_dataset_type_missing",
  ) as SourceDatasetType;
  const role = stringField(item, "role", "source_closure_role_missing");
  const uuid = normalizeUuid(
    stringField(item, "uuid", "source_closure_uuid_missing"),
  );
  const version = stringField(
    item,
    "version",
    "source_closure_version_missing",
  );
  const relativePath = stringField(item, "path", "source_closure_path_missing");
  const sha256 = stringField(item, "sha256", "source_closure_hash_missing");
  const document = item.document as JsonValue;
  const datasetDirectories: Record<SourceDatasetType, string> = {
    process: "processes",
    lifecyclemodel: "lifecyclemodels",
    flow: "flows",
    flowproperty: "flowproperties",
    unitgroup: "unitgroups",
    lciamethod: "lciamethods",
    source: "sources",
    contact: "contacts",
  };
  const expectedPath = `${datasetDirectories[datasetType]}/${uuid}_${version}.json`;
  const documentUuids: string[] = [];
  const visit = (candidate: JsonValue): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "common:UUID" && typeof nested === "string") {
        documentUuids.push(nested.toLowerCase());
      }
      visit(nested);
    }
  };
  visit(document);
  if (
    item.schemaVersion !== "tiangong.source-closure.dataset.v1" ||
    !SOURCE_DATASET_TYPES.has(datasetType) ||
    (role !== "unit_process" && role !== "support") ||
    !VERSION_PATTERN.test(version) ||
    !SHA256_PATTERN.test(sha256) ||
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    relativePath !== expectedPath ||
    (role === "unit_process" && datasetType !== "process") ||
    documentUuids.length !== 1 ||
    documentUuids[0] !== uuid ||
    canonicalSha256(document) !== sha256
  ) {
    throw new Error(`source_closure_record_contract_invalid:${relativePath}`);
  }
  return {
    entry: {
      datasetType,
      role,
      uuid,
      version,
      path: relativePath,
      sha256,
    },
    document,
  };
}

async function materializeSourceClosure(input: {
  manifest: CalculationBundleManifest;
  bundleDirectory: string;
  outputDirectory: string;
}): Promise<{ manifestHash: string; datasetCount: number }> {
  const artifacts = input.manifest.artifacts.filter(
    (artifact) => artifact.kind === "source_closure" && !artifact.derived,
  );
  if (artifacts.length !== 1) {
    throw new Error("calculation_bundle_source_closure_cardinality_invalid");
  }
  const artifact = artifacts[0]!;
  if (
    artifact.schemaVersion !== "tiangong.source-closure.bundle.v1" ||
    artifact.compression !== "gzip"
  ) {
    throw new Error("calculation_bundle_source_closure_contract_invalid");
  }
  const entries: SourceClosureEntry[] = [];
  const seen = new Set<string>();
  let count = 0;
  for await (const value of readNdjsonFile<unknown>(
    containedOutputPath(input.bundleDirectory, artifact.path),
    "gzip",
  )) {
    const parsed = sourceRecord(value);
    const key = `${parsed.entry.datasetType}:${parsed.entry.uuid}:${parsed.entry.version}`;
    if (seen.has(key))
      throw new Error(`source_closure_dataset_duplicate:${key}`);
    seen.add(key);
    const outputPath = containedOutputPath(
      input.outputDirectory,
      parsed.entry.path,
    );
    writeTextAtomic(outputPath, canonicalize(parsed.document));
    if ((await sha256File(outputPath)) !== parsed.entry.sha256) {
      throw new Error(
        `source_closure_dataset_hash_mismatch:${parsed.entry.path}`,
      );
    }
    entries.push(parsed.entry);
    count += 1;
  }
  if (count !== artifact.recordCount) {
    throw new Error("source_closure_record_count_mismatch");
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = assertSourceClosureManifest({
    schemaVersion: "tiangong.source-closure.v1",
    datasets: entries,
  }) as SourceClosureManifest;
  const manifestPath = path.join(input.outputDirectory, "manifest.json");
  writeJsonAtomic(manifestPath, manifest as unknown as JsonValue);
  return {
    manifestHash: await sha256File(manifestPath),
    datasetCount: entries.length,
  };
}

function deterministicReleaseRunId(input: {
  packageId: string;
  calculationId: string;
  bundleContentHash: string;
  targetFingerprint: string;
  profileLockHash: string;
}): string {
  return uuidV5(
    NS_TG_RELEASE_ROOT_V1,
    `bootstrap:v1:${canonicalize({
      schemaVersion: "tiangong.release-bootstrap-identity.v1",
      ...input,
    } as unknown as JsonValue)}`,
  );
}

function assertReusableWorkspace(input: {
  runDirectory: string;
  request: ReleaseRequest;
  profileLockHash: string;
}): void {
  const existingRequest = assertReleaseRequest(
    readJsonFile<unknown>(
      path.join(input.runDirectory, "release-request.json"),
    ),
  );
  const run = readReleaseRun(input.runDirectory);
  if (
    canonicalize(existingRequest as unknown as JsonValue) !==
      canonicalize(input.request as unknown as JsonValue) ||
    run.requestHash !==
      canonicalSha256(input.request as unknown as JsonValue) ||
    run.profileLockHash !== input.profileLockHash
  ) {
    throw new Error("release_bootstrap_existing_run_conflict");
  }
}

export async function bootstrapReleaseRun(input: {
  packageId: string;
  targetId: string;
  releaseRoot?: string;
  previousReleaseManifestPath?: string | null;
}): Promise<BootstrapReport> {
  const packageId = normalizeUuid(input.packageId);
  const target = resolveConfiguredReleaseTarget({
    targetId: input.targetId,
    requireCredential: true,
  });
  const requestedReleaseRoot = path.resolve(input.releaseRoot ?? ".release");
  ensureDirectory(requestedReleaseRoot);
  const releaseRoot = realpathSync(requestedReleaseRoot);
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "tiangong-release-bootstrap-"),
  );
  const projectionPath = path.join(temporaryDirectory, "projection.json");
  try {
    await invokeCalculationBundleProjection({
      packageId,
      outputPath: projectionPath,
      cwd: temporaryDirectory,
    });
    const projection = record(
      readJsonFile<unknown>(projectionPath),
      "calculation_bundle_projection_invalid",
    );
    if (normalizeUuid(String(projection.packageId ?? "")) !== packageId) {
      throw new Error("calculation_bundle_projection_package_mismatch");
    }
    const bundleProjection = record(
      projection.calculationBundle,
      "calculation_bundle_projection_invalid",
    );
    const projectedBundleHash = stringField(
      bundleProjection,
      "bundleContentHash",
      "calculation_bundle_projection_hash_missing",
    );
    if (!SHA256_PATTERN.test(projectedBundleHash)) {
      throw new Error("calculation_bundle_projection_hash_invalid");
    }
    const bundleDirectory = containedDirectory(
      releaseRoot,
      `intake/${packageId}/${projectedBundleHash}/bundle`,
    );
    const manifestPath = containedOutputPath(bundleDirectory, "manifest.json");
    const manifestDownload = record(
      bundleProjection.manifestDownload,
      "calculation_bundle_manifest_download_missing",
    );
    const downloadedManifest = await downloadManifest(
      manifestDownload,
      manifestPath,
    );
    const manifest = assertCalculationBundleManifest(
      readJsonFile<unknown>(manifestPath),
    );
    if (
      manifest.bundleContentHash !== projectedBundleHash ||
      calculateBundleContentHash(manifest) !== projectedBundleHash
    ) {
      throw new Error("calculation_bundle_content_hash_mismatch");
    }
    if (
      !Array.isArray(bundleProjection.artifacts) ||
      bundleProjection.artifacts.length !== manifest.artifacts.length
    ) {
      throw new Error("calculation_bundle_projection_artifacts_mismatch");
    }
    const projectedArtifacts = new Map(
      bundleProjection.artifacts.map((value) => {
        const item = record(
          value,
          "calculation_bundle_projection_artifact_invalid",
        );
        return [
          stringField(
            item,
            "path",
            "calculation_bundle_projection_artifact_path_missing",
          ),
          item,
        ];
      }),
    );
    for (const artifact of manifest.artifacts) {
      const projected = projectedArtifacts.get(artifact.path);
      if (
        !projected ||
        projected.sha256 !== artifact.sha256 ||
        projected.byteSize !== artifact.byteSize
      ) {
        throw new Error(
          `calculation_bundle_projection_artifact_mismatch:${artifact.path}`,
        );
      }
      await downloadBundleArtifact({
        packageId,
        artifact,
        outputPath: containedOutputPath(bundleDirectory, artifact.path),
        cwd: temporaryDirectory,
      });
    }
    await verifyBundleArtifacts(manifest, bundleDirectory);

    const sourceClosureDirectory = containedDirectory(
      releaseRoot,
      `intake/${packageId}/${projectedBundleHash}/source-closure`,
    );
    const sourceClosure = await materializeSourceClosure({
      manifest,
      bundleDirectory,
      outputDirectory: sourceClosureDirectory,
    });
    const profileLock = readJsonFile<JsonValue>(
      specPath("release-profiles.json"),
    );
    const profileLockHash = canonicalSha256(profileLock);
    const releaseRunId = deterministicReleaseRunId({
      packageId,
      calculationId: normalizeUuid(manifest.calculationId),
      bundleContentHash: projectedBundleHash,
      targetFingerprint: target.targetFingerprint,
      profileLockHash,
    });
    const request: ReleaseRequest = {
      schemaVersion: "tiangong.release-request.v1",
      releaseRunId,
      name: `Calculation package ${packageId}`,
      calculationBundle: {
        manifestPath,
        bundleContentHash: projectedBundleHash,
      },
      scope: {
        coverageMode: manifest.scope.coverageMode,
        selectionManifestHash: manifest.scope.selectionManifestHash,
      },
      profiles: {
        modelProfileId: "resolved-one-hop-aggregated-background.v1",
        resultProfileId: "lci-lcia-result.v1",
        packageProfileIds: [
          "unit-process-full-closure.v1",
          "standalone-lifecyclemodel-result-full-closure.v1",
        ],
      },
      sourceClosure: {
        directory: sourceClosureDirectory,
        manifestHash: sourceClosure.manifestHash,
      },
      target,
      ...(input.previousReleaseManifestPath
        ? {
            previousReleaseManifestPath: path.resolve(
              input.previousReleaseManifestPath,
            ),
          }
        : {}),
    };
    const runDirectory = containedDirectory(
      releaseRoot,
      `workspaces/${releaseRunId}`,
    );
    let reused = false;
    if (existsSync(path.join(runDirectory, "run.json"))) {
      assertReusableWorkspace({ runDirectory, request, profileLockHash });
      reused = true;
    } else {
      initializeReleaseWorkspace({
        request,
        outDirectory: runDirectory,
        profileLock,
      });
    }
    return {
      schemaVersion: "tiangong.release-bootstrap-report.v1",
      status: "completed",
      complete: true,
      truncated: false,
      packageId,
      target: targetPlanReference(target),
      calculationBundle: {
        calculationId: manifest.calculationId,
        bundleContentHash: projectedBundleHash,
        manifestPath,
        manifestSha256: downloadedManifest.sha256,
        artifactCount: manifest.artifacts.length,
      },
      sourceClosure: {
        directory: sourceClosureDirectory,
        manifestHash: sourceClosure.manifestHash,
        datasetCount: sourceClosure.datasetCount,
      },
      releaseRunId,
      runDirectory,
      reused,
      artifactPaths: [manifestPath, sourceClosureDirectory, runDirectory],
      warnings: [],
      nextCommands: [
        `tiangong-release candidate --run-dir ${runDirectory} --json`,
        `tiangong-release package --run-dir ${runDirectory} --json`,
      ],
    };
  } catch (error) {
    if (error instanceof ExternalCommandError) throw error;
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
