import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readApprovalDecision } from "../approval/decision.js";
import { calculateBundleContentHash } from "../bundle/manifest.js";
import type { CalculationBundleManifest } from "../bundle/types.js";
import { canonicalSha256, canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import {
  ensureDirectory,
  readJsonFile,
  relativeContainedPath,
  resolveContainedPath,
  sha256File,
  writeJsonAtomic,
} from "../io/files.js";
import type { StageArtifact, StageRecord } from "../stages/types.js";
import { runJsonCommand, tiangongCliExecutable } from "../tools/external.js";
import { assertRemoteTargetFrontier } from "../target/frontier.js";
import { targetPlanReference } from "../target/profile.js";
import { releaseWorkspaceLayout } from "../workspace/layout.js";
import { readReleaseRun, type ReleaseRequest } from "../workspace/run-store.js";

type JsonRecord = Record<string, unknown>;

export type RemoteStageResult = {
  summary: string;
  inputHashes?: Record<string, string>;
  outputHashes?: Record<string, string>;
  artifacts?: StageArtifact[];
  warnings?: StageRecord["warnings"];
  blockers?: StageRecord["blockers"];
  decisions?: string[];
  nextCommands?: string[];
  status?: "passed" | "blocked";
};

type BundleLock = {
  schemaVersion: "tiangong.release.calculation-bundle-lock.v1";
  manifestPath: string;
  manifestSha256: string;
  bundleContentHash: string;
  artifactCount: number;
};

type ReleasePackage = {
  profileId: string;
  format: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  filePath: string;
  requestPath: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELEASE_PAIRS = [
  "unit-process-full-closure.v1:tidas",
  "unit-process-full-closure.v1:ilcd",
  "standalone-lifecyclemodel-result-full-closure.v1:tidas",
  "standalone-lifecyclemodel-result-full-closure.v1:ilcd",
] as const;

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

function assertHash(value: string, code: string): string {
  if (!SHA256_PATTERN.test(value)) throw new Error(code);
  return value;
}

function assertUuid(value: string, code: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
  return value;
}

function normalizedRelativePath(
  fromDirectory: string,
  filePath: string,
): string {
  return relativeContainedPath(fromDirectory, filePath);
}

async function stageArtifact(
  filePath: string,
  mediaType: string,
): Promise<StageArtifact> {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`release_artifact_missing:${filePath}`);
  }
  return { path: filePath, sha256: await sha256File(filePath), mediaType };
}

async function writeJsonArtifact(
  filePath: string,
  value: JsonValue,
): Promise<StageArtifact> {
  writeJsonAtomic(filePath, value);
  return stageArtifact(filePath, "application/json");
}

async function invokeReleaseCli(input: {
  layout: ReturnType<typeof releaseWorkspaceLayout>;
  action: string;
  args: string[];
  outputPath: string;
  mediaType: string;
}): Promise<{ report: JsonRecord; output: StageArtifact }> {
  const result = await runJsonCommand({
    executable: tiangongCliExecutable(),
    args: [
      "release",
      input.action,
      ...input.args,
      "--output",
      input.outputPath,
      "--force",
      "--json",
    ],
    cwd: input.layout.root,
  });
  const report = record(result, "release_cli_report_invalid");
  if (
    report.schemaVersion !== "tiangong.cli.lca-release.v1" ||
    report.action !== input.action ||
    report.status !== "completed" ||
    report.complete !== true
  ) {
    throw new Error(`release_cli_report_contract_invalid:${input.action}`);
  }
  const outputRecord = record(report.output, "release_cli_output_ref_missing");
  const outputPath = stringField(
    outputRecord,
    "path",
    "release_cli_output_path_missing",
  );
  if (realpathSync(outputPath) !== realpathSync(input.outputPath)) {
    throw new Error("release_cli_output_path_mismatch");
  }
  const output = await stageArtifact(input.outputPath, input.mediaType);
  if (
    stringField(outputRecord, "sha256", "release_cli_output_hash_missing") !==
      output.sha256 ||
    integerField(
      outputRecord,
      "byteSize",
      "release_cli_output_size_invalid",
    ) !== statSync(input.outputPath).size
  ) {
    throw new Error("release_cli_output_integrity_mismatch");
  }
  return { report, output };
}

