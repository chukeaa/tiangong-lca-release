import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import {
  assertAbsent,
  assertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { requestJson, resolvePublicationRuntime } from "./remote.mjs";

const PLAN_SCHEMA = "tiangong.release.portal-lcia-projection-plan.v1";
const PACKAGE_PUBLICATION_PLAN_SCHEMA =
  "tiangong.release.portal-lcia-package-publication-plan.v1";
const PACKAGE_PUBLICATION_RECEIPT_SCHEMA =
  "tiangong.release.portal-lcia-package-publication-receipt.v1";
const FINALIZATION_SCHEMA =
  "tiangong.release.portal-lcia-projection-finalization-receipt.v1";
const READBACK_SCHEMA =
  "tiangong.release.portal-lcia-projection-readback-receipt.v1";
const REVOCATION_SCHEMA =
  "tiangong.release.portal-lcia-projection-revocation-receipt.v1";
const PROJECTION_CONTRACT = "portal.lcia-projection.v1";
const HASH_CONTRACT = "portal.lcia-projection.int32be-frame-sha256.v1";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u;
const AMBIGUOUS_REMOTE_CODES = new Set([
  "publication_remote_unavailable",
  "publication_remote_response_invalid",
]);

export async function preparePortalLciaPackagePublicationPlan({
  packageId,
  displayDefaultImpactCategory,
  reason,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  const normalizedPackageId = requiredUuid(packageId, "Package ID");
  const normalizedDisplayDefault = requiredText(
    displayDefaultImpactCategory,
    "Display default impact category",
    512,
  );
  const preparedResponse = await invokePackagePublicationPrepare({
    runtime,
    packageId: normalizedPackageId,
    displayDefaultImpactCategory: normalizedDisplayDefault,
    fetchImpl,
  });
  const prepared = validatePackagePublishPrepareResponse(preparedResponse);
  if (
    prepared.package.id !== normalizedPackageId ||
    prepared.displayDefaultImpactCategory !== normalizedDisplayDefault
  )
    fail(
      "portal_lcia_package_publication_prepare_identity_mismatch",
      "LCIA package publication preparation returned different package or display-default identities",
    );
  const plan = {
    schemaVersion: PACKAGE_PUBLICATION_PLAN_SCHEMA,
    status: "ready_for_confirmation",
    packagePublicationAuthorized: false,
    targetEndpointFingerprint: runtime.targetEndpointFingerprint,
    preparedByActorUserId: runtime.actorUserId,
    publishPlanHash: prepared.publishPlanHash,
    package: prepared.package,
    projection: prepared.projection,
    artifacts: prepared.artifacts,
    displayDefaultImpactCategory: prepared.displayDefaultImpactCategory,
    currentProcessSetHash: prepared.currentProcessSetHash,
    currentPublication: prepared.currentPublication,
    requestedReason: requiredText(reason, "Publication reason", 2000),
    preparedAt: requiredTimestamp(now().toISOString(), "Prepared at"),
  };
  validatePackagePublicationPlan(plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-plan.json"),
      plan,
    );
  });
  return { path: target, plan, planSha256: hashJson(plan) };
}

export async function publishPortalLciaPackage({
  packagePlanDir,
  confirmPlanSha256,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const artifacts = await loadPackagePublicationPlan(packagePlanDir);
  if (confirmPlanSha256 !== artifacts.planSha256)
    fail(
      "portal_lcia_package_publication_confirmation_mismatch",
      "LCIA package publication confirmation must exactly match the plan SHA-256",
      {
        expected: artifacts.planSha256,
        received: confirmPlanSha256 ?? null,
      },
    );
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  assertPackagePublicationPlanTarget(artifacts.plan, runtime);
  const freshPrepareResponse = await invokePackagePublicationPrepare({
    runtime,
    packageId: artifacts.plan.package.id,
    displayDefaultImpactCategory: artifacts.plan.displayDefaultImpactCategory,
    fetchImpl,
  });
  const freshPrepared =
    validatePackagePublishPrepareResponse(freshPrepareResponse);
  const plannedPrepareEvidence = packagePublishPrepareEvidenceFromPlan(
    artifacts.plan,
  );
  const freshPrepareMatched =
    hashJson(freshPrepared) === hashJson(plannedPrepareEvidence);
  const audit = {
    schemaVersion: "tiangong.release.portal-lcia-package-publication-audit.v1",
    packagePublicationPlanSha256: artifacts.planSha256,
    databasePublishPlanHash: artifacts.plan.publishPlanHash,
  };
  let published;
  let disposition;
  let responseLossReconciled = false;
  try {
    const response = await invokePackagePublication({
      runtime,
      plan: artifacts.plan,
      audit,
      fetchImpl,
    });
    published = validatePackagePublishResponse(response);
    disposition = published.reused ? "reused" : "published";
  } catch (error) {
    if (!isAmbiguousRemoteError(error)) throw error;
    responseLossReconciled = true;
    try {
      const retryResponse = await invokePackagePublication({
        runtime,
        plan: artifacts.plan,
        audit,
        fetchImpl,
      });
      published = validatePackagePublishResponse(retryResponse);
      disposition = "reconciled_after_response_loss";
    } catch (retryError) {
      if (isAmbiguousRemoteError(retryError))
        retryError.details = {
          ...(retryError.details ?? {}),
          safeRetry: true,
          packagePublicationPlanSha256: artifacts.planSha256,
        };
      throw retryError;
    }
  }
  assertPackagePublishedMatchesPlan(published.data, artifacts.plan);
  if (!freshPrepareMatched && !published.reused)
    fail(
      "portal_lcia_package_publication_prepare_drift",
      "Database published a package after its exact precondition drifted instead of returning a plan-hash conflict",
      {
        plannedEvidenceSha256: hashJson(plannedPrepareEvidence),
        observedEvidenceSha256: hashJson(freshPrepared),
      },
    );
  if (!freshPrepareMatched)
    assertPackageReuseFreshEvidence({
      freshPrepared,
      plan: artifacts.plan,
      published: published.data,
    });

  let readback;
  try {
    const response = await invokeProjectionPrepare({
      runtime,
      packageId: published.data.packageId,
      lciaResultPublicationId: published.data.publicationId,
      fetchImpl,
    });
    readback = validatePrepareResponse(response);
    assertPackagePublicationReadbackMatches({
      published: published.data,
      prepared: readback,
      plan: artifacts.plan,
    });
  } catch (error) {
    if (isAmbiguousRemoteError(error))
      error.details = {
        ...(error.details ?? {}),
        safeRetry: true,
        packagePublicationPlanSha256: artifacts.planSha256,
      };
    throw error;
  }
  const receipt = {
    schemaVersion: PACKAGE_PUBLICATION_RECEIPT_SCHEMA,
    status: "current",
    packagePublicationAuthorized: true,
    independentlyReadBack: true,
    disposition,
    responseLossReconciled,
    publishResponseReused: published.reused,
    packagePublicationPlanSha256: artifacts.planSha256,
    databasePublishPlanHash: artifacts.plan.publishPlanHash,
    freshPrepareEvidenceSha256: hashJson(freshPrepared),
    freshPrepareMatched,
    freshPreparePublishPlanHash: freshPrepared.publishPlanHash,
    freshPrepareCurrentPublication: freshPrepared.currentPublication,
    publishResponseSha256: hashJson(published),
    prepareReadbackSha256: hashJson(readback),
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    executedByActorUserId: runtime.actorUserId,
    publicationId: published.data.publicationId,
    packageId: published.data.packageId,
    previousPublicationId: published.data.previousPublicationId,
    isCurrent: true,
    packageVersion: published.data.packageVersion,
    packageResultHash: readback.packageResultHash,
    buildWorkerJobId: readback.buildWorkerJobId,
    projectionContractVersion: readback.projectionContractVersion,
    hashContractVersion: readback.hashContractVersion,
    inputManifestHash: artifacts.plan.package.inputManifestHash,
    closureCertificateHash: artifacts.plan.package.closureCertificateHash,
    snapshotHash: artifacts.plan.package.snapshotHash,
    projectionId: published.data.projectionId,
    projectionContentHash: published.data.projectionContentHash,
    processCount: readback.processCount,
    impactCount: readback.impactCount,
    valueCount: readback.valueCount,
    processAxisHash: readback.processAxisHash,
    impactAxisHash: readback.impactAxisHash,
    valueGridHash: readback.valueGridHash,
    relationHash: readback.relationHash,
    bundleContentHash: artifacts.plan.artifacts.bundleContentHash,
    bundleManifestSha256: artifacts.plan.artifacts.bundleManifestSha256,
    lciaChunkSetSha256: artifacts.plan.artifacts.lciaChunkSetSha256,
    resultArtifactSha256: artifacts.plan.artifacts.resultArtifactSha256,
    queryArtifactSha256: artifacts.plan.artifacts.queryArtifactSha256,
    currentProcessSetHash: artifacts.plan.currentProcessSetHash,
    currentPublicationPrecondition: artifacts.plan.currentPublication,
    displayDefaultImpactCategory: artifacts.plan.displayDefaultImpactCategory,
    requestedReason: artifacts.plan.requestedReason,
    reasonPersistence:
      published.reused && responseLossReconciled
        ? "unknown_after_response_loss"
        : published.reused
          ? "not_rewritten_on_reuse"
          : "recorded",
    publishedAt: published.data.publishedAt,
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validatePackagePublicationReceipt(receipt, artifacts.plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-receipt.json"),
      receipt,
    );
  });
  return {
    path: target,
    receipt,
    receiptSha256: hashJson(receipt),
    disposition,
  };
}

