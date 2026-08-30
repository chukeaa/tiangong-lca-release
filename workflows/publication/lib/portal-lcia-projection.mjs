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
const EVENT_SCHEMA = "tiangong.release.portal-lcia-publication-event.v1";
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
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventType: "package_published",
    parentArtifactSha256: artifacts.planSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    actorUserId: runtime.actorUserId,
    disposition,
    subject: {
      packageId: published.data.packageId,
      projectionId: published.data.projectionId,
      lciaResultPublicationId: published.data.publicationId,
      projectionPublicationId: null,
      packageVersion: published.data.packageVersion,
      projectionContentHash: published.data.projectionContentHash,
    },
    observation: {
      status: "current",
      isCurrent: true,
      independentlyReadBack: true,
      databasePublishPlanHash: artifacts.plan.publishPlanHash,
      previousPublicationId: published.data.previousPublicationId,
      publishedAt: published.data.publishedAt,
      reasonPersistence:
        published.reused && responseLossReconciled
          ? "unknown_after_response_loss"
          : published.reused
            ? "not_rewritten_on_reuse"
            : "recorded",
    },
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validatePackagePublishedEvent(event, artifacts.plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "portal-lcia-package-publication-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-package-published-event.json"),
      event,
    );
  });
  return {
    path: target,
    plan: artifacts.plan,
    event,
    eventSha256: hashJson(event),
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
  assertPackagePublishedEventTarget(publication.event, runtime);
  const response = await invokeProjectionPrepare({
    runtime,
    packageId: publication.event.subject.packageId,
    lciaResultPublicationId: publication.event.subject.lciaResultPublicationId,
    fetchImpl,
  });
  const prepared = validatePrepareResponse(response);
  assertProjectionPrepareMatchesPackagePublication(prepared, {
    plan: publication.plan,
    event: publication.event,
  });
  const preparedAt = requiredTimestamp(now().toISOString(), "Prepared at");
  const idempotencyKey = projectionIdempotencyKey(prepared);
  const plan = {
    schemaVersion: PLAN_SCHEMA,
    status: "ready_for_confirmation",
    projectionFinalizationAuthorized: false,
    packagePublishedEventSha256: publication.eventSha256,
    targetEndpointFingerprint: runtime.targetEndpointFingerprint,
    preparedByActorUserId: runtime.actorUserId,
    projection: prepareEvidence(prepared),
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
      path.join(staging, "portal-lcia-package-published-event.json"),
      publication.event,
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
    packageId: artifacts.plan.projection.packageId,
    lciaResultPublicationId: artifacts.plan.projection.lciaResultPublicationId,
    fetchImpl,
  });
  const freshPrepared = validatePrepareResponse(prepareResponse);
  if (
    hashJson(prepareEvidence(freshPrepared)) !==
    hashJson(artifacts.plan.projection)
  )
    fail(
      "portal_lcia_projection_prepare_drift",
      "Projection evidence changed after the confirmed plan was prepared",
    );

  const audit = {
    schemaVersion: "tiangong.release.portal-lcia-projection-finalize-audit.v1",
    projectionPlanSha256: artifacts.planSha256,
  };
  let finalized;
  let disposition;
  try {
    const finalizeResponse = await invokeProjectionRpc({
      runtime,
      functionName: "cmd_portal_lcia_projection_finalize_publication_v1",
      body: {
        p_projection_id: artifacts.plan.projection.projectionId,
        p_lcia_result_publication_id:
          artifacts.plan.projection.lciaResultPublicationId,
        p_package_version: artifacts.plan.projection.packageVersion,
        p_package_result_hash: artifacts.plan.projection.packageResultHash,
        p_projection_content_hash:
          artifacts.plan.projection.projectionContentHash,
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
  }

  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventType: "projection_finalized",
    parentArtifactSha256: artifacts.planSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    actorUserId: runtime.actorUserId,
    disposition,
    subject: projectionSubject(artifacts.plan, {
      projectionPublicationId: finalized.projectionPublicationId,
    }),
    observation: {
      status: "finalized",
      independentReadbackVerified: false,
      evidenceHash: finalized.evidenceHash,
      finalizedAt: finalized.finalizedAt,
    },
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validateProjectionFinalizedEvent(event, artifacts.plan);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalized-event.json"),
      event,
    );
  });
  return {
    path: target,
    plan: artifacts.plan,
    event,
    eventSha256: hashJson(event),
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
    finalizationEvent: artifacts.finalizationEvent,
    requireCurrent: true,
    requiredStatus: "finalized",
  });
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventType: "projection_verified",
    parentArtifactSha256: artifacts.finalizationEventSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    actorUserId: runtime.actorUserId,
    disposition: "observed",
    subject: projectionSubject(artifacts.plan, {
      projectionPublicationId: readback.projectionPublicationId,
    }),
    observation: {
      status: "verified",
      isCurrent: true,
      isPubliclyVisible: true,
      evidenceHash: readback.evidenceHash,
      finalizedAt: readback.finalizedAt,
    },
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validateProjectionVerifiedEvent(event, artifacts);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalized-event.json"),
      artifacts.finalizationEvent,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-verified-event.json"),
      event,
    );
  });
  return {
    path: target,
    plan: artifacts.plan,
    event,
    eventSha256: hashJson(event),
  };
}

