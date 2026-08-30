import { fail, hashJson } from "./common.mjs";
import { resolveActorAccessToken } from "./actor-session.mjs";

export async function resolvePublicationRuntime({
  env,
  fetchImpl = globalThis.fetch,
}) {
  const apiBaseUrl = String(env.TIANGONG_LCA_API_BASE_URL ?? "").trim();
  const publishableKey = String(
    env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY ?? "",
  ).trim();
  if (!apiBaseUrl || !publishableKey)
    fail(
      "publication_runtime_unavailable",
      "TIANGONG_LCA_API_BASE_URL and TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY are required",
    );
  if (
    publishableKey.startsWith("sb_secret_") ||
    jwtRole(publishableKey) === "service_role"
  )
    fail(
      "publication_secret_key_forbidden",
      "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY must not contain a Supabase secret or service-role key",
    );
  const accessToken = await resolveActorAccessToken({ env, fetchImpl });
  return {
    projectBaseUrl: projectBaseUrl(apiBaseUrl),
    publishableKey,
    accessToken,
    actorUserId: actorSubject(accessToken),
    targetEndpointFingerprint: hashJson({
      projectBaseUrl: projectBaseUrl(apiBaseUrl),
    }),
  };
}

export async function inspectDataset({
  runtime,
  dataset,
  fetchImpl = globalThis.fetch,
}) {
  const url = new URL(`${runtime.projectBaseUrl}/rest/v1/${dataset.table}`);
  url.searchParams.set("id", `eq.${dataset.uuid}`);
  url.searchParams.set("version", `eq.${dataset.version}`);
  url.searchParams.set("select", "id,version,state_code,user_id,json_ordered");
  const payload = await requestJson({
    url: url.href,
    method: "GET",
    runtime,
    fetchImpl,
  });
  if (!Array.isArray(payload))
    fail(
      "publication_target_response_invalid",
      `Target inspection returned a non-array payload for ${dataset.key}`,
    );
  if (payload.length > 1)
    fail(
      "publication_target_identity_ambiguous",
      `Target returned multiple rows for exact identity: ${dataset.key}`,
    );
  return payload[0] ?? null;
}

export async function invokeDatasetCreate({
  runtime,
  dataset,
  document,
  fetchImpl = globalThis.fetch,
}) {
  return requestJson({
    url: `${runtime.projectBaseUrl}/functions/v1/app_dataset_create`,
    method: "POST",
    runtime,
    fetchImpl,
    body: {
      table: dataset.table,
      id: dataset.uuid,
      jsonOrdered: document,
      ...(dataset.modelId ? { modelId: dataset.modelId } : {}),
      ruleVerification: true,
    },
  });
}

export async function invokeLifecycleModelBundleCreate({
  runtime,
  model,
  document,
  processMutations = [],
  fetchImpl = globalThis.fetch,
}) {
  return requestJson({
    url: `${runtime.projectBaseUrl}/functions/v1/save_lifecycle_model_bundle`,
    method: "POST",
    runtime,
    fetchImpl,
    body: {
      mode: "create",
      modelId: model.uuid,
      parent: {
        jsonOrdered: document,
        jsonTg: {},
        ruleVerification: true,
      },
      processMutations,
    },
  });
}

export async function invokeDatasetPublish({
  runtime,
  dataset,
  fetchImpl = globalThis.fetch,
}) {
  return requestJson({
    url: `${runtime.projectBaseUrl}/functions/v1/app_dataset_publish`,
    method: "POST",
    runtime,
    fetchImpl,
    body: {
      table: dataset.table,
      id: dataset.uuid,
      version: dataset.version,
    },
  });
}

export async function requestJson({
  url,
  method,
  runtime,
  fetchImpl,
  body,
  timeoutMs = 30_000,
  schema,
}) {
  const endpoint = new URL(url).pathname;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        apikey: runtime.publishableKey,
        Authorization: `Bearer ${runtime.accessToken}`,
        Accept: "application/json",
        ...(schema ? { "Content-Profile": schema } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    fail(
      "publication_remote_unavailable",
      `Publication request failed: ${method} ${endpoint}`,
      {
        cause: error instanceof Error ? error.name : "unknown",
      },
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    fail(
      "publication_remote_unavailable",
      `Publication response body was unavailable: ${method} ${endpoint}`,
      {
        cause: error instanceof Error ? error.name : "unknown",
        status: response.status,
      },
    );
  }
  let payload = null;
  if (text)
    try {
      payload = JSON.parse(text);
    } catch {
      fail(
        "publication_remote_response_invalid",
        `Publication endpoint returned non-JSON: ${method} ${endpoint}`,
        { status: response.status },
      );
    }
  if (!response.ok || payload?.ok === false)
    fail(
      String(
        payload?.code ?? "publication_remote_request_failed",
      ).toLowerCase(),
      String(
        payload?.message ??
          `HTTP ${response.status} returned from Publication endpoint`,
      ),
      { status: response.status },
    );
  return payload;
}

function projectBaseUrl(value) {
  return value
    .replace(/\/+$/u, "")
    .replace(/\/(?:functions|rest)\/v1(?:\/.*)?$/u, "");
}

function actorSubject(token) {
  try {
    const segment = token.split(".")[1];
    const payload = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    return typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
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