export async function preparePortalLciaProjectionPlan({
  packagePublicationDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const publication = await loadPackagePublicationArtifacts(
    packagePublicationDir,
  );
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  assertPackagePublicationReceiptTarget(publication.receipt, runtime);
  const response = await invokeProjectionPrepare({
    runtime,
    packageId: publication.receipt.packageId,
    lciaResultPublicationId: publication.receipt.publicationId,
    fetchImpl,
  });
  const prepared = validatePrepareResponse(response);
  assertProjectionPrepareMatchesPackagePublication(
    prepared,
    publication.receipt,
  );
  const preparedAt = requiredTimestamp(now().toISOString(), "Prepared at");
  const idempotencyKey = projectionIdempotencyKey(prepared);
  const plan = {
    schemaVersion: PLAN_SCHEMA,
    status: "ready_for_confirmation",
    projectionFinalizationAuthorized: false,
    packagePublicationReceiptSha256: publication.receiptSha256,
    targetEndpointFingerprint: runtime.targetEndpointFingerprint,
    preparedByActorUserId: runtime.actorUserId,
    projectionId: prepared.projectionId,
    buildWorkerJobId: prepared.buildWorkerJobId,
    packageId: prepared.packageId,
    lciaResultPublicationId: prepared.lciaResultPublicationId,
    packageVersion: prepared.packageVersion,
    packageResultHash: prepared.packageResultHash,
    projectionContractVersion: prepared.projectionContractVersion,
    hashContractVersion: prepared.hashContractVersion,
    processCount: prepared.processCount,
    impactCount: prepared.impactCount,
    valueCount: prepared.valueCount,
    processAxisHash: prepared.processAxisHash,
    impactAxisHash: prepared.impactAxisHash,
    valueGridHash: prepared.valueGridHash,
    relationHash: prepared.relationHash,
    projectionContentHash: prepared.contentHash,
    sourcePublishedAt: prepared.publishedAt,
    idempotencyKey,
    preparedAt,
  };
  validatePlan(plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-plan.json"),
      publication.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-receipt.json"),
      publication.receipt,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      plan,
    );
  });
  return { path: target, plan, planSha256: hashJson(plan) };
}

export async function finalizePortalLciaProjection({
  planDir,
  outDir,
  confirmPlanSha256,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const artifacts = await loadProjectionPlan(planDir);
  if (confirmPlanSha256 !== artifacts.planSha256)
    fail(
      "portal_lcia_projection_confirmation_mismatch",
      "Projection finalization confirmation must exactly match the plan SHA-256",
      {
        expected: artifacts.planSha256,
        received: confirmPlanSha256 ?? null,
      },
    );
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  assertPlanTarget(artifacts.plan, runtime, { requirePreparingActor: true });

  const prepareResponse = await invokeProjectionPrepare({
    runtime,
    packageId: artifacts.plan.packageId,
    lciaResultPublicationId: artifacts.plan.lciaResultPublicationId,
    fetchImpl,
  });
  const freshPrepared = validatePrepareResponse(prepareResponse);
  const freshEvidenceSha256 = hashJson(prepareEvidence(freshPrepared));
  if (freshEvidenceSha256 !== hashJson(planEvidence(artifacts.plan)))
    fail(
      "portal_lcia_projection_prepare_drift",
      "Projection evidence changed after the confirmed plan was prepared",
      {
        plannedEvidenceSha256: hashJson(planEvidence(artifacts.plan)),
        observedEvidenceSha256: freshEvidenceSha256,
      },
    );

  const audit = {
    schemaVersion: "tiangong.release.portal-lcia-projection-finalize-audit.v1",
    projectionPlanSha256: artifacts.planSha256,
  };
  let finalized;
  let disposition;
  let reconciliationReadbackSha256 = null;
  try {
    const finalizeResponse = await invokeProjectionRpc({
      runtime,
      functionName: "cmd_portal_lcia_projection_finalize_publication_v1",
      body: {
        p_projection_id: artifacts.plan.projectionId,
        p_lcia_result_publication_id: artifacts.plan.lciaResultPublicationId,
        p_package_version: artifacts.plan.packageVersion,
        p_package_result_hash: artifacts.plan.packageResultHash,
        p_projection_content_hash: artifacts.plan.projectionContentHash,
        p_idempotency_key: artifacts.plan.idempotencyKey,
        p_audit: audit,
      },
      fetchImpl,
    });
    const validated = validateFinalizeResponse(finalizeResponse);
    assertFinalizedMatchesPlan(validated.data, artifacts.plan);
    finalized = validated.data;
    disposition = validated.reused ? "reused" : "created";
  } catch (error) {
    if (!isAmbiguousRemoteError(error)) throw error;
    const reconciliation = await reconcileFinalizationAfterResponseLoss({
      runtime,
      plan: artifacts.plan,
      fetchImpl,
    });
    if (!reconciliation.readback) {
      if (isRetryableFinalizationReconciliationError(reconciliation.error)) {
        error.details = {
          ...(error.details ?? {}),
          safeRetry: true,
          projectionPlanSha256: artifacts.planSha256,
          idempotencyKey: artifacts.plan.idempotencyKey,
        };
        throw error;
      }
      throw reconciliation.error;
    }
    finalized = finalizeDataFromReadback(reconciliation.readback);
    disposition = "reconciled_after_response_loss";
    reconciliationReadbackSha256 = hashJson(reconciliation.readback);
  }

  const receipt = {
    schemaVersion: FINALIZATION_SCHEMA,
    status: "finalized",
    projectionFinalizationAuthorized: true,
    independentReadbackVerified: false,
    disposition,
    projectionPlanSha256: artifacts.planSha256,
    freshPrepareEvidenceSha256: freshEvidenceSha256,
    reconciliationReadbackSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    finalizedByActorUserId: runtime.actorUserId,
    projectionPublicationId: finalized.projectionPublicationId,
    projectionId: finalized.projectionId,
    lciaResultPublicationId: finalized.lciaResultPublicationId,
    packageId: finalized.packageId,
    packageVersion: artifacts.plan.packageVersion,
    packageResultHash: artifacts.plan.packageResultHash,
    projectionContentHash: finalized.contentHash,
    evidenceHash: finalized.evidenceHash,
    processCount: artifacts.plan.processCount,
    impactCount: artifacts.plan.impactCount,
    valueCount: artifacts.plan.valueCount,
    sourcePublishedAt: artifacts.plan.sourcePublishedAt,
    idempotencyKey: artifacts.plan.idempotencyKey,
    finalizedAt: finalized.finalizedAt,
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validateFinalizationReceipt(receipt, artifacts.plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalization-receipt.json"),
      receipt,
    );
  });
  return {
    path: target,
    receipt,
    receiptSha256: hashJson(receipt),
    disposition,
  };
}

export async function verifyPortalLciaProjectionPublication({
  finalizationDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const artifacts = await loadFinalizationArtifacts(finalizationDir);
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  assertPlanTarget(artifacts.plan, runtime);
  const response = await invokeProjectionReadback({
    runtime,
    plan: artifacts.plan,
    fetchImpl,
  });
  const readback = validateReadbackResponse(response);
  assertReadbackMatchesFinalization({
    readback,
    plan: artifacts.plan,
    finalizationReceipt: artifacts.finalizationReceipt,
    requireCurrent: true,
    requiredStatus: "finalized",
  });
  const receipt = {
    schemaVersion: READBACK_SCHEMA,
    status: "verified",
    independentlyQueried: true,
    isCurrent: true,
    isPubliclyVisible: true,
    projectionPlanSha256: artifacts.planSha256,
    finalizationReceiptSha256: artifacts.finalizationReceiptSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    verifiedByActorUserId: runtime.actorUserId,
    projectionPublicationId: readback.projectionPublicationId,
    projectionId: readback.projectionId,
    lciaResultPublicationId: readback.lciaResultPublicationId,
    packageId: readback.packageId,
    packageVersion: readback.packageVersion,
    projectionContentHash: readback.contentHash,
    evidenceHash: readback.evidenceHash,
    processCount: readback.processCount,
    impactCount: readback.impactCount,
    valueCount: readback.valueCount,
    sourcePublishedAt: artifacts.plan.sourcePublishedAt,
    finalizedAt: readback.finalizedAt,
    verifiedAt: requiredTimestamp(now().toISOString(), "Verified at"),
  };
  validateReadbackReceipt(receipt, artifacts);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalization-receipt.json"),
      artifacts.finalizationReceipt,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-readback-receipt.json"),
      receipt,
    );
  });
  return { path: target, receipt, receiptSha256: hashJson(receipt) };
}

