import { isUuid } from "../contracts/result-set.mjs";
import { resultSetApiConfig, ResultSetApiError } from "./result-set-api.mjs";
import { resolveActorAccessToken } from "../runtime/actor-session.mjs";

const text = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function releaseCommandUrl(config) {
  const exact = config.env.TIANGONG_LCA_RELEASE_COMMAND_URL?.trim();
  if (exact) return exact;
  const dataProductSuffix = "/app_data_product_commands";
  if (config.commandUrl.endsWith(dataProductSuffix))
    return `${config.commandUrl.slice(0, -dataProductSuffix.length)}/app_lca_release_commands`;
  throw new ResultSetApiError(
    "capability_unavailable",
    "TIANGONG_LCA_RELEASE_COMMAND_URL or a standard TIANGONG_LCA_API_BASE_URL is required for Calculation Bundle reads",
  );
}

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

function projectCalculationTask(value) {
  const jobId = text(value?.jobId);
  if (!isUuid(jobId) || text(value?.jobKind) !== "lcia_result.package_build")
    return null;
  const workerStatus = text(value?.workerStatus) ?? "unknown";
  const domainStatus = text(value?.domainStatus);
  const domainValidity = text(value?.domainValidity);
  const terminal = [
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "blocked",
    "stale",
  ].includes(workerStatus);
  const diagnosticsRecommended =
    ["failed", "blocked", "stale"].includes(workerStatus) ||
    (workerStatus === "completed" &&
      (domainStatus !== "passed" || domainValidity !== "valid"));
  return {
    jobId,
    jobKind: "lcia_result.package_build",
    workerStatus,
    domainStatus,
    domainValidity,
    terminal,
    diagnosticsRecommended,
    phase: text(value?.phase),
    progressFraction:
      typeof value?.progressFraction === "number"
        ? value.progressFraction
        : null,
    projectionUpdatedAt: text(value?.projectionUpdatedAt),
    title: text(value?.title),
    resultSetId: isUuid(text(value?.resultSetId))
      ? text(value.resultSetId)
      : null,
    resultSetName: text(value?.resultSetName),
    closureCheckId: isUuid(text(value?.closureCheckId))
      ? text(value.closureCheckId)
      : null,
    resultPackageId: isUuid(text(value?.resultPackageId))
      ? text(value.resultPackageId)
      : null,
    blockerCodes: Array.isArray(value?.blockerCodes)
      ? value.blockerCodes
          .filter((entry) => typeof entry === "string")
          .slice(0, 50)
      : [],
    errorSummary: text(value?.errorSummary),
    capabilities: {
      canOpenWorkbench: value?.capabilities?.canOpenWorkbench === true,
      canPreviewResult: value?.capabilities?.canPreviewResult === true,
      canDownloadReport: value?.capabilities?.canDownloadReport === true,
    },
  };
}

function projectCalculationBundle(value) {
  const packageId = text(value?.packageId);
  const calculationBundle = value?.calculationBundle;
  if (
    !isUuid(packageId) ||
    !calculationBundle ||
    typeof calculationBundle !== "object"
  )
    throw new ResultSetApiError(
      "invalid_calculation_bundle",
      "Calculation Bundle response did not contain an exact Package identity and bundle metadata",
    );
  const downloads = Array.isArray(value?.productDownloads)
    ? value.productDownloads
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          role: text(entry.role),
          group: text(entry.group),
          fileName: text(entry.fileName),
          mediaType: text(entry.mediaType),
          sha256: text(entry.sha256),
          byteSize: Number.isSafeInteger(entry.byteSize)
            ? entry.byteSize
            : null,
          recordCount: Number.isSafeInteger(entry.recordCount)
            ? entry.recordCount
            : null,
        }))
    : [];
  return {
    packageId,
    packageVersion: text(value?.packageVersion),
    snapshotId: isUuid(text(value?.snapshotId)) ? text(value.snapshotId) : null,
    resultId: isUuid(text(value?.resultId)) ? text(value.resultId) : null,
    bundle: {
      schemaVersion: text(calculationBundle.schemaVersion),
      bundleContentHash: text(calculationBundle.bundleContentHash),
    },
    availableImpactCategories: Array.isArray(value?.availableImpactCategories)
      ? value.availableImpactCategories.filter(
          (entry) => typeof entry === "string",
        )
      : [],
    productDownloads: downloads,
  };
}

