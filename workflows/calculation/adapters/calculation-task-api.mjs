import { isUuid } from "../contracts/result-set.mjs";
import { resultSetApiConfig, ResultSetApiError } from "./result-set-api.mjs";
import { resolveActorAccessToken } from "../runtime/actor-session.mjs";

const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function projectTask(data, kind) {
  const job = data?.workerJob ?? data?.job ?? {};
  const jobId =
    text(job.id) ??
    text(job.jobId) ??
    text(data?.workerJobId) ??
    text(data?.jobId);
  const resourceId =
    kind === "closure"
      ? text(data?.closureCheckId)
      : (text(data?.buildId) ??
        text(data?.resultPackageId) ??
        text(data?.packageId));
  if (!isUuid(jobId) || (kind === "closure" && !isUuid(resourceId))) {
    throw new ResultSetApiError(
      "remote_outcome_unknown",
      kind === "closure"
        ? "The task may have been accepted, but stable Closure/job identities were not returned"
        : "The calculation may have been accepted, but a stable Worker Job identity was not returned",
    );
  }
  return {
    kind,
    jobId,
    resourceId: isUuid(resourceId) ? resourceId : null,
    identityCompleteness: isUuid(resourceId) ? "complete" : "job_only",
    status: text(job.status) ?? text(data?.status) ?? "queued",
    reused: data?.reused === true,
  };
}

function projectClosureCheck(data) {
  const closureCheckId = text(data?.closureCheckId);
  if (!isUuid(closureCheckId))
    throw new ResultSetApiError(
      "invalid_closure_check",
      "Closure Check response did not contain an exact identity",
    );
  const workerJob = data?.workerJob ?? {};
  const jobId = text(workerJob.jobId) ?? text(workerJob.id);
  const requestedScopeHash = text(data?.requestedScopeHash);
  const policyFingerprint = text(data?.policyFingerprint);
  const runStatus = text(data?.runStatus) ?? "unknown";
  const scanCompleteness = text(data?.scanCompleteness) ?? "unknown";
  const certificateValidity = text(data?.certificateValidity) ?? "unknown";
  const calculationReady =
    runStatus === "passed" &&
    scanCompleteness === "complete" &&
    certificateValidity === "valid" &&
    requestedScopeHash !== null &&
    policyFingerprint !== null;
  return {
    closureCheckId,
    runStatus,
    scanCompleteness,
    certificateValidity,
    calculationReady,
    binding: {
      requestedScopeHash,
      policyFingerprint,
      effectiveScopeHash: text(data?.effectiveScopeHash),
    },
    blockerCodes: Array.isArray(data?.blockerCodes)
      ? data.blockerCodes
          .filter((value) => typeof value === "string")
          .slice(0, 50)
      : [],
    workerJob: {
      jobId: isUuid(jobId) ? jobId : null,
      status: text(workerJob.status),
      phase: text(workerJob.phase),
      progressFraction:
        typeof workerJob.progressFraction === "number"
          ? workerJob.progressFraction
          : null,
    },
    createdAt: text(data?.createdAt),
    updatedAt: text(data?.updatedAt),
    finishedAt: text(data?.finishedAt),
  };
}

export function createCalculationTaskApi({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resultSetApiConfig(env);
  async function invoke(
    body,
    { kind, readOnly = false, project = projectTask },
  ) {
    const accessToken = await resolveActorAccessToken({
      env: config.env,
      fetchImpl,
    });
    let response;
    try {
      response = await fetchImpl(config.commandUrl, {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ResultSetApiError(
        readOnly ? "capability_unavailable" : "remote_outcome_unknown",
        readOnly
          ? "Closure Check lookup is temporarily unavailable"
          : "Task submission outcome is unknown; inspect the task feed before retrying",
        { details: { cause: error instanceof Error ? error.name : "unknown" } },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ResultSetApiError(
        readOnly ? "invalid_closure_check" : "remote_outcome_unknown",
        readOnly
          ? "Closure Check lookup returned non-JSON"
          : "Task submission returned non-JSON; inspect the task feed before retrying",
      );
    }
    if (!response.ok || payload?.ok === false)
      throw new ResultSetApiError(
        payload?.code ?? `http_${response.status}`,
        payload?.message ??
          `Task submission failed with HTTP ${response.status}`,
        { status: response.status },
      );
    return project(payload?.data, kind);
  }
  return {
    createClosure(input) {
      return invoke(
        {
          action: "create_closure_check",
          ...(input.resultSetId ? { resultSetId: input.resultSetId } : {}),
          requestedScope: input.requestedScope,
          requestIdempotencyToken: input.idempotencyToken,
        },
        { kind: "closure" },
      );
    },
    getClosure(closureCheckId) {
      return invoke(
        { action: "get_closure_check", closureCheckId },
        { kind: "closure", readOnly: true, project: projectClosureCheck },
      );
    },
    createCalculation(input) {
      return invoke(
        {
          action: "create_build",
          name: input.name,
          coverageMode: input.coverageMode,
          ...(input.processes.length ? { processes: input.processes } : {}),
          defaultImpactCategory: input.defaultImpactCategory,
          lciaMethodSet: input.lciaMethods,
          idempotencyKey: input.idempotencyKey,
          closureCheckId: input.closureCheckId,
          requestedScopeHash: input.requestedScopeHash,
          policyFingerprint: input.policyFingerprint,
        },
        { kind: "calculation" },
      );
    },
  };
}
