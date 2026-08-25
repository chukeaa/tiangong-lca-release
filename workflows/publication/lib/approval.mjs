import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import {
  assertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";

export async function createPublicationApproval({
  inspectionDir,
  outDir,
  confirmPlanSha256,
  approvedBy,
  expiresAt,
  reason = null,
  now = () => new Date(),
}) {
  const inspectionRoot = path.resolve(inspectionDir);
  const artifacts = await loadInspectionArtifacts(inspectionRoot);
  const executablePlanSha256 = hashJson(artifacts.executablePlan);
  if (confirmPlanSha256 !== executablePlanSha256)
    fail(
      "publication_approval_confirmation_mismatch",
      "Approval confirmation must exactly match the executable Publication Plan SHA-256",
      { expected: executablePlanSha256, received: confirmPlanSha256 ?? null },
    );
  const approver = String(approvedBy ?? "").trim();
  if (!approver || approver.length > 256)
    fail(
      "publication_approver_invalid",
      "Approval requires a stable approver identifier of at most 256 characters",
    );
  const approvedAtDate = now();
  const expiresAtDate = expiresAt
    ? new Date(expiresAt)
    : new Date(approvedAtDate.getTime() + 60 * 60 * 1000);
  if (
    Number.isNaN(expiresAtDate.getTime()) ||
    expiresAtDate.getTime() <= approvedAtDate.getTime()
  )
    fail(
      "publication_approval_expiration_invalid",
      "Approval expiration must be a valid future timestamp",
    );
  const normalizedReason = reason === null ? null : String(reason).trim();
  if (
    normalizedReason !== null &&
    (!normalizedReason || normalizedReason.length > 1000)
  )
    fail(
      "publication_approval_reason_invalid",
      "Approval reason must contain 1-1000 characters when provided",
    );
  const approval = {
    schemaVersion: "tiangong.release.publication-approval.v1",
    status: "approved",
    publicationAuthorized: true,
    targetId: artifacts.executablePlan.targetId,
    executablePlanSha256,
    publicationDraftPlanSha256:
      artifacts.executablePlan.publicationDraftPlanSha256,
    payloadManifestSha256: artifacts.executablePlan.payloadManifestSha256,
    targetSnapshotSha256: artifacts.executablePlan.targetSnapshotSha256,
    targetFingerprint: artifacts.executablePlan.targetFingerprint,
    publishedState: artifacts.executablePlan.publishedState,
    approvedBy: approver,
    approvedAt: approvedAtDate.toISOString(),
    expiresAt: expiresAtDate.toISOString(),
    reason: normalizedReason,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "publication-draft-plan.json"),
      artifacts.draftPlan,
    );
    await writeCanonical(
      path.join(staging, "publication-payload-manifest.json"),
      artifacts.payloadManifest,
    );
    await writeCanonical(
      path.join(staging, "publication-target-snapshot.json"),
      artifacts.snapshot,
    );
    await writeCanonical(
      path.join(staging, "publication-executable-plan.json"),
      artifacts.executablePlan,
    );
    await writeCanonical(
      path.join(staging, "publication-approval.json"),
      approval,
    );
  });
  return {
    path: target,
    approval,
    approvalSha256: hashJson(approval),
    executablePlanSha256,
  };
}

export async function loadApprovalArtifacts(approvalDir) {
  const root = path.resolve(approvalDir);
  const artifacts = await loadInspectionArtifacts(root);
  const { value: approval } = await readJson(
    path.join(root, "publication-approval.json"),
    "publication_approval_missing",
  );
  if (
    approval.schemaVersion !== "tiangong.release.publication-approval.v1" ||
    approval.status !== "approved" ||
    approval.publicationAuthorized !== true
  )
    fail(
      "publication_approval_unsupported",
      "Publication execution requires an active Publication Approval v1",
    );
  assertExactObject(
    approval,
    [
      "schemaVersion",
      "status",
      "publicationAuthorized",
      "targetId",
      "executablePlanSha256",
      "publicationDraftPlanSha256",
      "payloadManifestSha256",
      "targetSnapshotSha256",
      "targetFingerprint",
      "publishedState",
      "approvedBy",
      "approvedAt",
      "expiresAt",
      "reason",
    ],
    "publication_approval_invalid",
    "Publication approval",
  );
  verifyJsonHash(
    artifacts.executablePlan,
    approval.executablePlanSha256,
    "publication_approval_plan_hash_mismatch",
    "Publication executable plan",
  );
  verifyJsonHash(
    artifacts.snapshot,
    approval.targetSnapshotSha256,
    "publication_approval_snapshot_hash_mismatch",
    "Publication target snapshot",
  );
  verifyJsonHash(
    artifacts.payloadManifest,
    approval.payloadManifestSha256,
    "publication_approval_payload_hash_mismatch",
    "Publication payload manifest",
  );
  return { root, ...artifacts, approval, approvalSha256: hashJson(approval) };
}

async function loadInspectionArtifacts(root) {
  const { value: draftPlan } = await readJson(
    path.join(root, "publication-draft-plan.json"),
    "publication_draft_plan_missing",
  );
  const { value: payloadManifest } = await readJson(
    path.join(root, "publication-payload-manifest.json"),
    "publication_payload_manifest_missing",
  );
  const { value: snapshot } = await readJson(
    path.join(root, "publication-target-snapshot.json"),
    "publication_target_snapshot_missing",
  );
  const { value: executablePlan } = await readJson(
    path.join(root, "publication-executable-plan.json"),
    "publication_executable_plan_missing",
  );
  if (
    executablePlan.schemaVersion !==
      "tiangong.release.publication-executable-plan.v1" ||
    executablePlan.status !== "ready_for_approval" ||
    executablePlan.publicationAuthorized !== false
  )
    fail(
      "publication_executable_plan_unsupported",
      "Approval requires a ready, unapproved Publication Executable Plan",
    );
  assertExactObject(
    executablePlan,
    [
      "schemaVersion",
      "status",
      "publicationAuthorized",
      "targetId",
      "publicationDraftPlanSha256",
      "payloadManifestSha256",
      "targetSnapshotSha256",
      "targetFingerprint",
      "publishedState",
      "operationCount",
      "operations",
    ],
    "publication_executable_plan_invalid",
    "Publication executable plan",
  );
  verifyJsonHash(
    draftPlan,
    executablePlan.publicationDraftPlanSha256,
    "publication_executable_draft_hash_mismatch",
    "Publication Draft Plan",
  );
  verifyJsonHash(
    payloadManifest,
    executablePlan.payloadManifestSha256,
    "publication_executable_payload_hash_mismatch",
    "Publication payload manifest",
  );
  verifyJsonHash(
    snapshot,
    executablePlan.targetSnapshotSha256,
    "publication_executable_snapshot_hash_mismatch",
    "Publication target snapshot",
  );
  return { draftPlan, payloadManifest, snapshot, executablePlan };
}