async function assertReleasePlan(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<{
  request: ReleaseRequest;
  plan: JsonRecord;
  manifest: JsonRecord;
  lock: BundleLock;
  bundle: CalculationBundleManifest;
}> {
  const request = readJsonFile<ReleaseRequest>(layout.request);
  const plan = record(
    readJsonFile<unknown>(layout.publishPlan),
    "publish_plan_invalid",
  );
  const manifest = record(
    readJsonFile<unknown>(layout.releaseManifest),
    "release_manifest_invalid",
  );
  const lock = readJsonFile<BundleLock>(
    path.join(layout.outputs, "calculation-bundle-lock.json"),
  );
  const bundle = readJsonFile<CalculationBundleManifest>(lock.manifestPath);
  const run = readReleaseRun(layout.root);
  const planHash = assertHash(
    stringField(plan, "planHash", "publish_plan_hash_missing"),
    "publish_plan_hash_invalid",
  );
  const planInput = {
    schemaVersion: "tiangong.release.publish-plan-input.v1",
    releaseRunId: plan.releaseRunId,
    releaseVersion: plan.releaseVersion,
    profileLockHash: plan.profileLockHash,
    calculationBundleHash: plan.calculationBundleHash,
    artifactSetHash: plan.artifactSetHash,
    ...(plan.target === undefined ? {} : { target: plan.target }),
    datasets: plan.datasets,
    packages: plan.packages,
  } as unknown as JsonValue;
  const manifestPackages = Array.isArray(manifest.packages)
    ? manifest.packages.map((value) => {
        const item = record(value, "release_manifest_package_invalid");
        const artifact = record(
          item.artifact,
          "release_manifest_package_artifact_invalid",
        );
        return {
          profileId: item.profileId,
          format: item.format,
          sha256: artifact.sha256,
        };
      })
    : null;
  const manifestDatasets = Array.isArray(manifest.datasets)
    ? manifest.datasets.map((value) => {
        const item = record(value, "release_manifest_dataset_invalid");
        const sourceProcess =
          item.sourceProcess === undefined
            ? undefined
            : record(
                item.sourceProcess,
                "release_manifest_dataset_source_process_invalid",
              );
        return {
          datasetType: item.datasetType,
          role: item.role,
          uuid: item.uuid,
          version: item.version,
          ...(sourceProcess
            ? {
                sourceProcess: {
                  id: sourceProcess.id,
                  version: sourceProcess.version,
                },
              }
            : {}),
          canonicalContentHash: item.canonicalContentHash,
        };
      })
    : null;
  const releaseManifestRef = record(
    plan.releaseManifest,
    "publish_plan_release_manifest_ref_invalid",
  );
  const manifestCalculation = record(
    manifest.calculationBundle,
    "release_manifest_calculation_bundle_invalid",
  );
  const manifestScope = record(
    manifest.scope,
    "release_manifest_scope_invalid",
  );
  const expectedTarget = request.target
    ? targetPlanReference(request.target)
    : null;
  const planTarget = plan.target ?? null;
  const manifestTarget = manifest.target ?? null;
  assertHash(
    stringField(
      manifest,
      "artifactSetHash",
      "release_artifact_set_hash_missing",
    ),
    "release_artifact_set_hash_invalid",
  );
  const actualManifestSha256 = await sha256File(lock.manifestPath);
  const actualReleaseManifestSha256 = await sha256File(layout.releaseManifest);
  const releaseManifestRefPath = resolveContainedPath(
    layout.root,
    stringField(
      releaseManifestRef,
      "path",
      "publish_plan_release_manifest_path_missing",
    ),
  );
  if (
    canonicalSha256(planInput) !== planHash ||
    canonicalSha256(readJsonFile<JsonValue>(layout.profileLock)) !==
      run.profileLockHash ||
    actualManifestSha256 !== lock.manifestSha256 ||
    calculateBundleContentHash(bundle) !== lock.bundleContentHash ||
    bundle.bundleContentHash !== lock.bundleContentHash ||
    plan.releaseRunId !== request.releaseRunId ||
    manifest.releaseRunId !== request.releaseRunId ||
    manifest.publishPlanHash !== planHash ||
    plan.profileLockHash !== run.profileLockHash ||
    plan.calculationBundleHash !== lock.bundleContentHash ||
    plan.artifactSetHash !== manifest.artifactSetHash ||
    plan.releaseVersion !== manifest.releaseVersion ||
    manifest.profileLockHash !== run.profileLockHash ||
    manifestCalculation.calculationId !== bundle.calculationId ||
    manifestCalculation.bundleContentHash !== lock.bundleContentHash ||
    manifestCalculation.manifestSha256 !== lock.manifestSha256 ||
    manifestScope.coverageMode !== "global_eligible" ||
    manifestScope.processCount !== bundle.scope.processCount ||
    manifestScope.selectionManifestHash !==
      request.scope.selectionManifestHash ||
    releaseManifestRefPath !== realpathSync(layout.releaseManifest) ||
    releaseManifestRef.sha256 !== actualReleaseManifestSha256 ||
    releaseManifestRef.byteSize !== statSync(layout.releaseManifest).size ||
    releaseManifestRef.mediaType !== "application/json" ||
    canonicalize(plan.packages as JsonValue) !==
      canonicalize(manifestPackages as unknown as JsonValue) ||
    canonicalize(plan.datasets as JsonValue) !==
      canonicalize(manifestDatasets as unknown as JsonValue) ||
    canonicalize(planTarget as JsonValue) !==
      canonicalize(expectedTarget as unknown as JsonValue) ||
    canonicalize(manifestTarget as JsonValue) !==
      canonicalize(expectedTarget as unknown as JsonValue) ||
    request.scope.coverageMode !== "global_eligible" ||
    request.scope.coverageMode !== bundle.scope.coverageMode ||
    request.scope.selectionManifestHash !== bundle.scope.selectionManifestHash
  ) {
    throw new Error("release_publish_plan_binding_mismatch");
  }
  return { request, plan, manifest, lock, bundle };
}

async function releasePackages(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  manifest: JsonRecord,
): Promise<ReleasePackage[]> {
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== 4) {
    throw new Error("release_package_cardinality_invalid");
  }
  const packages: ReleasePackage[] = [];
  for (const value of manifest.packages) {
    const item = record(value, "release_package_invalid");
    const artifact = record(item.artifact, "release_package_artifact_invalid");
    const profileId = stringField(
      item,
      "profileId",
      "release_package_profile_missing",
    );
    const format = stringField(
      item,
      "format",
      "release_package_format_missing",
    );
    const pair = `${profileId}:${format}`;
    if (!RELEASE_PAIRS.includes(pair as (typeof RELEASE_PAIRS)[number])) {
      throw new Error(`release_package_pair_invalid:${pair}`);
    }
    const relativePath = stringField(
      artifact,
      "path",
      "release_package_path_missing",
    );
    const filePath = resolveContainedPath(layout.root, relativePath);
    const sha256 = assertHash(
      stringField(artifact, "sha256", "release_package_hash_missing"),
      "release_package_hash_invalid",
    );
    const byteSize = integerField(
      artifact,
      "byteSize",
      "release_package_size_invalid",
    );
    const mediaType = stringField(
      artifact,
      "mediaType",
      "release_package_media_type_missing",
    );
    if (
      mediaType !== "application/zip" ||
      !existsSync(filePath) ||
      statSync(filePath).size !== byteSize ||
      (await sha256File(filePath)) !== sha256
    ) {
      throw new Error(`release_package_integrity_mismatch:${pair}`);
    }
    packages.push({
      profileId,
      format,
      sha256,
      byteSize,
      mediaType,
      filePath,
      requestPath: normalizedRelativePath(
        path.dirname(layout.uploadRequest),
        filePath,
      ),
    });
  }
  const pairs = packages.map((item) => `${item.profileId}:${item.format}`);
  if (
    new Set(pairs).size !== 4 ||
    RELEASE_PAIRS.some((pair) => !pairs.includes(pair))
  ) {
    throw new Error("release_package_set_invalid");
  }
  return packages.sort(
    (left, right) =>
      RELEASE_PAIRS.indexOf(`${left.profileId}:${left.format}` as never) -
      RELEASE_PAIRS.indexOf(`${right.profileId}:${right.format}` as never),
  );
}