export async function revokePortalLciaProjectionPublication({
  finalizationDir,
  outDir,
  confirmFinalizationReceiptSha256,
  reason,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const artifacts = await loadFinalizationArtifacts(finalizationDir);
  if (confirmFinalizationReceiptSha256 !== artifacts.finalizationReceiptSha256)
    fail(
      "portal_lcia_projection_revoke_confirmation_mismatch",
      "Projection revocation confirmation must exactly match the finalization receipt SHA-256",
      {
        expected: artifacts.finalizationReceiptSha256,
        received: confirmFinalizationReceiptSha256 ?? null,
      },
    );
  const normalizedReason = String(reason ?? "").trim();
  if (!normalizedReason || normalizedReason.length > 2000)
    fail(
      "portal_lcia_projection_revoke_reason_invalid",
      "Projection revocation requires a reason of 1-2000 characters",
    );
  const target = path.resolve(outDir);
  await assertAbsent(target);
  const runtime = await resolveProjectionRuntime({ env, fetchImpl });
  assertPlanTarget(artifacts.plan, runtime);

  const beforeResponse = await invokeProjectionReadback({
    runtime,
    plan: artifacts.plan,
    fetchImpl,
  });
  const before = validateReadbackResponse(beforeResponse);
  assertReadbackMatchesFinalization({
    readback: before,
    plan: artifacts.plan,
    finalizationReceipt: artifacts.finalizationReceipt,
    requireCurrent: false,
    requiredStatus: ["finalized", "revoked"],
  });

  const audit = {
    schemaVersion: "tiangong.release.portal-lcia-projection-revoke-audit.v1",
    finalizationReceiptSha256: artifacts.finalizationReceiptSha256,
  };
  let disposition;
  let revokeResponseSha256 = null;
  try {
    const response = await invokeProjectionRpc({
      runtime,
      functionName: "cmd_portal_lcia_projection_revoke_publication_v1",
      body: {
        p_lcia_result_publication_id: artifacts.plan.lciaResultPublicationId,
        p_projection_content_hash: artifacts.plan.projectionContentHash,
        p_reason: normalizedReason,
        p_audit: audit,
      },
      fetchImpl,
    });
    const revoked = validateRevokeResponse(response);
    assertRevokedMatchesPlan(
      revoked.data,
      artifacts.plan,
      artifacts.finalizationReceipt,
    );
    disposition = revoked.reused ? "reused" : "revoked";
    revokeResponseSha256 = hashJson(revoked);
  } catch (error) {
    if (!isAmbiguousRemoteError(error)) throw error;
    disposition = "reconciled_after_response_loss";
  }

  let after;
  try {
    const afterResponse = await invokeProjectionReadback({
      runtime,
      plan: artifacts.plan,
      fetchImpl,
    });
    after = validateReadbackResponse(afterResponse);
    assertReadbackMatchesFinalization({
      readback: after,
      plan: artifacts.plan,
      finalizationReceipt: artifacts.finalizationReceipt,
      requireCurrent: false,
      requiredStatus: "revoked",
    });
  } catch (error) {
    error.details = {
      ...(error.details ?? {}),
      safeRetry: true,
      finalizationReceiptSha256: artifacts.finalizationReceiptSha256,
    };
    throw error;
  }
  const receipt = {
    schemaVersion: REVOCATION_SCHEMA,
    status: "revoked",
    independentlyQueried: true,
    isCurrent: false,
    isPubliclyVisible: false,
    disposition,
    projectionPlanSha256: artifacts.planSha256,
    finalizationReceiptSha256: artifacts.finalizationReceiptSha256,
    revokeResponseSha256,
    revocationReadbackSha256: hashJson(after),
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    revokedByActorUserId: runtime.actorUserId,
    projectionPublicationId: after.projectionPublicationId,
    projectionId: after.projectionId,
    lciaResultPublicationId: after.lciaResultPublicationId,
    packageId: after.packageId,
    packageVersion: after.packageVersion,
    projectionContentHash: after.contentHash,
    evidenceHash: after.evidenceHash,
    requestedReason: normalizedReason,
    reasonPersistence:
      disposition === "revoked"
        ? "recorded"
        : disposition === "reused"
          ? "not_rewritten_on_reuse"
          : "unknown_after_response_loss",
    revokedAt: after.revokedAt,
    verifiedAt: requiredTimestamp(now().toISOString(), "Verified at"),
  };
  validateRevocationReceipt(receipt, artifacts);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalization-receipt.json"),
      artifacts.finalizationReceipt,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-revocation-receipt.json"),
      receipt,
    );
  });
  return { path: target, receipt, receiptSha256: hashJson(receipt) };
}

export async function loadProjectionPlan(planDir) {
  const root = path.resolve(planDir);
  const publication = await loadPackagePublicationArtifacts(root);
  const { value: plan } = await readJson(
    path.join(root, "portal-lcia-projection-plan.json"),
    "portal_lcia_projection_plan_missing",
  );
  validatePlan(plan);
  if (plan.packagePublicationReceiptSha256 !== publication.receiptSha256)
    fail(
      "portal_lcia_projection_package_publication_hash_mismatch",
      "Projection plan does not match its package publication receipt",
    );
  return {
    root,
    plan,
    planSha256: hashJson(plan),
    packagePublicationPlan: publication.plan,
    packagePublicationReceipt: publication.receipt,
  };
}

export async function loadPackagePublicationPlan(packagePlanDir) {
  const root = path.resolve(packagePlanDir);
  const { value: plan } = await readJson(
    path.join(root, "portal-lcia-package-publication-plan.json"),
    "portal_lcia_package_publication_plan_missing",
  );
  validatePackagePublicationPlan(plan);
  return { root, plan, planSha256: hashJson(plan) };
}

async function loadPackagePublicationArtifacts(packagePublicationDir) {
  const root = path.resolve(packagePublicationDir);
  const planArtifacts = await loadPackagePublicationPlan(root);
  const { value: receipt } = await readJson(
    path.join(root, "portal-lcia-package-publication-receipt.json"),
    "portal_lcia_package_publication_receipt_missing",
  );
  validatePackagePublicationReceipt(receipt, planArtifacts.plan);
  verifyJsonHash(
    planArtifacts.plan,
    receipt.packagePublicationPlanSha256,
    "portal_lcia_package_publication_plan_hash_mismatch",
    "Portal LCIA package publication plan",
  );
  return { ...planArtifacts, receipt, receiptSha256: hashJson(receipt) };
}

async function loadFinalizationArtifacts(finalizationDir) {
  const root = path.resolve(finalizationDir);
  const planArtifacts = await loadProjectionPlan(root);
  const { value: finalizationReceipt } = await readJson(
    path.join(root, "portal-lcia-projection-finalization-receipt.json"),
    "portal_lcia_projection_finalization_receipt_missing",
  );
  validateFinalizationReceipt(finalizationReceipt, planArtifacts.plan);
  verifyJsonHash(
    planArtifacts.plan,
    finalizationReceipt.projectionPlanSha256,
    "portal_lcia_projection_finalization_plan_hash_mismatch",
    "Portal LCIA projection plan",
  );
  return {
    ...planArtifacts,
    finalizationReceipt,
    finalizationReceiptSha256: hashJson(finalizationReceipt),
  };
}

async function writePackagePublicationLineage(staging, artifacts) {
  await writeCanonical(
    path.join(staging, "portal-lcia-package-publication-plan.json"),
    artifacts.packagePublicationPlan,
  );
  await writeCanonical(
    path.join(staging, "portal-lcia-package-publication-receipt.json"),
    artifacts.packagePublicationReceipt,
  );
}

async function resolveProjectionRuntime({ env, fetchImpl }) {
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  if (jwtRole(runtime.accessToken) === "service_role")
    fail(
      "publication_service_role_forbidden",
      "Portal LCIA projection commands require an actor session and reject service-role access tokens",
    );
  if (!runtime.actorUserId)
    fail(
      "portal_lcia_projection_actor_identity_unavailable",
      "Actor JWT must contain a subject identifier for Portal LCIA projection commands",
    );
  return runtime;
}

function isAmbiguousRemoteError(error) {
  return (
    AMBIGUOUS_REMOTE_CODES.has(error?.code) ||
    (Number.isInteger(error?.details?.status) && error.details.status >= 500)
  );
}

function isRetryableFinalizationReconciliationError(error) {
  return (
    isAmbiguousRemoteError(error) ||
    error?.code === "projection_publication_not_found"
  );
}

function jwtRole(token) {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const payload = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

async function invokeProjectionRpc({ runtime, functionName, body, fetchImpl }) {
  return requestJson({
    url: `${runtime.projectBaseUrl}/rest/v1/rpc/${functionName}`,
    method: "POST",
    runtime,
    fetchImpl,
    body,
    schema: "api",
  });
}

async function invokePackagePublication({ runtime, plan, audit, fetchImpl }) {
  return invokeProjectionRpc({
    runtime,
    functionName: "cmd_portal_lcia_result_package_publish_v1",
    body: {
      p_package_id: plan.package.id,
      p_display_default_impact_category: plan.displayDefaultImpactCategory,
      p_expected_publish_plan_hash: plan.publishPlanHash,
      p_reason: plan.requestedReason,
      p_audit: audit,
    },
    fetchImpl,
  });
}

async function invokePackagePublicationPrepare({
  runtime,
  packageId,
  displayDefaultImpactCategory,
  fetchImpl,
}) {
  return invokeProjectionRpc({
    runtime,
    functionName: "qry_portal_lcia_result_package_publish_prepare_v1",
    body: {
      p_package_id: packageId,
      p_display_default_impact_category: displayDefaultImpactCategory,
    },
    fetchImpl,
  });
}

async function invokeProjectionPrepare({
  runtime,
  packageId,
  lciaResultPublicationId,
  fetchImpl,
}) {
  return invokeProjectionRpc({
    runtime,
    functionName: "qry_portal_lcia_projection_prepare_v1",
    body: {
      p_package_id: packageId,
      p_lcia_result_publication_id: lciaResultPublicationId,
    },
    fetchImpl,
  });
}

async function invokeProjectionReadback({ runtime, plan, fetchImpl }) {
  return invokeProjectionRpc({
    runtime,
    functionName: "qry_portal_lcia_projection_publication_readback_v1",
    body: {
      p_lcia_result_publication_id: plan.lciaResultPublicationId,
      p_projection_content_hash: plan.projectionContentHash,
    },
    fetchImpl,
  });
}

async function reconcileFinalizationAfterResponseLoss({
  runtime,
  plan,
  fetchImpl,
}) {
  try {
    const response = await invokeProjectionReadback({
      runtime,
      plan,
      fetchImpl,
    });
    const readback = validateReadbackResponse(response);
    assertReadbackMatchesPlan(readback, plan, {
      requireCurrent: true,
      requiredStatus: "finalized",
    });
    return { readback, error: null };
  } catch (error) {
    return { readback: null, error };
  }
}

function validatePackagePublishPrepareResponse(response) {
  assertExactObject(
    response,
    ["ok", "data"],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Portal LCIA package publication prepare response",
  );
  if (response.ok !== true)
    fail(
      "portal_lcia_package_publication_prepare_response_invalid",
      "LCIA package publication prepare response did not report success",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "publishPlanHash",
      "package",
      "projection",
      "artifacts",
      "displayDefaultImpactCategory",
      "currentProcessSetHash",
      "currentPublication",
    ],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Portal LCIA package publication prepare data",
  );
  assertExactObject(
    data.package,
    [
      "id",
      "version",
      "resultHash",
      "inputManifestHash",
      "closureCertificateHash",
      "snapshotHash",
      "processCount",
      "impactCount",
      "valueCount",
    ],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Portal LCIA package publication prepare package",
  );
  assertExactObject(
    data.projection,
    [
      "id",
      "contentHash",
      "processAxisHash",
      "impactAxisHash",
      "valueGridHash",
      "relationHash",
    ],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Portal LCIA package publication prepare projection",
  );
  assertExactObject(
    data.artifacts,
    [
      "bundleContentHash",
      "bundleManifestSha256",
      "lciaChunkSetSha256",
      "resultArtifactSha256",
      "queryArtifactSha256",
    ],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Portal LCIA package publication prepare artifacts",
  );
  const packageEvidence = {
    id: requiredUuid(data.package.id, "Package ID"),
    version: requiredText(data.package.version, "Package version", 256),
    resultHash: requiredHash(data.package.resultHash, "Package result hash"),
    inputManifestHash: requiredHash(
      data.package.inputManifestHash,
      "Input manifest hash",
    ),
    closureCertificateHash: requiredHash(
      data.package.closureCertificateHash,
      "Closure certificate hash",
    ),
    snapshotHash: requiredHash(data.package.snapshotHash, "Snapshot hash"),
    processCount: requiredPositiveInteger(
      data.package.processCount,
      "Process count",
    ),
    impactCount: requiredPositiveInteger(
      data.package.impactCount,
      "Impact count",
    ),
    valueCount: requiredPositiveInteger(data.package.valueCount, "Value count"),
  };
  if (
    packageEvidence.valueCount !==
    packageEvidence.processCount * packageEvidence.impactCount
  )
    fail(
      "portal_lcia_package_publication_prepare_response_invalid",
      "LCIA package publication prepare returned an inconsistent projection grid",
    );
  const currentPublication = validateCurrentPublicationPrecondition(
    data.currentPublication,
  );
  return {
    publishPlanHash: requiredHash(
      data.publishPlanHash,
      "Database publish plan hash",
    ),
    package: packageEvidence,
    projection: {
      id: requiredUuid(data.projection.id, "Projection ID"),
      contentHash: requiredHash(
        data.projection.contentHash,
        "Projection content hash",
      ),
      processAxisHash: requiredHash(
        data.projection.processAxisHash,
        "Process axis hash",
      ),
      impactAxisHash: requiredHash(
        data.projection.impactAxisHash,
        "Impact axis hash",
      ),
      valueGridHash: requiredHash(
        data.projection.valueGridHash,
        "Value grid hash",
      ),
      relationHash: requiredHash(data.projection.relationHash, "Relation hash"),
    },
    artifacts: {
      bundleContentHash: requiredHash(
        data.artifacts.bundleContentHash,
        "Bundle content hash",
      ),
      bundleManifestSha256: requiredHash(
        data.artifacts.bundleManifestSha256,
        "Bundle manifest SHA-256",
      ),
      lciaChunkSetSha256: requiredHash(
        data.artifacts.lciaChunkSetSha256,
        "LCIA chunk-set SHA-256",
      ),
      resultArtifactSha256: requiredHash(
        data.artifacts.resultArtifactSha256,
        "Result artifact SHA-256",
      ),
      queryArtifactSha256: requiredHash(
        data.artifacts.queryArtifactSha256,
        "Query artifact SHA-256",
      ),
    },
    displayDefaultImpactCategory: requiredText(
      data.displayDefaultImpactCategory,
      "Display default impact category",
      512,
    ),
    currentProcessSetHash: requiredHash(
      data.currentProcessSetHash,
      "Current Process-set hash",
    ),
    currentPublication,
  };
}