export async function revokePortalLciaProjectionPublication({
  finalizationDir,
  outDir,
  confirmFinalizedEventSha256,
  reason,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const artifacts = await loadFinalizationArtifacts(finalizationDir);
  if (confirmFinalizedEventSha256 !== artifacts.finalizationEventSha256)
    fail(
      "portal_lcia_projection_revoke_confirmation_mismatch",
      "Projection revocation confirmation must exactly match the finalized-event SHA-256",
      {
        expected: artifacts.finalizationEventSha256,
        received: confirmFinalizedEventSha256 ?? null,
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
    finalizationEvent: artifacts.finalizationEvent,
    requireCurrent: false,
    requiredStatus: ["finalized", "revoked"],
  });

  const audit = {
    schemaVersion: "tiangong.release.portal-lcia-projection-revoke-audit.v1",
    finalizationEventSha256: artifacts.finalizationEventSha256,
  };
  let disposition;
  try {
    const response = await invokeProjectionRpc({
      runtime,
      functionName: "cmd_portal_lcia_projection_revoke_publication_v1",
      body: {
        p_lcia_result_publication_id:
          artifacts.plan.projection.lciaResultPublicationId,
        p_projection_content_hash:
          artifacts.plan.projection.projectionContentHash,
        p_reason: normalizedReason,
        p_audit: audit,
      },
      fetchImpl,
    });
    const revoked = validateRevokeResponse(response);
    assertRevokedMatchesPlan(
      revoked.data,
      artifacts.plan,
      artifacts.finalizationEvent,
    );
    disposition = revoked.reused ? "reused" : "revoked";
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
      finalizationEvent: artifacts.finalizationEvent,
      requireCurrent: false,
      requiredStatus: "revoked",
    });
  } catch (error) {
    error.details = {
      ...(error.details ?? {}),
      safeRetry: true,
      finalizationEventSha256: artifacts.finalizationEventSha256,
    };
    throw error;
  }
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventType: "projection_revoked",
    parentArtifactSha256: artifacts.finalizationEventSha256,
    targetEndpointFingerprint: artifacts.plan.targetEndpointFingerprint,
    actorUserId: runtime.actorUserId,
    disposition,
    subject: projectionSubject(artifacts.plan, {
      projectionPublicationId: after.projectionPublicationId,
    }),
    observation: {
      status: "revoked",
      isCurrent: false,
      isPubliclyVisible: false,
      evidenceHash: after.evidenceHash,
      requestedReason: normalizedReason,
      reasonPersistence:
        disposition === "revoked"
          ? "recorded"
          : disposition === "reused"
            ? "not_rewritten_on_reuse"
            : "unknown_after_response_loss",
      revokedAt: after.revokedAt,
    },
    recordedAt: requiredTimestamp(now().toISOString(), "Recorded at"),
  };
  validateProjectionRevokedEvent(event, artifacts);
  await writeImmutableDirectory(target, async (staging) => {
    await writePackagePublicationLineage(staging, artifacts);
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-plan.json"),
      artifacts.plan,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-finalized-event.json"),
      artifacts.finalizationEvent,
    );
    await writeCanonical(
      path.join(staging, "portal-lcia-projection-revoked-event.json"),
      event,
    );
  });
  return {
    path: target,
    plan: artifacts.plan,
    event,
    eventSha256: hashJson(event),
  };
}