function validateUploadReceipt(
  value: unknown,
  releaseRunId: string,
  publishPlanHash: string,
  packages: ReleasePackage[],
): JsonRecord[] {
  const receipt = record(value, "release_upload_receipt_invalid");
  const receiptArtifacts = receipt.artifacts;
  if (
    receipt.schemaVersion !== "tiangong.release-upload-receipt.v1" ||
    receipt.releaseRunId !== releaseRunId ||
    receipt.publishPlanHash !== publishPlanHash ||
    !Array.isArray(receiptArtifacts) ||
    receiptArtifacts.length !== 4
  ) {
    throw new Error("release_upload_receipt_binding_mismatch");
  }
  return packages.map((expected) => {
    const match = receiptArtifacts.find((candidate: unknown) => {
      const item =
        candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? (candidate as JsonRecord)
          : null;
      return (
        item?.profileId === expected.profileId &&
        item?.format === expected.format
      );
    });
    const artifact = record(match, "release_upload_receipt_artifact_missing");
    if (
      artifact.sha256 !== expected.sha256 ||
      artifact.byteSize !== expected.byteSize ||
      artifact.mediaType !== expected.mediaType
    ) {
      throw new Error("release_upload_receipt_artifact_mismatch");
    }
    stringField(artifact, "storageBucket", "release_upload_bucket_missing");
    stringField(artifact, "objectKey", "release_upload_object_key_missing");
    return artifact;
  });
}

