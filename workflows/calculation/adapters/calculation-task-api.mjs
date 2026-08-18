import { isUuid } from "../contracts/result-set.mjs";
import { resultSetApiConfig, ResultSetApiError } from "./result-set-api.mjs";

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
  if (!isUuid(jobId) || !isUuid(resourceId)) {
    throw new ResultSetApiError(
      "remote_outcome_unknown",
      "The task may have been accepted, but stable job/resource identities were not returned",
    );
  }
  return {
    kind,
    jobId,
    resourceId,
    status: text(job.status) ?? text(data?.status) ?? "queued",
    reused: data?.reused === true,
  };
}

export function createCalculationTaskApi({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resultSetApiConfig(env);
  async function invoke(body, kind) {
    let response;
    try {
      response = await fetchImpl(config.commandUrl, {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ResultSetApiError(
        "remote_outcome_unknown",
        "Task submission outcome is unknown; inspect the task feed before retrying",
        { details: { cause: error instanceof Error ? error.name : "unknown" } },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ResultSetApiError(
        "remote_outcome_unknown",
        "Task submission returned non-JSON; inspect the task feed before retrying",
      );
    }
    if (!response.ok || payload?.ok === false)
      throw new ResultSetApiError(
        payload?.code ?? `http_${response.status}`,
        payload?.message ??
          `Task submission failed with HTTP ${response.status}`,
        { status: response.status },
      );
    return projectTask(payload?.data, kind);
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
        "closure",
      );
    },
    createCalculation(input) {
      return invoke(
        {
          action: "create_build",
          name: input.name,
          coverageMode: input.coverageMode,
          ...(input.processes.length ? { processes: input.processes } : {}),
          lciaMethodSet: input.lciaMethods,
          idempotencyKey: input.idempotencyKey,
          closureCheckId: input.closureCheckId,
          requestedScopeHash: input.requestedScopeHash,
          policyFingerprint: input.policyFingerprint,
        },
        "calculation",
      );
    },
  };
}
