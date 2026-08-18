import {
  decodeCommandEnvelope,
  decodeResultSet,
  decodeResultSetList,
} from "../contracts/result-set.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ResultSetApiError extends Error {
  constructor(code, message, { status = 0, details = undefined } = {}) {
    super(message);
    this.name = "ResultSetApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) {
    throw new ResultSetApiError(
      "capability_unavailable",
      `${key} is required for the ResultSet capability`,
    );
  }
  return value;
}

function commandUrl(env) {
  const exact = env.TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL?.trim();
  if (exact) return exact;

  const base = required(env, "TIANGONG_LCA_API_BASE_URL").replace(/\/+$/, "");
  if (base.endsWith("/functions/v1/app_data_product_commands")) return base;
  if (base.endsWith("/functions/v1"))
    return `${base}/app_data_product_commands`;
  return `${base}/functions/v1/app_data_product_commands`;
}

export function resultSetApiConfig(env = process.env) {
  const accessToken = required(env, "TIANGONG_LCA_ACCESS_TOKEN");
  if (accessToken.split(".").length !== 3) {
    throw new ResultSetApiError(
      "auth_required",
      "TIANGONG_LCA_ACCESS_TOKEN must be an actor-scoped JWT access token",
    );
  }

  const publishableKey = required(env, "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY");
  if (publishableKey.startsWith("sb_secret_")) {
    throw new ResultSetApiError(
      "capability_unavailable",
      "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY must not contain a Supabase secret key",
    );
  }

  return {
    commandUrl: commandUrl(env),
    publishableKey,
    accessToken,
  };
}

function safeErrorDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const details = value.details;
  if (details === undefined) return undefined;
  const serialized = JSON.stringify(details);
  return serialized.length <= 2_000 ? details : { truncated: true };
}

function remoteError(response, payload, action) {
  const remoteCode =
    payload && typeof payload === "object" && typeof payload.code === "string"
      ? payload.code
      : `http_${response.status}`;
  const message =
    payload &&
    typeof payload === "object" &&
    typeof payload.message === "string"
      ? payload.message
      : `ResultSet ${action} request failed with HTTP ${response.status}`;

  if (action === "create" && response.status >= 500) {
    return new ResultSetApiError(
      "remote_outcome_unknown",
      "ResultSet creation may have completed remotely; do not retry until the remote state is checked",
      { status: response.status, details: { remoteCode } },
    );
  }

  const codeMap = {
    AUTH_REQUIRED: "auth_required",
    auth_required: "auth_required",
    not_data_product_manager: "not_data_product_manager",
    result_set_not_found: "result_set_not_found",
    INVALID_PAYLOAD: "invalid_request",
  };
  return new ResultSetApiError(codeMap[remoteCode] ?? remoteCode, message, {
    status: response.status,
    details: safeErrorDetails(payload),
  });
}

export function createResultSetApi({
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const config = resultSetApiConfig(env);

  async function invoke(action, body, expectedCommand, decodeData) {
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
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const code =
        action === "create"
          ? "remote_outcome_unknown"
          : "capability_unavailable";
      const message =
        action === "create"
          ? "ResultSet creation outcome is unknown; inspect remote ResultSets before retrying"
          : `ResultSet ${action} endpoint is unavailable`;
      throw new ResultSetApiError(code, message, {
        details: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ResultSetApiError(
        action === "create"
          ? "remote_outcome_unknown"
          : "invalid_result_set_projection",
        "ResultSet endpoint returned a non-JSON response",
        { status: response.status },
      );
    }

    if (
      !response.ok ||
      (payload && typeof payload === "object" && payload.ok === false)
    ) {
      throw remoteError(response, payload, action);
    }
    try {
      return decodeCommandEnvelope(payload, expectedCommand, decodeData);
    } catch (error) {
      if (action === "create") {
        throw new ResultSetApiError(
          "remote_outcome_unknown",
          "ResultSet creation returned an invalid projection; inspect remote ResultSets before retrying",
          {
            status: response.status,
            details: { cause: error.code ?? "invalid_projection" },
          },
        );
      }
      throw error;
    }
  }

  return {
    target: {
      commandUrl: config.commandUrl,
      publishableKey: config.publishableKey,
    },
    create(name) {
      return invoke(
        "create",
        { action: "create_result_set", name },
        "lcia_result_set_create",
        decodeResultSet,
      );
    },
    list(limit) {
      return invoke(
        "list",
        { action: "list_result_sets", limit },
        "lcia_result_sets_list",
        decodeResultSetList,
      );
    },
    get(resultSetId) {
      return invoke(
        "get",
        { action: "get_result_set", resultSetId },
        "lcia_result_set_get",
        decodeResultSet,
      );
    },
  };
}