function validateCurrentPublicationPrecondition(value) {
  if (value === null) return null;
  assertExactObject(
    value,
    ["publicationId", "packageId", "packageVersion", "publishedAt"],
    "portal_lcia_package_publication_prepare_response_invalid",
    "Current publication precondition",
  );
  return {
    publicationId: requiredUuid(value.publicationId, "Current publication ID"),
    packageId: requiredUuid(value.packageId, "Current publication package ID"),
    packageVersion: requiredText(
      value.packageVersion,
      "Current publication package version",
      256,
    ),
    publishedAt: requiredTimestamp(
      value.publishedAt,
      "Current publication timestamp",
    ),
  };
}

function validatePackagePublishResponse(response) {
  assertExactObject(
    response,
    ["ok", "reused", "data"],
    "portal_lcia_package_publication_response_invalid",
    "Portal LCIA package publication response",
  );
  if (response.ok !== true || typeof response.reused !== "boolean")
    fail(
      "portal_lcia_package_publication_response_invalid",
      "LCIA package publication response did not report a valid success result",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "publicationId",
      "packageId",
      "previousPublicationId",
      "isCurrent",
      "packageVersion",
      "projectionId",
      "projectionContentHash",
      "publishedAt",
      "publishPlanHash",
    ],
    "portal_lcia_package_publication_response_invalid",
    "Portal LCIA package publication data",
  );
  const normalized = {
    publicationId: requiredUuid(data.publicationId, "Publication ID"),
    packageId: requiredUuid(data.packageId, "Package ID"),
    previousPublicationId:
      data.previousPublicationId === null
        ? null
        : requiredUuid(data.previousPublicationId, "Previous publication ID"),
    isCurrent: data.isCurrent,
    packageVersion: requiredText(data.packageVersion, "Package version", 256),
    projectionId: requiredUuid(data.projectionId, "Projection ID"),
    projectionContentHash: requiredHash(
      data.projectionContentHash,
      "Projection content hash",
    ),
    publishedAt: requiredTimestamp(data.publishedAt, "Published at"),
    publishPlanHash: requiredHash(
      data.publishPlanHash,
      "Database publish plan hash",
    ),
  };
  if (normalized.isCurrent !== true)
    fail(
      "portal_lcia_package_publication_response_invalid",
      "LCIA package publication response is not current",
    );
  return { ok: true, reused: response.reused, data: normalized };
}

function validatePrepareResponse(response) {
  assertExactObject(
    response,
    ["ok", "data"],
    "portal_lcia_projection_prepare_response_invalid",
    "Projection prepare response",
  );
  if (response.ok !== true)
    fail(
      "portal_lcia_projection_prepare_response_invalid",
      "Projection prepare response did not report success",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "projectionId",
      "buildWorkerJobId",
      "packageId",
      "lciaResultPublicationId",
      "packageVersion",
      "packageResultHash",
      "status",
      "projectionContractVersion",
      "hashContractVersion",
      "processCount",
      "impactCount",
      "valueCount",
      "processAxisHash",
      "impactAxisHash",
      "valueGridHash",
      "relationHash",
      "contentHash",
      "publishedAt",
    ],
    "portal_lcia_projection_prepare_response_invalid",
    "Projection prepare data",
  );
  const normalized = {
    projectionId: requiredUuid(data.projectionId, "Projection ID"),
    buildWorkerJobId: requiredUuid(
      data.buildWorkerJobId,
      "Build worker job ID",
    ),
    packageId: requiredUuid(data.packageId, "Package ID"),
    lciaResultPublicationId: requiredUuid(
      data.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    packageVersion: requiredText(data.packageVersion, "Package version", 256),
    packageResultHash: requiredHash(
      data.packageResultHash,
      "Package result hash",
    ),
    status: data.status,
    projectionContractVersion: data.projectionContractVersion,
    hashContractVersion: data.hashContractVersion,
    processCount: requiredPositiveInteger(data.processCount, "Process count"),
    impactCount: requiredPositiveInteger(data.impactCount, "Impact count"),
    valueCount: requiredPositiveInteger(data.valueCount, "Value count"),
    processAxisHash: requiredHash(data.processAxisHash, "Process axis hash"),
    impactAxisHash: requiredHash(data.impactAxisHash, "Impact axis hash"),
    valueGridHash: requiredHash(data.valueGridHash, "Value grid hash"),
    relationHash: requiredHash(data.relationHash, "Relation hash"),
    contentHash: requiredHash(data.contentHash, "Projection content hash"),
    publishedAt: requiredTimestamp(data.publishedAt, "Source published at"),
  };
  if (
    normalized.status !== "prepared" ||
    normalized.projectionContractVersion !== PROJECTION_CONTRACT ||
    normalized.hashContractVersion !== HASH_CONTRACT ||
    normalized.valueCount !== normalized.processCount * normalized.impactCount
  )
    fail(
      "portal_lcia_projection_prepare_response_invalid",
      "Projection prepare response has an unsupported contract, status, or grid cardinality",
    );
  return normalized;
}

function validateFinalizeResponse(response) {
  assertExactObject(
    response,
    ["ok", "reused", "data"],
    "portal_lcia_projection_finalize_response_invalid",
    "Projection finalize response",
  );
  if (response.ok !== true || typeof response.reused !== "boolean")
    fail(
      "portal_lcia_projection_finalize_response_invalid",
      "Projection finalize response did not report a valid success result",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "projectionPublicationId",
      "projectionId",
      "lciaResultPublicationId",
      "packageId",
      "status",
      "contentHash",
      "evidenceHash",
      "finalizedAt",
    ],
    "portal_lcia_projection_finalize_response_invalid",
    "Projection finalize data",
  );
  const normalized = {
    projectionPublicationId: requiredUuid(
      data.projectionPublicationId,
      "Projection publication ID",
    ),
    projectionId: requiredUuid(data.projectionId, "Projection ID"),
    lciaResultPublicationId: requiredUuid(
      data.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    packageId: requiredUuid(data.packageId, "Package ID"),
    status: data.status,
    contentHash: requiredHash(data.contentHash, "Projection content hash"),
    evidenceHash: requiredHash(data.evidenceHash, "Projection evidence hash"),
    finalizedAt: requiredTimestamp(data.finalizedAt, "Finalized at"),
  };
  if (normalized.status !== "finalized")
    fail(
      "portal_lcia_projection_finalize_response_invalid",
      "Projection finalize response is not finalized",
    );
  return { ok: true, reused: response.reused, data: normalized };
}

