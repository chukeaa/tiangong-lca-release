function authError(code, message, options = {}) {
  const error = new Error(message);
  error.name = "PublicationActorSessionError";
  error.code = code;
  Object.assign(error, options);
  return error;
}

function decodeUserApiKey(value) {
  try {
    const parsed = JSON.parse(
      Buffer.from(value.trim(), "base64").toString("utf8"),
    );
    if (
      typeof parsed?.email !== "string" ||
      !parsed.email.trim() ||
      typeof parsed?.password !== "string" ||
      !parsed.password.trim()
    )
      return null;
    return { email: parsed.email.trim(), password: parsed.password.trim() };
  } catch {
    return null;
  }
}

function projectBaseUrl(apiBaseUrl) {
  return apiBaseUrl
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\/functions\/v1(?:\/.*)?$/u, "");
}

export async function resolveActorAccessToken({
  env,
  fetchImpl = globalThis.fetch,
}) {
  const explicit = env.TIANGONG_LCA_ACCESS_TOKEN?.trim();
  if (explicit) {
    if (explicit.split(".").length !== 3)
      throw authError(
        "auth_required",
        "TIANGONG_LCA_ACCESS_TOKEN must be an actor-scoped JWT access token",
      );
    return explicit;
  }
  const credentials = decodeUserApiKey(env.TIANGONG_LCA_API_KEY ?? "");
  if (!credentials)
    throw authError(
      "auth_required",
      "Provide an actor JWT or a valid TIANGONG_LCA_API_KEY user bootstrap",
    );
  const baseUrl = env.TIANGONG_LCA_API_BASE_URL?.trim();
  const publishableKey = env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!baseUrl || !publishableKey)
    throw authError(
      "publication_runtime_unavailable",
      "TIANGONG_LCA_API_BASE_URL and TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY are required for user session exchange",
    );
  let response;
  try {
    response = await fetchImpl(
      `${projectBaseUrl(baseUrl)}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { apikey: publishableKey, "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    throw authError("auth_required", "User session exchange is unavailable", {
      details: { cause: error instanceof Error ? error.name : "unknown" },
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw authError("auth_required", "User session exchange returned non-JSON");
  }
  const token =
    typeof payload?.access_token === "string"
      ? payload.access_token.trim()
      : "";
  if (!response.ok || token.split(".").length !== 3)
    throw authError(
      "auth_required",
      "TIANGONG_LCA_API_KEY could not establish a user session",
      { status: response.status },
    );
  return token;
}