function nextStageCommand(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  stage: string,
) {
  return [
    `tiangong-release run-stage --run-dir ${layout.root} --stage ${stage}`,
  ];
}

export async function approvalStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<RemoteStageResult> {
  assertRemoteTargetFrontier({
    runDirectory: layout.root,
    requireApproval: true,
  });
  const decision = readApprovalDecision(layout.root);
  const { request, plan, manifest, lock, bundle } =
    await assertReleasePlan(layout);
  const publishPlanHash = stringField(
    plan,
    "planHash",
    "publish_plan_hash_missing",
  );
  const releaseVersion = stringField(
    plan,
    "releaseVersion",
    "release_version_missing",
  );
  const packages = await releasePackages(layout, manifest);
  const artifacts: StageArtifact[] = [
    await stageArtifact(layout.approvalDecision, "application/json"),
  ];

  const prepareRequest = {
    releaseRunId: request.releaseRunId,
    releaseVersion,
    selectionManifestHash: request.scope.selectionManifestHash,
    inputManifestHash: lock.manifestSha256,
    calculationBundleRef: {
      schemaVersion: "tiangong.release.calculation-bundle-ref.v1",
      calculationId: bundle.calculationId,
      calculationContractVersion: bundle.calculationContractVersion,
      manifestSha256: lock.manifestSha256,
      bundleContentHash: lock.bundleContentHash,
      artifactCount: lock.artifactCount,
      snapshotId: bundle.snapshot.id,
      snapshotSha256: bundle.snapshot.sha256,
    },
    calculationBundleHash: lock.bundleContentHash,
    profileLockHash: readReleaseRun(layout.root).profileLockHash,
    publishPlan: plan,
    publishPlanHash,
    idempotencyKey: `release-prepare:${request.releaseRunId}:${publishPlanHash}`,
  } as unknown as JsonValue;
  artifacts.push(
    await writeJsonArtifact(layout.prepareRequest, prepareRequest),
  );
  const prepared = await invokeReleaseCli({
    layout,
    action: "prepare",
    args: ["--input", layout.prepareRequest],
    outputPath: layout.prepareReceipt,
    mediaType: "application/json",
  });
  artifacts.push(prepared.output);
  const prepareReceipt = readJsonFile<JsonRecord>(layout.prepareReceipt);
  if (
    prepareReceipt.releaseRunId !== request.releaseRunId ||
    prepareReceipt.releaseVersion !== releaseVersion ||
    prepareReceipt.publishPlanHash !== publishPlanHash ||
    prepareReceipt.status !== "prepared"
  ) {
    throw new Error("release_prepare_receipt_mismatch");
  }

  const uploadRequest = {
    releaseRunId: request.releaseRunId,
    publishPlanHash,
    artifacts: packages.map((item) => ({
      profileId: item.profileId,
      format: item.format,
      path: item.requestPath,
      sha256: item.sha256,
      byteSize: item.byteSize,
      mediaType: item.mediaType,
    })),
  } as unknown as JsonValue;
  artifacts.push(await writeJsonArtifact(layout.uploadRequest, uploadRequest));
  const uploaded = await invokeReleaseCli({
    layout,
    action: "upload",
    args: ["--input", layout.uploadRequest],
    outputPath: layout.uploadReceipt,
    mediaType: "application/json",
  });
  artifacts.push(uploaded.output);
  const uploadedArtifacts = validateUploadReceipt(
    readJsonFile<unknown>(layout.uploadReceipt),
    request.releaseRunId,
    publishPlanHash,
    packages,
  );

  const releaseManifestHash = await sha256File(layout.releaseManifest);
  const finalizeRequest = {
    releaseRunId: request.releaseRunId,
    publishPlanHash,
    releaseManifest: manifest,
    releaseManifestHash,
    artifacts: uploadedArtifacts,
  } as unknown as JsonValue;
  artifacts.push(
    await writeJsonArtifact(layout.finalizeRequest, finalizeRequest),
  );
  const finalized = await invokeReleaseCli({
    layout,
    action: "finalize",
    args: ["--input", layout.finalizeRequest],
    outputPath: layout.finalizeReceipt,
    mediaType: "application/json",
  });
  artifacts.push(finalized.output);
  const finalizeReceipt = readJsonFile<JsonRecord>(layout.finalizeReceipt);
  if (
    finalizeReceipt.releaseRunId !== request.releaseRunId ||
    finalizeReceipt.releaseManifestHash !== releaseManifestHash ||
    finalizeReceipt.status !== "ready_for_approval" ||
    finalizeReceipt.artifactCount !== 4
  ) {
    throw new Error("release_finalize_receipt_mismatch");
  }

  const approvalRequest = {
    releaseRunId: request.releaseRunId,
    publishPlanHash,
    ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
    ...(decision.reason ? { reason: decision.reason } : {}),
  } as unknown as JsonValue;
  artifacts.push(
    await writeJsonArtifact(layout.approvalRequest, approvalRequest),
  );
  const approved = await invokeReleaseCli({
    layout,
    action: "approve",
    args: ["--input", layout.approvalRequest],
    outputPath: layout.approvalReceipt,
    mediaType: "application/json",
  });
  artifacts.push(approved.output);
  const approvalReceipt = readJsonFile<JsonRecord>(layout.approvalReceipt);
  assertUuid(
    stringField(approvalReceipt, "approvalId", "release_approval_id_missing"),
    "release_approval_id_invalid",
  );
  assertHash(
    stringField(
      approvalReceipt,
      "approvalHash",
      "release_approval_hash_missing",
    ),
    "release_approval_hash_invalid",
  );
  if (approvalReceipt.publishPlanHash !== publishPlanHash) {
    throw new Error("release_approval_receipt_mismatch");
  }

  return {
    summary: `Prepared, uploaded, finalized, and approved exact publish plan ${publishPlanHash}.`,
    inputHashes: {
      publishPlan: await sha256File(layout.publishPlan),
      releaseManifest: releaseManifestHash,
      approvalDecision: await sha256File(layout.approvalDecision),
    },
    outputHashes: {
      prepareReceipt: await sha256File(layout.prepareReceipt),
      uploadReceipt: await sha256File(layout.uploadReceipt),
      finalizeReceipt: await sha256File(layout.finalizeReceipt),
      approvalReceipt: await sha256File(layout.approvalReceipt),
    },
    artifacts,
    decisions: [layout.approvalDecision],
    nextCommands: nextStageCommand(layout, "publish"),
  };
}