export function createCalculationTaskApi({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resultSetApiConfig(env);
  async function invokeUrl(url, body, { readName, project }) {
    const accessToken = await resolveActorAccessToken({
      env: config.env,
      fetchImpl,
    });
    let response;
    try {
      response = await fetchImpl(url, {
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
        "capability_unavailable",
        `${readName} lookup is temporarily unavailable`,
        { details: { cause: error instanceof Error ? error.name : "unknown" } },
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ResultSetApiError(
        "invalid_calculation_bundle",
        `${readName} lookup returned non-JSON`,
      );
    }
    if (!response.ok || payload?.ok === false)
      throw new ResultSetApiError(
        payload?.code ?? `http_${response.status}`,
        payload?.message ??
          `${readName} lookup failed with HTTP ${response.status}`,
        { status: response.status },
      );
    return project(payload?.data);
  }
  async function invoke(
    body,
    {
      kind,
      readOnly = false,
      readName = "Closure Check",
      project = projectTask,
    },
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
          ? `${readName} lookup is temporarily unavailable`
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
          ? `${readName} lookup returned non-JSON`
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
    async getCalculation(jobId, { maxPages = 5 } = {}) {
      let cursor;
      for (let page = 1; page <= maxPages; page += 1) {
        const data = await invoke(
          {
            action: "list_task_feed",
            category: "data_product",
            jobKinds: ["lcia_result.package_build"],
            ...(cursor ? { cursor } : {}),
            limit: 200,
            rootOnly: false,
          },
          {
            kind: "calculation",
            readOnly: true,
            readName: "Calculation task",
            project: (value) => value,
          },
        );
        const items = Array.isArray(data?.items) ? data.items : [];
        const task = items
          .map(projectCalculationTask)
          .find((candidate) => candidate?.jobId === jobId);
        if (task)
          return {
            task,
            lookup: {
              source: "actor_scoped_database_task_feed",
              pageCount: page,
              pageSize: 200,
              complete: true,
            },
          };
        cursor = data?.nextCursor;
        if (!cursor)
          throw new ResultSetApiError(
            "calculation_task_not_found",
            `Calculation task ${jobId} was not found in the complete actor-scoped feed`,
          );
      }
      throw new ResultSetApiError(
        "calculation_task_lookup_incomplete",
        `Calculation task ${jobId} was not found before the bounded lookup limit`,
        { details: { maxPages, pageSize: 200 } },
      );
    },
    async listCalculationBundles(limit) {
      const data = await invoke(
        {
          action: "list_task_feed",
          category: "data_product",
          jobKinds: ["lcia_result.package_build"],
          limit: 200,
          rootOnly: false,
        },
        {
          kind: "calculation",
          readOnly: true,
          readName: "Calculation task feed",
          project: (value) => value,
        },
      );
      const tasks = (Array.isArray(data?.items) ? data.items : [])
        .map(projectCalculationTask)
        .filter(Boolean);
      const candidates = [];
      const seen = new Set();
      for (const task of tasks) {
        if (task.resultPackageId && !seen.has(task.resultPackageId)) {
          seen.add(task.resultPackageId);
          candidates.push(task);
        }
      }
      const items = [];
      const exclusions = [];
      for (const task of candidates) {
        if (items.length >= limit) break;
        try {
          const bundle = await invokeUrl(
            releaseCommandUrl(config),
            {
              action: "get_calculation_bundle",
              packageId: task.resultPackageId,
            },
            {
              readName: "Calculation Bundle",
              project: projectCalculationBundle,
            },
          );
          items.push({
            ...bundle,
            calculation: {
              jobId: task.jobId,
              title: task.title,
              resultSetId: task.resultSetId,
              resultSetName: task.resultSetName,
              projectionUpdatedAt: task.projectionUpdatedAt,
            },
          });
        } catch (error) {
          if (
            ["calculation_bundle_not_available", "package_not_found"].includes(
              error?.code,
            )
          ) {
            exclusions.push({
              packageId: task.resultPackageId,
              jobId: task.jobId,
              code: error.code,
            });
            continue;
          }
          throw error;
        }
      }
      return {
        items,
        lookup: {
          source: "actor_scoped_database_task_feed_and_exact_bundle_reads",
          taskLimit: 200,
          tasksScanned: tasks.length,
          candidatePackages: candidates.length,
          excludedPackages: exclusions.length,
          nextCursorPresent: Boolean(data?.nextCursor),
          resultLimit: limit,
          complete: !data?.nextCursor && items.length < limit,
        },
        exclusions: exclusions.slice(0, 20),
      };
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