function validateReadbackResponse(response) {
  assertExactObject(
    response,
    ["ok", "data"],
    "portal_lcia_projection_readback_response_invalid",
    "Projection readback response",
  );
  if (response.ok !== true)
    fail(
      "portal_lcia_projection_readback_response_invalid",
      "Projection readback response did not report success",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "projectionPublicationId",
      "projectionId",
      "lciaResultPublicationId",
      "packageId",
      "packageVersion",
      "status",
      "isCurrent",
      "isPubliclyVisible",
      "contentHash",
      "evidenceHash",
      "processCount",
      "impactCount",
      "valueCount",
      "finalizedAt",
      "revokedAt",
    ],
    "portal_lcia_projection_readback_response_invalid",
    "Projection readback data",
  );
  const normalized = {
    projectionPublicationId: requiredUuid(
      data.projectionPublicationId,
      "Projection publication ID",
    ),
    projectionId: requiredUuid(data.projectionId, "Projection ID"),
    lciaResultPublicationId: requiredUuid(
      data.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    packageId: requiredUuid(data.packageId, "Package ID"),
    packageVersion: requiredText(data.packageVersion, "Package version", 256),
    status: data.status,
    isCurrent: data.isCurrent,
    isPubliclyVisible: data.isPubliclyVisible,
    contentHash: requiredHash(data.contentHash, "Projection content hash"),
    evidenceHash: requiredHash(data.evidenceHash, "Projection evidence hash"),
    processCount: requiredPositiveInteger(data.processCount, "Process count"),
    impactCount: requiredPositiveInteger(data.impactCount, "Impact count"),
    valueCount: requiredPositiveInteger(data.valueCount, "Value count"),
    finalizedAt: requiredTimestamp(data.finalizedAt, "Finalized at"),
    revokedAt:
      data.revokedAt === null
        ? null
        : requiredTimestamp(data.revokedAt, "Revoked at"),
  };
  if (
    !["finalized", "revoked"].includes(normalized.status) ||
    typeof normalized.isCurrent !== "boolean" ||
    typeof normalized.isPubliclyVisible !== "boolean" ||
    normalized.valueCount !==
      normalized.processCount * normalized.impactCount ||
    (normalized.status === "finalized" && normalized.revokedAt !== null) ||
    (normalized.status === "revoked" && normalized.revokedAt === null) ||
    (normalized.status === "revoked" && normalized.isPubliclyVisible)
  )
    fail(
      "portal_lcia_projection_readback_response_invalid",
      "Projection readback returned an inconsistent lifecycle or cardinality",
    );
  return normalized;
}