export async function publishStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<RemoteStageResult> {
  assertRemoteTargetFrontier({
    runDirectory: layout.root,
    requireApproval: true,
  });
  readApprovalDecision(layout.root);
  const { request, plan } = await assertReleasePlan(layout);
  const publishPlanHash = stringField(
    plan,
    "planHash",
    "publish_plan_hash_missing",
  );
  const releaseVersion = stringField(
    plan,
    "releaseVersion",
    "release_version_missing",
  );
  const approval = record(
    readJsonFile<unknown>(layout.approvalReceipt),
    "release_approval_receipt_invalid",
  );
  const approvalId = assertUuid(
    stringField(approval, "approvalId", "release_approval_id_missing"),
    "release_approval_id_invalid",
  );
  const approvalHash = assertHash(
    stringField(approval, "approvalHash", "release_approval_hash_missing"),
    "release_approval_hash_invalid",
  );
  if (approval.publishPlanHash !== publishPlanHash) {
    throw new Error("release_approval_receipt_mismatch");
  }
  const publicationRequest = {
    releaseRunId: request.releaseRunId,
    approvalId,
    approvalHash,
    publishPlanHash,
    idempotencyKey: `release-publish:${request.releaseRunId}:${publishPlanHash}`,
    reason: "Publish the exact locally approved LCI/LCIA release plan.",
  } as unknown as JsonValue;
  const requestArtifact = await writeJsonArtifact(
    layout.publicationRequest,
    publicationRequest,
  );
  const published = await invokeReleaseCli({
    layout,
    action: "publish",
    args: ["--input", layout.publicationRequest],
    outputPath: layout.publicationReceipt,
    mediaType: "application/json",
  });
  const receipt = readJsonFile<JsonRecord>(layout.publicationReceipt);
  assertUuid(
    stringField(receipt, "publicationId", "release_publication_id_missing"),
    "release_publication_id_invalid",
  );
  if (
    receipt.releaseRunId !== request.releaseRunId ||
    receipt.releaseVersion !== releaseVersion ||
    receipt.status !== "current"
  ) {
    throw new Error("release_publication_receipt_mismatch");
  }
  return {
    summary: `Published release ${releaseVersion} from approval ${approvalId}.`,
    inputHashes: {
      publishPlan: await sha256File(layout.publishPlan),
      approvalReceipt: await sha256File(layout.approvalReceipt),
    },
    outputHashes: {
      publicationReceipt: await sha256File(layout.publicationReceipt),
    },
    artifacts: [requestArtifact, published.output],
    nextCommands: nextStageCommand(layout, "readback-verify"),
  };
}