export async function loadProjectionPlan(planDir) {
  const root = path.resolve(planDir);
  const publication = await loadPackagePublicationArtifacts(root);
  const { value: plan } = await readJson(
    path.join(root, "portal-lcia-projection-plan.json"),
    "portal_lcia_projection_plan_missing",
  );
  validatePlan(plan);
  if (plan.packagePublishedEventSha256 !== publication.eventSha256)
    fail(
      "portal_lcia_projection_package_publication_hash_mismatch",
      "Projection plan does not match its package-published event",
    );
  return {
    root,
    plan,
    planSha256: hashJson(plan),
    packagePublicationPlan: publication.plan,
    packagePublishedEvent: publication.event,
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
  const { value: event } = await readJson(
    path.join(root, "portal-lcia-package-published-event.json"),
    "portal_lcia_package_published_event_missing",
  );
  validatePackagePublishedEvent(event, planArtifacts.plan);
  verifyJsonHash(
    planArtifacts.plan,
    event.parentArtifactSha256,
    "portal_lcia_package_publication_plan_hash_mismatch",
    "Portal LCIA package publication plan",
  );
  return { ...planArtifacts, event, eventSha256: hashJson(event) };
}

async function loadFinalizationArtifacts(finalizationDir) {
  const root = path.resolve(finalizationDir);
  const planArtifacts = await loadProjectionPlan(root);
  const { value: finalizationEvent } = await readJson(
    path.join(root, "portal-lcia-projection-finalized-event.json"),
    "portal_lcia_projection_finalized_event_missing",
  );
  validateProjectionFinalizedEvent(finalizationEvent, planArtifacts.plan);
  verifyJsonHash(
    planArtifacts.plan,
    finalizationEvent.parentArtifactSha256,
    "portal_lcia_projection_finalization_plan_hash_mismatch",
    "Portal LCIA projection plan",
  );
  return {
    ...planArtifacts,
    finalizationEvent,
    finalizationEventSha256: hashJson(finalizationEvent),
  };
}

async function writePackagePublicationLineage(staging, artifacts) {
  await writeCanonical(
    path.join(staging, "portal-lcia-package-publication-plan.json"),
    artifacts.packagePublicationPlan,
  );
  await writeCanonical(
    path.join(staging, "portal-lcia-package-published-event.json"),
    artifacts.packagePublishedEvent,
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
      p_lcia_result_publication_id: plan.projection.lciaResultPublicationId,
      p_projection_content_hash: plan.projection.projectionContentHash,
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

function validatePlan(plan) {
  assertExactObject(
    plan,
    [
      "schemaVersion",
      "status",
      "projectionFinalizationAuthorized",
      "packagePublishedEventSha256",
      "targetEndpointFingerprint",
      "preparedByActorUserId",
      "projection",
      "idempotencyKey",
      "preparedAt",
    ],
    "portal_lcia_projection_plan_invalid",
    "Portal LCIA projection plan",
  );
  if (
    plan.schemaVersion !== PLAN_SCHEMA ||
    plan.status !== "ready_for_confirmation" ||
    plan.projectionFinalizationAuthorized !== false
  )
    fail(
      "portal_lcia_projection_plan_invalid",
      "Portal LCIA projection plan has an unsupported schema or status",
    );
  requiredHash(
    plan.packagePublishedEventSha256,
    "Package-published event hash",
  );
  requiredHash(plan.targetEndpointFingerprint, "Target endpoint fingerprint");
  requiredUuid(plan.preparedByActorUserId, "Preparing actor user ID");
  const projection = validateProjectionEvidence(plan.projection);
  if (hashJson(projection) !== hashJson(plan.projection))
    fail(
      "portal_lcia_projection_plan_invalid",
      "Projection plan evidence is not canonical",
    );
  if (plan.idempotencyKey !== projectionIdempotencyKey(projection))
    fail(
      "portal_lcia_projection_plan_invalid",
      "Projection plan idempotency key does not match its exact evidence",
    );
  requiredTimestamp(plan.preparedAt, "Prepared at");
  return plan;
}

function validateProjectionEvidence(value) {
  assertExactObject(
    value,
    [
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
    ],
    "portal_lcia_projection_plan_invalid",
    "Portal LCIA projection evidence",
  );
  const projection = {
    projectionId: requiredUuid(value.projectionId, "Projection ID"),
    buildWorkerJobId: requiredUuid(
      value.buildWorkerJobId,
      "Build worker job ID",
    ),
    packageId: requiredUuid(value.packageId, "Package ID"),
    lciaResultPublicationId: requiredUuid(
      value.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    packageVersion: requiredText(value.packageVersion, "Package version", 256),
    packageResultHash: requiredHash(
      value.packageResultHash,
      "Package result hash",
    ),
    projectionContractVersion: value.projectionContractVersion,
    hashContractVersion: value.hashContractVersion,
    processCount: requiredPositiveInteger(value.processCount, "Process count"),
    impactCount: requiredPositiveInteger(value.impactCount, "Impact count"),
    valueCount: requiredPositiveInteger(value.valueCount, "Value count"),
    processAxisHash: requiredHash(value.processAxisHash, "Process axis hash"),
    impactAxisHash: requiredHash(value.impactAxisHash, "Impact axis hash"),
    valueGridHash: requiredHash(value.valueGridHash, "Value grid hash"),
    relationHash: requiredHash(value.relationHash, "Relation hash"),
    projectionContentHash: requiredHash(
      value.projectionContentHash,
      "Projection content hash",
    ),
    sourcePublishedAt: requiredTimestamp(
      value.sourcePublishedAt,
      "Source published at",
    ),
  };
  if (
    projection.projectionContractVersion !== PROJECTION_CONTRACT ||
    projection.hashContractVersion !== HASH_CONTRACT ||
    projection.valueCount !== projection.processCount * projection.impactCount
  )
    fail(
      "portal_lcia_projection_plan_invalid",
      "Projection evidence has an unsupported contract or grid cardinality",
    );
  return projection;
}

function validatePublicationEvent(event) {
  assertExactObject(
    event,
    [
      "schemaVersion",
      "eventType",
      "parentArtifactSha256",
      "targetEndpointFingerprint",
      "actorUserId",
      "disposition",
      "subject",
      "observation",
      "recordedAt",
    ],
    "portal_lcia_publication_event_invalid",
    "Portal LCIA publication event",
  );
  if (
    event.schemaVersion !== EVENT_SCHEMA ||
    ![
      "package_published",
      "projection_finalized",
      "projection_verified",
      "projection_revoked",
    ].includes(event.eventType)
  )
    fail(
      "portal_lcia_publication_event_invalid",
      "Portal LCIA publication event has an unsupported schema or type",
    );
  requiredHash(event.parentArtifactSha256, "Parent artifact hash");
  requiredHash(event.targetEndpointFingerprint, "Target endpoint fingerprint");
  requiredUuid(event.actorUserId, "Event actor user ID");
  const subject = validateEventSubject(event.subject);
  if (hashJson(subject) !== hashJson(event.subject))
    fail(
      "portal_lcia_publication_event_invalid",
      "Portal LCIA publication event subject is not canonical",
    );
  requiredTimestamp(event.recordedAt, "Recorded at");
  if (event.eventType === "package_published")
    validatePackagePublishedObservation(event);
  if (event.eventType === "projection_finalized")
    validateProjectionFinalizedObservation(event);
  if (event.eventType === "projection_verified")
    validateProjectionVerifiedObservation(event);
  if (event.eventType === "projection_revoked")
    validateProjectionRevokedObservation(event);
  return event;
}

function validateEventSubject(subject) {
  assertExactObject(
    subject,
    [
      "packageId",
      "projectionId",
      "lciaResultPublicationId",
      "projectionPublicationId",
      "packageVersion",
      "projectionContentHash",
    ],
    "portal_lcia_publication_event_invalid",
    "Portal LCIA publication event subject",
  );
  return {
    packageId: requiredUuid(subject.packageId, "Package ID"),
    projectionId: requiredUuid(subject.projectionId, "Projection ID"),
    lciaResultPublicationId: requiredUuid(
      subject.lciaResultPublicationId,
      "LCIA result publication ID",
    ),
    projectionPublicationId:
      subject.projectionPublicationId === null
        ? null
        : requiredUuid(
            subject.projectionPublicationId,
            "Projection publication ID",
          ),
    packageVersion: requiredText(
      subject.packageVersion,
      "Package version",
      256,
    ),
    projectionContentHash: requiredHash(
      subject.projectionContentHash,
      "Projection content hash",
    ),
  };
}

function validatePackagePublishedObservation(event) {
  assertExactObject(
    event.observation,
    [
      "status",
      "isCurrent",
      "independentlyReadBack",
      "databasePublishPlanHash",
      "previousPublicationId",
      "publishedAt",
      "reasonPersistence",
    ],
    "portal_lcia_publication_event_invalid",
    "Package-published observation",
  );
  const expectedReasonPersistence =
    event.disposition === "published"
      ? "recorded"
      : event.disposition === "reused"
        ? "not_rewritten_on_reuse"
        : "unknown_after_response_loss";
  if (
    !["published", "reused", "reconciled_after_response_loss"].includes(
      event.disposition,
    ) ||
    event.observation.status !== "current" ||
    event.observation.isCurrent !== true ||
    event.observation.independentlyReadBack !== true ||
    event.observation.reasonPersistence !== expectedReasonPersistence ||
    event.subject.projectionPublicationId !== null
  )
    fail(
      "portal_lcia_publication_event_invalid",
      "Package-published event has an inconsistent lifecycle",
    );
  requiredHash(
    event.observation.databasePublishPlanHash,
    "Database publish plan hash",
  );
  if (event.observation.previousPublicationId !== null)
    requiredUuid(
      event.observation.previousPublicationId,
      "Previous publication ID",
    );
  requiredTimestamp(event.observation.publishedAt, "Published at");
}

function validateProjectionFinalizedObservation(event) {
  assertExactObject(
    event.observation,
    ["status", "independentReadbackVerified", "evidenceHash", "finalizedAt"],
    "portal_lcia_publication_event_invalid",
    "Projection-finalized observation",
  );
  if (
    !["created", "reused", "reconciled_after_response_loss"].includes(
      event.disposition,
    ) ||
    event.observation.status !== "finalized" ||
    event.observation.independentReadbackVerified !== false ||
    event.subject.projectionPublicationId === null
  )
    fail(
      "portal_lcia_publication_event_invalid",
      "Projection-finalized event has an inconsistent lifecycle",
    );
  requiredHash(event.observation.evidenceHash, "Projection evidence hash");
  requiredTimestamp(event.observation.finalizedAt, "Finalized at");
}

function validateProjectionVerifiedObservation(event) {
  assertExactObject(
    event.observation,
    ["status", "isCurrent", "isPubliclyVisible", "evidenceHash", "finalizedAt"],
    "portal_lcia_publication_event_invalid",
    "Projection-verified observation",
  );
  if (
    event.disposition !== "observed" ||
    event.observation.status !== "verified" ||
    event.observation.isCurrent !== true ||
    event.observation.isPubliclyVisible !== true ||
    event.subject.projectionPublicationId === null
  )
    fail(
      "portal_lcia_publication_event_invalid",
      "Projection-verified event has an inconsistent lifecycle",
    );
  requiredHash(event.observation.evidenceHash, "Projection evidence hash");
  requiredTimestamp(event.observation.finalizedAt, "Finalized at");
}

function validateProjectionRevokedObservation(event) {
  assertExactObject(
    event.observation,
    [
      "status",
      "isCurrent",
      "isPubliclyVisible",
      "evidenceHash",
      "requestedReason",
      "reasonPersistence",
      "revokedAt",
    ],
    "portal_lcia_publication_event_invalid",
    "Projection-revoked observation",
  );
  const expectedReasonPersistence =
    event.disposition === "revoked"
      ? "recorded"
      : event.disposition === "reused"
        ? "not_rewritten_on_reuse"
        : "unknown_after_response_loss";
  if (
    !["revoked", "reused", "reconciled_after_response_loss"].includes(
      event.disposition,
    ) ||
    event.observation.status !== "revoked" ||
    event.observation.isCurrent !== false ||
    event.observation.isPubliclyVisible !== false ||
    event.observation.reasonPersistence !== expectedReasonPersistence ||
    event.subject.projectionPublicationId === null
  )
    fail(
      "portal_lcia_publication_event_invalid",
      "Projection-revoked event has an inconsistent lifecycle",
    );
  requiredHash(event.observation.evidenceHash, "Projection evidence hash");
  requiredText(event.observation.requestedReason, "Requested reason", 2000);
  requiredTimestamp(event.observation.revokedAt, "Revoked at");
}

function validatePackagePublishedEvent(event, plan) {
  validatePublicationEvent(event);
  if (
    event.eventType !== "package_published" ||
    event.parentArtifactSha256 !== hashJson(plan) ||
    event.targetEndpointFingerprint !== plan.targetEndpointFingerprint ||
    event.actorUserId !== plan.preparedByActorUserId ||
    event.subject.packageId !== plan.package.id ||
    event.subject.projectionId !== plan.projection.id ||
    event.subject.packageVersion !== plan.package.version ||
    event.subject.projectionContentHash !== plan.projection.contentHash ||
    event.observation.databasePublishPlanHash !== plan.publishPlanHash ||
    event.observation.previousPublicationId !==
      (plan.currentPublication?.publicationId ?? null)
  )
    fail(
      "portal_lcia_package_published_event_invalid",
      "Package-published event does not match the confirmed plan",
    );
  return event;
}

function validateProjectionFinalizedEvent(event, plan) {
  validatePublicationEvent(event);
  if (
    event.eventType !== "projection_finalized" ||
    event.parentArtifactSha256 !== hashJson(plan) ||
    event.targetEndpointFingerprint !== plan.targetEndpointFingerprint ||
    event.actorUserId !== plan.preparedByActorUserId ||
    !subjectMatchesProjection(event.subject, plan.projection)
  )
    fail(
      "portal_lcia_projection_finalized_event_invalid",
      "Projection-finalized event does not match the confirmed plan",
    );
  return event;
}

function validateProjectionVerifiedEvent(event, artifacts) {
  validatePublicationEvent(event);
  if (
    event.eventType !== "projection_verified" ||
    event.parentArtifactSha256 !== artifacts.finalizationEventSha256 ||
    event.targetEndpointFingerprint !==
      artifacts.plan.targetEndpointFingerprint ||
    hashJson(event.subject) !== hashJson(artifacts.finalizationEvent.subject) ||
    event.observation.evidenceHash !==
      artifacts.finalizationEvent.observation.evidenceHash ||
    event.observation.finalizedAt !==
      artifacts.finalizationEvent.observation.finalizedAt
  )
    fail(
      "portal_lcia_projection_verified_event_invalid",
      "Projection-verified event does not match the finalized event",
    );
  return event;
}

function validateProjectionRevokedEvent(event, artifacts) {
  validatePublicationEvent(event);
  if (
    event.eventType !== "projection_revoked" ||
    event.parentArtifactSha256 !== artifacts.finalizationEventSha256 ||
    event.targetEndpointFingerprint !==
      artifacts.plan.targetEndpointFingerprint ||
    hashJson(event.subject) !== hashJson(artifacts.finalizationEvent.subject) ||
    event.observation.evidenceHash !==
      artifacts.finalizationEvent.observation.evidenceHash
  )
    fail(
      "portal_lcia_projection_revoked_event_invalid",
      "Projection-revoked event does not match the finalized event",
    );
  return event;
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

function assertPackagePublishedEventTarget(event, runtime) {
  if (runtime.targetEndpointFingerprint !== event.targetEndpointFingerprint)
    fail(
      "portal_lcia_package_publication_target_mismatch",
      "Projection preparation target differs from the package-published event",
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

function assertProjectionPrepareMatchesPackagePublication(
  prepared,
  { plan, event },
) {
  if (
    prepared.packageId !== event.subject.packageId ||
    prepared.lciaResultPublicationId !==
      event.subject.lciaResultPublicationId ||
    prepared.packageVersion !== event.subject.packageVersion ||
    prepared.packageResultHash !== plan.package.resultHash ||
    prepared.projectionId !== event.subject.projectionId ||
    prepared.contentHash !== event.subject.projectionContentHash ||
    prepared.processCount !== plan.package.processCount ||
    prepared.impactCount !== plan.package.impactCount ||
    prepared.valueCount !== plan.package.valueCount ||
    prepared.processAxisHash !== plan.projection.processAxisHash ||
    prepared.impactAxisHash !== plan.projection.impactAxisHash ||
    prepared.valueGridHash !== plan.projection.valueGridHash ||
    prepared.relationHash !== plan.projection.relationHash ||
    prepared.publishedAt !== event.observation.publishedAt
  )
    fail(
      "portal_lcia_projection_package_publication_drift",
      "Projection preparation differs from the confirmed plan and package-published event",
    );
}

function projectionSubject(plan, { projectionPublicationId }) {
  return {
    packageId: plan.projection.packageId,
    projectionId: plan.projection.projectionId,
    lciaResultPublicationId: plan.projection.lciaResultPublicationId,
    projectionPublicationId,
    packageVersion: plan.projection.packageVersion,
    projectionContentHash: plan.projection.projectionContentHash,
  };
}

function subjectMatchesProjection(subject, projection) {
  return (
    subject.packageId === projection.packageId &&
    subject.projectionId === projection.projectionId &&
    subject.lciaResultPublicationId === projection.lciaResultPublicationId &&
    subject.projectionPublicationId !== null &&
    subject.packageVersion === projection.packageVersion &&
    subject.projectionContentHash === projection.projectionContentHash
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
  const projection = plan.projection;
  if (
    finalized.projectionId !== projection.projectionId ||
    finalized.lciaResultPublicationId !== projection.lciaResultPublicationId ||
    finalized.packageId !== projection.packageId ||
    finalized.contentHash !== projection.projectionContentHash
  )
    fail(
      "portal_lcia_projection_finalize_identity_mismatch",
      "Projection finalization returned evidence outside the confirmed plan",
    );
}

function assertRevokedMatchesPlan(revoked, plan, finalizationEvent) {
  if (
    revoked.lciaResultPublicationId !==
      plan.projection.lciaResultPublicationId ||
    revoked.projectionPublicationId !==
      finalizationEvent.subject.projectionPublicationId
  )
    fail(
      "portal_lcia_projection_revoke_identity_mismatch",
      "Projection revocation returned a different publication identity",
    );
}

function assertReadbackMatchesFinalization({
  readback,
  plan,
  finalizationEvent,
  requireCurrent,
  requiredStatus,
}) {
  assertReadbackMatchesPlan(readback, plan, {
    requireCurrent,
    requiredStatus,
  });
  if (
    readback.projectionPublicationId !==
      finalizationEvent.subject.projectionPublicationId ||
    readback.evidenceHash !== finalizationEvent.observation.evidenceHash ||
    readback.finalizedAt !== finalizationEvent.observation.finalizedAt
  )
    fail(
      "portal_lcia_projection_readback_mismatch",
      "Projection readback differs from the finalized event",
    );
}

function assertReadbackMatchesPlan(
  readback,
  plan,
  { requireCurrent, requiredStatus },
) {
  const projection = plan.projection;
  const statuses = Array.isArray(requiredStatus)
    ? requiredStatus
    : [requiredStatus];
  if (
    readback.projectionId !== projection.projectionId ||
    readback.lciaResultPublicationId !== projection.lciaResultPublicationId ||
    readback.packageId !== projection.packageId ||
    readback.packageVersion !== projection.packageVersion ||
    readback.contentHash !== projection.projectionContentHash ||
    readback.processCount !== projection.processCount ||
    readback.impactCount !== projection.impactCount ||
    readback.valueCount !== projection.valueCount
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