function validateRevokeResponse(response) {
  assertExactObject(
    response,
    ["ok", "reused", "data"],
    "portal_lcia_projection_revoke_response_invalid",
    "Projection revoke response",
  );
  if (response.ok !== true || typeof response.reused !== "boolean")
    fail(
      "portal_lcia_projection_revoke_response_invalid",
      "Projection revoke response did not report a valid success result",
    );
  const data = response.data;
  assertExactObject(
    data,
    [
      "projectionPublicationId",
      "lciaResultPublicationId",
      "status",
      "revokedAt",
    ],
    "portal_lcia_projection_revoke_response_invalid",
    "Projection revoke data",
  );
  const normalized = {
    projectionPublicationId: requiredUuid(
      data.projectionPublicationId,
      "Projection publication ID",
    ),
    lciaResultPublicationId: requiredUuid(
      data.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    status: data.status,
    revokedAt: requiredTimestamp(data.revokedAt, "Revoked at"),
  };
  if (normalized.status !== "revoked")
    fail(
      "portal_lcia_projection_revoke_response_invalid",
      "Projection revoke response is not revoked",
    );
  return { ok: true, reused: response.reused, data: normalized };
}

function validatePackagePublicationPlan(plan) {
  assertExactObject(
    plan,
    [
      "schemaVersion",
      "status",
      "packagePublicationAuthorized",
      "targetEndpointFingerprint",
      "preparedByActorUserId",
      "publishPlanHash",
      "package",
      "projection",
      "artifacts",
      "displayDefaultImpactCategory",
      "currentProcessSetHash",
      "currentPublication",
      "requestedReason",
      "preparedAt",
    ],
    "portal_lcia_package_publication_plan_invalid",
    "Portal LCIA package publication plan",
  );
  if (
    plan.schemaVersion !== PACKAGE_PUBLICATION_PLAN_SCHEMA ||
    plan.status !== "ready_for_confirmation" ||
    plan.packagePublicationAuthorized !== false
  )
    fail(
      "portal_lcia_package_publication_plan_invalid",
      "Portal LCIA package publication plan has an unsupported schema or status",
    );
  requiredHash(plan.targetEndpointFingerprint, "Target endpoint fingerprint");
  requiredUuid(plan.preparedByActorUserId, "Preparing actor user ID");
  const evidence = validatePackagePublishPrepareResponse({
    ok: true,
    data: packagePublishPrepareEvidenceFromPlan(plan),
  });
  if (
    hashJson(evidence) !== hashJson(packagePublishPrepareEvidenceFromPlan(plan))
  )
    fail(
      "portal_lcia_package_publication_plan_invalid",
      "Package publication plan evidence is not canonical",
    );
  requiredText(plan.requestedReason, "Publication reason", 2000);
  requiredTimestamp(plan.preparedAt, "Prepared at");
  return plan;
}

function validatePackagePublicationReceipt(receipt, plan) {
  assertExactObject(
    receipt,
    [
      "schemaVersion",
      "status",
      "packagePublicationAuthorized",
      "independentlyReadBack",
      "disposition",
      "responseLossReconciled",
      "publishResponseReused",
      "packagePublicationPlanSha256",
      "databasePublishPlanHash",
      "freshPrepareEvidenceSha256",
      "freshPrepareMatched",
      "freshPreparePublishPlanHash",
      "freshPrepareCurrentPublication",
      "publishResponseSha256",
      "prepareReadbackSha256",
      "targetEndpointFingerprint",
      "executedByActorUserId",
      "publicationId",
      "packageId",
      "previousPublicationId",
      "isCurrent",
      "packageVersion",
      "packageResultHash",
      "buildWorkerJobId",
      "projectionContractVersion",
      "hashContractVersion",
      "inputManifestHash",
      "closureCertificateHash",
      "snapshotHash",
      "projectionId",
      "projectionContentHash",
      "processCount",
      "impactCount",
      "valueCount",
      "processAxisHash",
      "impactAxisHash",
      "valueGridHash",
      "relationHash",
      "bundleContentHash",
      "bundleManifestSha256",
      "lciaChunkSetSha256",
      "resultArtifactSha256",
      "queryArtifactSha256",
      "currentProcessSetHash",
      "currentPublicationPrecondition",
      "displayDefaultImpactCategory",
      "requestedReason",
      "reasonPersistence",
      "publishedAt",
      "recordedAt",
    ],
    "portal_lcia_package_publication_receipt_invalid",
    "Portal LCIA package publication receipt",
  );
  if (
    receipt.schemaVersion !== PACKAGE_PUBLICATION_RECEIPT_SCHEMA ||
    receipt.status !== "current" ||
    receipt.packagePublicationAuthorized !== true ||
    receipt.independentlyReadBack !== true ||
    receipt.isCurrent !== true ||
    !["published", "reused", "reconciled_after_response_loss"].includes(
      receipt.disposition,
    ) ||
    receipt.responseLossReconciled !==
      (receipt.disposition === "reconciled_after_response_loss") ||
    typeof receipt.publishResponseReused !== "boolean" ||
    typeof receipt.freshPrepareMatched !== "boolean" ||
    (!receipt.freshPrepareMatched && !receipt.publishResponseReused) ||
    (receipt.disposition === "published" && receipt.publishResponseReused) ||
    (receipt.disposition === "reused" && !receipt.publishResponseReused) ||
    receipt.reasonPersistence !==
      (receipt.publishResponseReused
        ? receipt.responseLossReconciled
          ? "unknown_after_response_loss"
          : "not_rewritten_on_reuse"
        : "recorded")
  )
    fail(
      "portal_lcia_package_publication_receipt_invalid",
      "Portal LCIA package publication receipt has an unsupported state",
    );
  requiredHash(
    receipt.packagePublicationPlanSha256,
    "Package publication plan hash",
  );
  requiredHash(receipt.databasePublishPlanHash, "Database publish plan hash");
  requiredHash(
    receipt.freshPrepareEvidenceSha256,
    "Fresh prepare evidence hash",
  );
  requiredHash(
    receipt.freshPreparePublishPlanHash,
    "Fresh Database publish plan hash",
  );
  validateCurrentPublicationPrecondition(
    receipt.freshPrepareCurrentPublication,
  );
  requiredHash(receipt.publishResponseSha256, "Publish response hash");
  requiredHash(receipt.prepareReadbackSha256, "Prepare readback hash");
  requiredHash(
    receipt.targetEndpointFingerprint,
    "Target endpoint fingerprint",
  );
  requiredUuid(receipt.executedByActorUserId, "Executing actor user ID");
  requiredUuid(receipt.publicationId, "Publication ID");
  requiredUuid(receipt.packageId, "Package ID");
  if (receipt.previousPublicationId !== null)
    requiredUuid(receipt.previousPublicationId, "Previous publication ID");
  requiredText(receipt.packageVersion, "Package version", 256);
  requiredHash(receipt.packageResultHash, "Package result hash");
  requiredUuid(receipt.buildWorkerJobId, "Build worker job ID");
  if (
    receipt.projectionContractVersion !== PROJECTION_CONTRACT ||
    receipt.hashContractVersion !== HASH_CONTRACT
  )
    fail(
      "portal_lcia_package_publication_receipt_invalid",
      "Package publication readback has unsupported projection contracts",
    );
  requiredHash(receipt.inputManifestHash, "Input manifest hash");
  requiredHash(receipt.closureCertificateHash, "Closure certificate hash");
  requiredHash(receipt.snapshotHash, "Snapshot hash");
  requiredUuid(receipt.projectionId, "Projection ID");
  requiredHash(receipt.projectionContentHash, "Projection content hash");
  const processCount = requiredPositiveInteger(
    receipt.processCount,
    "Process count",
  );
  const impactCount = requiredPositiveInteger(
    receipt.impactCount,
    "Impact count",
  );
  if (
    requiredPositiveInteger(receipt.valueCount, "Value count") !==
    processCount * impactCount
  )
    fail(
      "portal_lcia_package_publication_receipt_invalid",
      "Package publication readback has an inconsistent projection grid",
    );
  requiredHash(receipt.processAxisHash, "Process axis hash");
  requiredHash(receipt.impactAxisHash, "Impact axis hash");
  requiredHash(receipt.valueGridHash, "Value grid hash");
  requiredHash(receipt.relationHash, "Relation hash");
  requiredHash(receipt.bundleContentHash, "Bundle content hash");
  requiredHash(receipt.bundleManifestSha256, "Bundle manifest SHA-256");
  requiredHash(receipt.lciaChunkSetSha256, "LCIA chunk-set SHA-256");
  requiredHash(receipt.resultArtifactSha256, "Result artifact SHA-256");
  requiredHash(receipt.queryArtifactSha256, "Query artifact SHA-256");
  requiredHash(receipt.currentProcessSetHash, "Current Process-set hash");
  validateCurrentPublicationPrecondition(
    receipt.currentPublicationPrecondition,
  );
  requiredText(
    receipt.displayDefaultImpactCategory,
    "Display default impact category",
    512,
  );
  requiredText(receipt.requestedReason, "Publication reason", 2000);
  requiredTimestamp(receipt.publishedAt, "Published at");
  requiredTimestamp(receipt.recordedAt, "Recorded at");
  const reconstructedFreshPrepare = {
    ...packagePublishPrepareEvidenceFromPlan(plan),
    publishPlanHash: receipt.freshPreparePublishPlanHash,
    currentPublication: receipt.freshPrepareCurrentPublication,
  };
  const reconstructedPublishResponse = {
    ok: true,
    reused: receipt.publishResponseReused,
    data: {
      publicationId: receipt.publicationId,
      packageId: receipt.packageId,
      previousPublicationId: receipt.previousPublicationId,
      isCurrent: receipt.isCurrent,
      packageVersion: receipt.packageVersion,
      projectionId: receipt.projectionId,
      projectionContentHash: receipt.projectionContentHash,
      publishedAt: receipt.publishedAt,
      publishPlanHash: receipt.databasePublishPlanHash,
    },
  };
  const reconstructedPrepareReadback = {
    projectionId: receipt.projectionId,
    buildWorkerJobId: receipt.buildWorkerJobId,
    packageId: receipt.packageId,
    lciaResultPublicationId: receipt.publicationId,
    packageVersion: receipt.packageVersion,
    packageResultHash: receipt.packageResultHash,
    status: "prepared",
    projectionContractVersion: receipt.projectionContractVersion,
    hashContractVersion: receipt.hashContractVersion,
    processCount: receipt.processCount,
    impactCount: receipt.impactCount,
    valueCount: receipt.valueCount,
    processAxisHash: receipt.processAxisHash,
    impactAxisHash: receipt.impactAxisHash,
    valueGridHash: receipt.valueGridHash,
    relationHash: receipt.relationHash,
    contentHash: receipt.projectionContentHash,
    publishedAt: receipt.publishedAt,
  };
  if (
    receipt.packagePublicationPlanSha256 !== hashJson(plan) ||
    receipt.databasePublishPlanHash !== plan.publishPlanHash ||
    receipt.freshPrepareEvidenceSha256 !==
      hashJson(reconstructedFreshPrepare) ||
    receipt.freshPrepareMatched !==
      (hashJson(reconstructedFreshPrepare) ===
        hashJson(packagePublishPrepareEvidenceFromPlan(plan))) ||
    receipt.publishResponseSha256 !== hashJson(reconstructedPublishResponse) ||
    receipt.prepareReadbackSha256 !== hashJson(reconstructedPrepareReadback) ||
    receipt.targetEndpointFingerprint !== plan.targetEndpointFingerprint ||
    receipt.executedByActorUserId !== plan.preparedByActorUserId ||
    receipt.packageId !== plan.package.id ||
    receipt.previousPublicationId !==
      (plan.currentPublication?.publicationId ?? null) ||
    receipt.packageVersion !== plan.package.version ||
    receipt.packageResultHash !== plan.package.resultHash ||
    receipt.inputManifestHash !== plan.package.inputManifestHash ||
    receipt.closureCertificateHash !== plan.package.closureCertificateHash ||
    receipt.snapshotHash !== plan.package.snapshotHash ||
    receipt.projectionId !== plan.projection.id ||
    receipt.projectionContentHash !== plan.projection.contentHash ||
    receipt.processCount !== plan.package.processCount ||
    receipt.impactCount !== plan.package.impactCount ||
    receipt.valueCount !== plan.package.valueCount ||
    receipt.processAxisHash !== plan.projection.processAxisHash ||
    receipt.impactAxisHash !== plan.projection.impactAxisHash ||
    receipt.valueGridHash !== plan.projection.valueGridHash ||
    receipt.relationHash !== plan.projection.relationHash ||
    receipt.bundleContentHash !== plan.artifacts.bundleContentHash ||
    receipt.bundleManifestSha256 !== plan.artifacts.bundleManifestSha256 ||
    receipt.lciaChunkSetSha256 !== plan.artifacts.lciaChunkSetSha256 ||
    receipt.resultArtifactSha256 !== plan.artifacts.resultArtifactSha256 ||
    receipt.queryArtifactSha256 !== plan.artifacts.queryArtifactSha256 ||
    receipt.currentProcessSetHash !== plan.currentProcessSetHash ||
    hashJson(receipt.currentPublicationPrecondition) !==
      hashJson(plan.currentPublication) ||
    receipt.displayDefaultImpactCategory !==
      plan.displayDefaultImpactCategory ||
    receipt.requestedReason !== plan.requestedReason
  )
    fail(
      "portal_lcia_package_publication_receipt_invalid",
      "Package publication receipt does not match the confirmed plan",
    );
  return receipt;
}

function validatePlan(plan) {
  assertExactObject(
    plan,
    [
      "schemaVersion",
      "status",
      "projectionFinalizationAuthorized",
      "packagePublicationReceiptSha256",
      "targetEndpointFingerprint",
      "preparedByActorUserId",
      "projectionId",
      "buildWorkerJobId",
      "packageId",
      "lciaResultPublicationId",
      "packageVersion",
      "packageResultHash",
      "projectionContractVersion",
      "hashContractVersion",
      "processCount",
      "impactCount",
      "valueCount",
      "processAxisHash",
      "impactAxisHash",
      "valueGridHash",
      "relationHash",
      "projectionContentHash",
      "sourcePublishedAt",
      "idempotencyKey",
      "preparedAt",
    ],
    "portal_lcia_projection_plan_invalid",
    "Portal LCIA projection plan",
  );
  if (
    plan.schemaVersion !== PLAN_SCHEMA ||
    plan.status !== "ready_for_confirmation" ||
    plan.projectionFinalizationAuthorized !== false ||
    plan.projectionContractVersion !== PROJECTION_CONTRACT ||
    plan.hashContractVersion !== HASH_CONTRACT
  )
    fail(
      "portal_lcia_projection_plan_invalid",
      "Portal LCIA projection plan has an unsupported schema, status, or contract",
    );
  requiredHash(plan.targetEndpointFingerprint, "Target endpoint fingerprint");
  requiredHash(
    plan.packagePublicationReceiptSha256,
    "Package publication receipt hash",
  );
  requiredUuid(plan.preparedByActorUserId, "Preparing actor user ID");
  requiredUuid(plan.projectionId, "Projection ID");
  requiredUuid(plan.buildWorkerJobId, "Build worker job ID");
  requiredUuid(plan.packageId, "Package ID");
  requiredUuid(plan.lciaResultPublicationId, "LCIA result publication ID");
  requiredText(plan.packageVersion, "Package version", 256);
  requiredHash(plan.packageResultHash, "Package result hash");
  requiredHash(plan.processAxisHash, "Process axis hash");
  requiredHash(plan.impactAxisHash, "Impact axis hash");
  requiredHash(plan.valueGridHash, "Value grid hash");
  requiredHash(plan.relationHash, "Relation hash");
  requiredHash(plan.projectionContentHash, "Projection content hash");
  const processCount = requiredPositiveInteger(
    plan.processCount,
    "Process count",
  );
  const impactCount = requiredPositiveInteger(plan.impactCount, "Impact count");
  if (
    requiredPositiveInteger(plan.valueCount, "Value count") !==
    processCount * impactCount
  )
    fail(
      "portal_lcia_projection_plan_invalid",
      "Projection plan value count does not equal the process-impact grid",
    );
  requiredTimestamp(plan.sourcePublishedAt, "Source published at");
  requiredTimestamp(plan.preparedAt, "Prepared at");
  if (plan.idempotencyKey !== projectionIdempotencyKey(plan))
    fail(
      "portal_lcia_projection_plan_invalid",
      "Projection plan idempotency key does not match its exact evidence",
    );
  return plan;
}

function validateFinalizationReceipt(receipt, plan) {
  assertExactObject(
    receipt,
    [
      "schemaVersion",
      "status",
      "projectionFinalizationAuthorized",
      "independentReadbackVerified",
      "disposition",
      "projectionPlanSha256",
      "freshPrepareEvidenceSha256",
      "reconciliationReadbackSha256",
      "targetEndpointFingerprint",
      "finalizedByActorUserId",
      "projectionPublicationId",
      "projectionId",
      "lciaResultPublicationId",
      "packageId",
      "packageVersion",
      "packageResultHash",
      "projectionContentHash",
      "evidenceHash",
      "processCount",
      "impactCount",
      "valueCount",
      "sourcePublishedAt",
      "idempotencyKey",
      "finalizedAt",
      "recordedAt",
    ],
    "portal_lcia_projection_finalization_receipt_invalid",
    "Portal LCIA projection finalization receipt",
  );
  if (
    receipt.schemaVersion !== FINALIZATION_SCHEMA ||
    receipt.status !== "finalized" ||
    receipt.projectionFinalizationAuthorized !== true ||
    receipt.independentReadbackVerified !== false ||
    !["created", "reused", "reconciled_after_response_loss"].includes(
      receipt.disposition,
    )
  )
    fail(
      "portal_lcia_projection_finalization_receipt_invalid",
      "Projection finalization receipt has an unsupported state",
    );
  requiredHash(receipt.projectionPlanSha256, "Projection plan hash");
  requiredHash(
    receipt.freshPrepareEvidenceSha256,
    "Fresh prepare evidence hash",
  );
  if (receipt.reconciliationReadbackSha256 !== null)
    requiredHash(
      receipt.reconciliationReadbackSha256,
      "Reconciliation readback hash",
    );
  if (
    (receipt.disposition === "reconciled_after_response_loss") !==
    (receipt.reconciliationReadbackSha256 !== null)
  )
    fail(
      "portal_lcia_projection_finalization_receipt_invalid",
      "Projection finalization reconciliation evidence is inconsistent",
    );
  requiredHash(receipt.targetEndpointFingerprint, "Target fingerprint");
  requiredUuid(receipt.finalizedByActorUserId, "Finalizing actor user ID");
  requiredUuid(receipt.projectionPublicationId, "Projection publication ID");
  requiredUuid(receipt.projectionId, "Projection ID");
  requiredUuid(receipt.lciaResultPublicationId, "LCIA result publication ID");
  requiredUuid(receipt.packageId, "Package ID");
  requiredText(receipt.packageVersion, "Package version", 256);
  requiredHash(receipt.packageResultHash, "Package result hash");
  requiredHash(receipt.projectionContentHash, "Projection content hash");
  requiredHash(receipt.evidenceHash, "Projection evidence hash");
  requiredPositiveInteger(receipt.processCount, "Process count");
  requiredPositiveInteger(receipt.impactCount, "Impact count");
  requiredPositiveInteger(receipt.valueCount, "Value count");
  requiredTimestamp(receipt.sourcePublishedAt, "Source published at");
  requiredTimestamp(receipt.finalizedAt, "Finalized at");
  requiredTimestamp(receipt.recordedAt, "Recorded at");
  if (
    receipt.projectionPlanSha256 !== hashJson(plan) ||
    receipt.targetEndpointFingerprint !== plan.targetEndpointFingerprint ||
    receipt.finalizedByActorUserId !== plan.preparedByActorUserId ||
    receipt.projectionId !== plan.projectionId ||
    receipt.lciaResultPublicationId !== plan.lciaResultPublicationId ||
    receipt.packageId !== plan.packageId ||
    receipt.packageVersion !== plan.packageVersion ||
    receipt.packageResultHash !== plan.packageResultHash ||
    receipt.projectionContentHash !== plan.projectionContentHash ||
    receipt.processCount !== plan.processCount ||
    receipt.impactCount !== plan.impactCount ||
    receipt.valueCount !== plan.valueCount ||
    receipt.sourcePublishedAt !== plan.sourcePublishedAt ||
    receipt.idempotencyKey !== plan.idempotencyKey
  )
    fail(
      "portal_lcia_projection_finalization_receipt_invalid",
      "Projection finalization receipt does not match the confirmed plan",
    );
  return receipt;
}

function validateReadbackReceipt(receipt, artifacts) {
  assertExactObject(
    receipt,
    [
      "schemaVersion",
      "status",
      "independentlyQueried",
      "isCurrent",
      "isPubliclyVisible",
      "projectionPlanSha256",
      "finalizationReceiptSha256",
      "targetEndpointFingerprint",
      "verifiedByActorUserId",
      "projectionPublicationId",
      "projectionId",
      "lciaResultPublicationId",
      "packageId",
      "packageVersion",
      "projectionContentHash",
      "evidenceHash",
      "processCount",
      "impactCount",
      "valueCount",
      "sourcePublishedAt",
      "finalizedAt",
      "verifiedAt",
    ],
    "portal_lcia_projection_readback_receipt_invalid",
    "Portal LCIA projection readback receipt",
  );
  if (
    receipt.schemaVersion !== READBACK_SCHEMA ||
    receipt.status !== "verified" ||
    receipt.independentlyQueried !== true ||
    receipt.isCurrent !== true ||
    receipt.isPubliclyVisible !== true ||
    receipt.projectionPlanSha256 !== artifacts.planSha256 ||
    receipt.finalizationReceiptSha256 !== artifacts.finalizationReceiptSha256
  )
    fail(
      "portal_lcia_projection_readback_receipt_invalid",
      "Projection readback receipt has invalid status or hash bindings",
    );
  requiredHash(receipt.targetEndpointFingerprint, "Target fingerprint");
  requiredUuid(receipt.verifiedByActorUserId, "Verifying actor user ID");
  requiredUuid(receipt.projectionPublicationId, "Projection publication ID");
  requiredUuid(receipt.projectionId, "Projection ID");
  requiredUuid(receipt.lciaResultPublicationId, "LCIA result publication ID");
  requiredUuid(receipt.packageId, "Package ID");
  requiredText(receipt.packageVersion, "Package version", 256);
  requiredHash(receipt.projectionContentHash, "Projection content hash");
  requiredHash(receipt.evidenceHash, "Projection evidence hash");
  requiredPositiveInteger(receipt.processCount, "Process count");
  requiredPositiveInteger(receipt.impactCount, "Impact count");
  requiredPositiveInteger(receipt.valueCount, "Value count");
  requiredTimestamp(receipt.sourcePublishedAt, "Source published at");
  requiredTimestamp(receipt.finalizedAt, "Finalized at");
  requiredTimestamp(receipt.verifiedAt, "Verified at");
  return receipt;
}

function validateRevocationReceipt(receipt, artifacts) {
  assertExactObject(
    receipt,
    [
      "schemaVersion",
      "status",
      "independentlyQueried",
      "isCurrent",
      "isPubliclyVisible",
      "disposition",
      "projectionPlanSha256",
      "finalizationReceiptSha256",
      "revokeResponseSha256",
      "revocationReadbackSha256",
      "targetEndpointFingerprint",
      "revokedByActorUserId",
      "projectionPublicationId",
      "projectionId",
      "lciaResultPublicationId",
      "packageId",
      "packageVersion",
      "projectionContentHash",
      "evidenceHash",
      "requestedReason",
      "reasonPersistence",
      "revokedAt",
      "verifiedAt",
    ],
    "portal_lcia_projection_revocation_receipt_invalid",
    "Portal LCIA projection revocation receipt",
  );
  if (
    receipt.schemaVersion !== REVOCATION_SCHEMA ||
    receipt.status !== "revoked" ||
    receipt.independentlyQueried !== true ||
    receipt.isCurrent !== false ||
    receipt.isPubliclyVisible !== false ||
    !["revoked", "reused", "reconciled_after_response_loss"].includes(
      receipt.disposition,
    ) ||
    receipt.reasonPersistence !==
      (receipt.disposition === "revoked"
        ? "recorded"
        : receipt.disposition === "reused"
          ? "not_rewritten_on_reuse"
          : "unknown_after_response_loss") ||
    receipt.projectionPlanSha256 !== artifacts.planSha256 ||
    receipt.finalizationReceiptSha256 !== artifacts.finalizationReceiptSha256
  )
    fail(
      "portal_lcia_projection_revocation_receipt_invalid",
      "Projection revocation receipt has invalid status or hash bindings",
    );
  if (receipt.revokeResponseSha256 !== null)
    requiredHash(receipt.revokeResponseSha256, "Revoke response hash");
  if (
    (receipt.disposition === "reconciled_after_response_loss") !==
    (receipt.revokeResponseSha256 === null)
  )
    fail(
      "portal_lcia_projection_revocation_receipt_invalid",
      "Projection revocation response evidence is inconsistent",
    );
  requiredHash(receipt.revocationReadbackSha256, "Revocation readback hash");
  requiredHash(receipt.targetEndpointFingerprint, "Target fingerprint");
  requiredUuid(receipt.revokedByActorUserId, "Revoking actor user ID");
  requiredUuid(receipt.projectionPublicationId, "Projection publication ID");
  requiredUuid(receipt.projectionId, "Projection ID");
  requiredUuid(receipt.lciaResultPublicationId, "LCIA result publication ID");
  requiredUuid(receipt.packageId, "Package ID");
  requiredText(receipt.packageVersion, "Package version", 256);
  requiredHash(receipt.projectionContentHash, "Projection content hash");
  requiredHash(receipt.evidenceHash, "Projection evidence hash");
  requiredText(receipt.requestedReason, "Requested reason", 2000);
  requiredTimestamp(receipt.revokedAt, "Revoked at");
  requiredTimestamp(receipt.verifiedAt, "Verified at");
  return receipt;
}

function assertPackagePublicationPlanTarget(plan, runtime) {
  if (runtime.targetEndpointFingerprint !== plan.targetEndpointFingerprint)
    fail(
      "portal_lcia_package_publication_target_mismatch",
      "LCIA package publication target differs from the confirmed plan",
    );
  if (runtime.actorUserId !== plan.preparedByActorUserId)
    fail(
      "portal_lcia_package_publication_actor_mismatch",
      "LCIA package publication actor differs from the preparing actor",
    );
}

function assertPackagePublicationReceiptTarget(receipt, runtime) {
  if (runtime.targetEndpointFingerprint !== receipt.targetEndpointFingerprint)
    fail(
      "portal_lcia_package_publication_target_mismatch",
      "Projection preparation target differs from the package publication receipt",
    );
}

function assertPackagePublishedMatchesPlan(published, plan) {
  if (
    published.packageId !== plan.package.id ||
    published.packageVersion !== plan.package.version ||
    published.projectionId !== plan.projection.id ||
    published.projectionContentHash !== plan.projection.contentHash ||
    published.publishPlanHash !== plan.publishPlanHash ||
    published.previousPublicationId !==
      (plan.currentPublication?.publicationId ?? null) ||
    published.isCurrent !== true
  )
    fail(
      "portal_lcia_package_publication_identity_mismatch",
      "LCIA package publication returned evidence outside the confirmed plan",
    );
}

function assertPackageReuseFreshEvidence({ freshPrepared, plan, published }) {
  const expectedCurrentPublication = {
    publicationId: published.publicationId,
    packageId: published.packageId,
    packageVersion: published.packageVersion,
    publishedAt: published.publishedAt,
  };
  if (
    hashJson(freshPrepared.package) !== hashJson(plan.package) ||
    hashJson(freshPrepared.projection) !== hashJson(plan.projection) ||
    hashJson(freshPrepared.artifacts) !== hashJson(plan.artifacts) ||
    freshPrepared.displayDefaultImpactCategory !==
      plan.displayDefaultImpactCategory ||
    freshPrepared.currentProcessSetHash !== plan.currentProcessSetHash ||
    hashJson(freshPrepared.currentPublication) !==
      hashJson(expectedCurrentPublication)
  )
    fail(
      "portal_lcia_package_publication_reuse_evidence_mismatch",
      "Reused package publication no longer matches the confirmed immutable evidence or expected current publication",
    );
}

function assertPackagePublicationReadbackMatches({
  published,
  prepared,
  plan,
}) {
  if (
    prepared.packageId !== published.packageId ||
    prepared.lciaResultPublicationId !== published.publicationId ||
    prepared.packageVersion !== published.packageVersion ||
    prepared.projectionId !== published.projectionId ||
    prepared.contentHash !== published.projectionContentHash ||
    prepared.packageResultHash !== plan.package.resultHash ||
    prepared.processCount !== plan.package.processCount ||
    prepared.impactCount !== plan.package.impactCount ||
    prepared.valueCount !== plan.package.valueCount ||
    prepared.processAxisHash !== plan.projection.processAxisHash ||
    prepared.impactAxisHash !== plan.projection.impactAxisHash ||
    prepared.valueGridHash !== plan.projection.valueGridHash ||
    prepared.relationHash !== plan.projection.relationHash ||
    prepared.publishedAt !== published.publishedAt
  )
    fail(
      "portal_lcia_package_publication_readback_mismatch",
      "Independent package publication readback differs from the publish response",
    );
}

function assertProjectionPrepareMatchesPackagePublication(prepared, receipt) {
  if (
    prepared.packageId !== receipt.packageId ||
    prepared.lciaResultPublicationId !== receipt.publicationId ||
    prepared.packageVersion !== receipt.packageVersion ||
    prepared.packageResultHash !== receipt.packageResultHash ||
    prepared.projectionId !== receipt.projectionId ||
    prepared.contentHash !== receipt.projectionContentHash ||
    prepared.processCount !== receipt.processCount ||
    prepared.impactCount !== receipt.impactCount ||
    prepared.valueCount !== receipt.valueCount ||
    prepared.processAxisHash !== receipt.processAxisHash ||
    prepared.impactAxisHash !== receipt.impactAxisHash ||
    prepared.valueGridHash !== receipt.valueGridHash ||
    prepared.relationHash !== receipt.relationHash ||
    prepared.publishedAt !== receipt.publishedAt
  )
    fail(
      "portal_lcia_projection_package_publication_drift",
      "Projection preparation differs from the exact package publication receipt",
    );
}

function assertPlanTarget(
  plan,
  runtime,
  { requirePreparingActor = false } = {},
) {
  if (runtime.targetEndpointFingerprint !== plan.targetEndpointFingerprint)
    fail(
      "portal_lcia_projection_target_mismatch",
      "Projection command target differs from the prepared target",
    );
  if (
    requirePreparingActor &&
    runtime.actorUserId !== plan.preparedByActorUserId
  )
    fail(
      "portal_lcia_projection_actor_mismatch",
      "Projection finalization actor differs from the preparing actor",
    );
}

function assertFinalizedMatchesPlan(finalized, plan) {
  if (
    finalized.projectionId !== plan.projectionId ||
    finalized.lciaResultPublicationId !== plan.lciaResultPublicationId ||
    finalized.packageId !== plan.packageId ||
    finalized.contentHash !== plan.projectionContentHash
  )
    fail(
      "portal_lcia_projection_finalize_identity_mismatch",
      "Projection finalization returned evidence outside the confirmed plan",
    );
}

function assertRevokedMatchesPlan(revoked, plan, finalizationReceipt) {
  if (
    revoked.lciaResultPublicationId !== plan.lciaResultPublicationId ||
    revoked.projectionPublicationId !==
      finalizationReceipt.projectionPublicationId
  )
    fail(
      "portal_lcia_projection_revoke_identity_mismatch",
      "Projection revocation returned a different publication identity",
    );
}

function assertReadbackMatchesFinalization({
  readback,
  plan,
  finalizationReceipt,
  requireCurrent,
  requiredStatus,
}) {
  assertReadbackMatchesPlan(readback, plan, {
    requireCurrent,
    requiredStatus,
  });
  if (
    readback.projectionPublicationId !==
      finalizationReceipt.projectionPublicationId ||
    readback.evidenceHash !== finalizationReceipt.evidenceHash ||
    readback.finalizedAt !== finalizationReceipt.finalizedAt
  )
    fail(
      "portal_lcia_projection_readback_mismatch",
      "Projection readback differs from the finalization receipt",
    );
}

function assertReadbackMatchesPlan(
  readback,
  plan,
  { requireCurrent, requiredStatus },
) {
  const statuses = Array.isArray(requiredStatus)
    ? requiredStatus
    : [requiredStatus];
  if (
    readback.projectionId !== plan.projectionId ||
    readback.lciaResultPublicationId !== plan.lciaResultPublicationId ||
    readback.packageId !== plan.packageId ||
    readback.packageVersion !== plan.packageVersion ||
    readback.contentHash !== plan.projectionContentHash ||
    readback.processCount !== plan.processCount ||
    readback.impactCount !== plan.impactCount ||
    readback.valueCount !== plan.valueCount
  )
    fail(
      "portal_lcia_projection_readback_mismatch",
      "Projection readback differs from the exact package or projection evidence",
    );
  if (!statuses.includes(readback.status))
    fail(
      "portal_lcia_projection_lifecycle_mismatch",
      "Projection readback returned an unexpected lifecycle status",
      { expected: statuses, observed: readback.status },
    );
  if (
    requireCurrent &&
    (readback.isCurrent !== true || readback.isPubliclyVisible !== true)
  )
    fail(
      "portal_lcia_projection_publication_not_current",
      "Projection is finalized but is not both current and publicly visible",
    );
  if (readback.status === "revoked" && readback.isCurrent !== false)
    fail(
      "portal_lcia_projection_lifecycle_mismatch",
      "A revoked projection cannot remain current",
    );
}

function finalizeDataFromReadback(readback) {
  return {
    projectionPublicationId: readback.projectionPublicationId,
    projectionId: readback.projectionId,
    lciaResultPublicationId: readback.lciaResultPublicationId,
    packageId: readback.packageId,
    status: readback.status,
    contentHash: readback.contentHash,
    evidenceHash: readback.evidenceHash,
    finalizedAt: readback.finalizedAt,
  };
}

function projectionIdempotencyKey(value) {
  return `portal-lcia-finalize-v1:${hashJson({
    schemaVersion: "tiangong.release.portal-lcia-projection-idempotency.v1",
    projectionId: value.projectionId,
    packageId: value.packageId,
    lciaResultPublicationId: value.lciaResultPublicationId,
    packageVersion: value.packageVersion,
    packageResultHash: value.packageResultHash,
    projectionContentHash: value.contentHash ?? value.projectionContentHash,
  })}`;
}

function packagePublishPrepareEvidenceFromPlan(plan) {
  return {
    publishPlanHash: plan.publishPlanHash,
    package: plan.package,
    projection: plan.projection,
    artifacts: plan.artifacts,
    displayDefaultImpactCategory: plan.displayDefaultImpactCategory,
    currentProcessSetHash: plan.currentProcessSetHash,
    currentPublication: plan.currentPublication,
  };
}

function prepareEvidence(value) {
  return {
    projectionId: value.projectionId,
    buildWorkerJobId: value.buildWorkerJobId,
    packageId: value.packageId,
    lciaResultPublicationId: value.lciaResultPublicationId,
    packageVersion: value.packageVersion,
    packageResultHash: value.packageResultHash,
    projectionContractVersion: value.projectionContractVersion,
    hashContractVersion: value.hashContractVersion,
    processCount: value.processCount,
    impactCount: value.impactCount,
    valueCount: value.valueCount,
    processAxisHash: value.processAxisHash,
    impactAxisHash: value.impactAxisHash,
    valueGridHash: value.valueGridHash,
    relationHash: value.relationHash,
    projectionContentHash: value.contentHash,
    sourcePublishedAt: value.publishedAt,
  };
}

function planEvidence(plan) {
  return {
    projectionId: plan.projectionId,
    buildWorkerJobId: plan.buildWorkerJobId,
    packageId: plan.packageId,
    lciaResultPublicationId: plan.lciaResultPublicationId,
    packageVersion: plan.packageVersion,
    packageResultHash: plan.packageResultHash,
    projectionContractVersion: plan.projectionContractVersion,
    hashContractVersion: plan.hashContractVersion,
    processCount: plan.processCount,
    impactCount: plan.impactCount,
    valueCount: plan.valueCount,
    processAxisHash: plan.processAxisHash,
    impactAxisHash: plan.impactAxisHash,
    valueGridHash: plan.valueGridHash,
    relationHash: plan.relationHash,
    projectionContentHash: plan.projectionContentHash,
    sourcePublishedAt: plan.sourcePublishedAt,
  };
}

function requiredUuid(value, label) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!UUID_PATTERN.test(normalized))
    fail("portal_lcia_projection_contract_invalid", `${label} must be a UUID`);
  return normalized;
}

function requiredHash(value, label) {
  const normalized = String(value ?? "").trim();
  if (!HASH_PATTERN.test(normalized))
    fail(
      "portal_lcia_projection_contract_invalid",
      `${label} must be a lowercase SHA-256`,
    );
  return normalized;
}

function requiredText(value, label, maximumLength) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximumLength)
    fail(
      "portal_lcia_projection_contract_invalid",
      `${label} must contain 1-${maximumLength} characters`,
    );
  return normalized;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1)
    fail(
      "portal_lcia_projection_contract_invalid",
      `${label} must be a positive safe integer`,
    );
  return value;
}

function requiredTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !UTC_TIMESTAMP_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    fail(
      "portal_lcia_projection_contract_invalid",
      `${label} must be a UTC ISO-8601 timestamp with at most microsecond precision`,
    );
  return value;
}