function readbackArtifactMetadata(value: unknown): JsonRecord[] {
  const status = record(value, "release_readback_status_invalid");
  if (!Array.isArray(status.artifacts) || status.artifacts.length !== 4) {
    throw new Error("release_readback_artifacts_incomplete");
  }
  const artifacts = status.artifacts.map((item) => {
    const artifact = record(item, "release_readback_artifact_invalid");
    assertUuid(
      stringField(
        artifact,
        "artifactId",
        "release_readback_artifact_id_missing",
      ),
      "release_readback_artifact_id_invalid",
    );
    assertHash(
      stringField(artifact, "sha256", "release_readback_artifact_hash_missing"),
      "release_readback_artifact_hash_invalid",
    );
    integerField(
      artifact,
      "byteSize",
      "release_readback_artifact_size_invalid",
    );
    if (artifact.mediaType !== "application/zip") {
      throw new Error("release_readback_artifact_media_type_invalid");
    }
    const pair = `${stringField(artifact, "profileId", "release_readback_profile_missing")}:${stringField(artifact, "format", "release_readback_format_missing")}`;
    if (!RELEASE_PAIRS.includes(pair as (typeof RELEASE_PAIRS)[number])) {
      throw new Error(`release_readback_pair_invalid:${pair}`);
    }
    return artifact;
  });
  const pairs = artifacts.map(
    (item) => `${String(item.profileId)}:${String(item.format)}`,
  );
  if (new Set(pairs).size !== 4)
    throw new Error("release_readback_pair_duplicate");
  return artifacts.sort(
    (left, right) =>
      RELEASE_PAIRS.indexOf(
        `${String(left.profileId)}:${String(left.format)}` as never,
      ) -
      RELEASE_PAIRS.indexOf(
        `${String(right.profileId)}:${String(right.format)}` as never,
      ),
  );
}

function assertReadbackStatus(
  value: unknown,
  expected: {
    releaseRunId: string;
    releaseVersion: string;
    publishPlanHash: string;
    releaseManifestHash: string;
    artifactSetHash: string;
    selectionManifestHash: string;
    calculationBundleHash: string;
  },
  allowedStatuses: string[],
): JsonRecord {
  const status = record(value, "release_readback_status_invalid");
  if (
    status.releaseRunId !== expected.releaseRunId ||
    status.releaseVersion !== expected.releaseVersion ||
    status.publishPlanHash !== expected.publishPlanHash ||
    status.releaseManifestHash !== expected.releaseManifestHash ||
    status.artifactSetHash !== expected.artifactSetHash ||
    status.selectionManifestHash !== expected.selectionManifestHash ||
    status.calculationBundleHash !== expected.calculationBundleHash ||
    typeof status.status !== "string" ||
    !allowedStatuses.includes(status.status)
  ) {
    throw new Error("release_readback_status_binding_mismatch");
  }
  return status;
}

export async function readbackVerifyStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<RemoteStageResult> {
  assertRemoteTargetFrontier({
    runDirectory: layout.root,
    requireApproval: true,
  });
  const { request, plan, manifest, lock } = await assertReleasePlan(layout);
  const publishPlanHash = stringField(
    plan,
    "planHash",
    "publish_plan_hash_missing",
  );
  const releaseManifestHash = await sha256File(layout.releaseManifest);
  const expected = {
    releaseRunId: request.releaseRunId,
    releaseVersion: stringField(
      plan,
      "releaseVersion",
      "release_version_missing",
    ),
    publishPlanHash,
    releaseManifestHash,
    artifactSetHash: stringField(
      manifest,
      "artifactSetHash",
      "release_artifact_set_hash_missing",
    ),
    selectionManifestHash: request.scope.selectionManifestHash,
    calculationBundleHash: lock.bundleContentHash,
  };
  const before = await invokeReleaseCli({
    layout,
    action: "status",
    args: ["--release-run-id", request.releaseRunId],
    outputPath: layout.readbackStatusBefore,
    mediaType: "application/json",
  });
  const beforeStatus = assertReadbackStatus(
    readJsonFile<unknown>(layout.readbackStatusBefore),
    expected,
    ["published", "readback_verified"],
  );
  const remoteArtifacts = readbackArtifactMetadata(beforeStatus);
  ensureDirectory(layout.readbackArtifacts);
  const artifacts: StageArtifact[] = [before.output];
  const observed: Array<Record<string, unknown>> = [];
  for (const remote of remoteArtifacts) {
    const profileId = String(remote.profileId);
    const format = String(remote.format);
    const outputPath = path.join(
      layout.readbackArtifacts,
      `${profileId}.${format}.zip`,
    );
    const downloaded = await invokeReleaseCli({
      layout,
      action: "artifact-download",
      args: ["--artifact-id", String(remote.artifactId)],
      outputPath,
      mediaType: "application/zip",
    });
    if (
      downloaded.output.sha256 !== remote.sha256 ||
      statSync(outputPath).size !== remote.byteSize
    ) {
      throw new Error(
        `release_independent_readback_mismatch:${profileId}:${format}`,
      );
    }
    artifacts.push(downloaded.output);
    observed.push({
      artifactId: remote.artifactId,
      profileId,
      format,
      sha256: downloaded.output.sha256,
      byteSize: statSync(outputPath).size,
      path: normalizedRelativePath(layout.root, outputPath),
    });
  }
  const report = {
    schemaVersion: "tiangong.release.independent-readback-report.v1",
    releaseRunId: request.releaseRunId,
    publishPlanHash,
    releaseManifestHash,
    status: "passed",
    artifacts: observed,
  } as unknown as JsonValue;
  artifacts.push(await writeJsonArtifact(layout.readbackReport, report));

  const readbackRequest = {
    releaseRunId: request.releaseRunId,
    releaseManifestHash,
    artifactHashes: observed.map((item) => ({
      artifactId: item.artifactId,
      sha256: item.sha256,
    })),
  } as unknown as JsonValue;
  artifacts.push(
    await writeJsonArtifact(layout.readbackRequest, readbackRequest),
  );
  const verified = await invokeReleaseCli({
    layout,
    action: "readback-verify",
    args: ["--input", layout.readbackRequest],
    outputPath: layout.readbackReceipt,
    mediaType: "application/json",
  });
  artifacts.push(verified.output);
  const receipt = readJsonFile<JsonRecord>(layout.readbackReceipt);
  if (
    receipt.releaseRunId !== request.releaseRunId ||
    receipt.releaseManifestHash !== releaseManifestHash ||
    receipt.status !== "readback_verified"
  ) {
    throw new Error("release_readback_receipt_mismatch");
  }
  const after = await invokeReleaseCli({
    layout,
    action: "status",
    args: ["--release-run-id", request.releaseRunId],
    outputPath: layout.readbackStatusAfter,
    mediaType: "application/json",
  });
  artifacts.push(after.output);
  const afterStatus = assertReadbackStatus(
    readJsonFile<unknown>(layout.readbackStatusAfter),
    expected,
    ["readback_verified"],
  );
  const afterArtifacts = readbackArtifactMetadata(afterStatus);
  for (const item of afterArtifacts) {
    const match = observed.find(
      (candidate) => candidate.artifactId === item.artifactId,
    );
    if (
      !match ||
      match.sha256 !== item.sha256 ||
      match.byteSize !== item.byteSize
    ) {
      throw new Error("release_post_readback_artifact_drift");
    }
  }
  return {
    summary: `Independently downloaded and hash-verified all four release artifacts for ${request.releaseRunId}.`,
    inputHashes: {
      publicationReceipt: await sha256File(layout.publicationReceipt),
      releaseManifest: releaseManifestHash,
    },
    outputHashes: {
      readbackReport: await sha256File(layout.readbackReport),
      readbackReceipt: await sha256File(layout.readbackReceipt),
      readbackStatus: await sha256File(layout.readbackStatusAfter),
    },
    artifacts,
    nextCommands: [],
  };
}
