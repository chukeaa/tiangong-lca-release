import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalSha256, canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";

export type ReleaseTargetProfile = {
  schemaVersion: "tiangong.release-target-profile.v1";
  targetId: string;
  apiBaseUrl: string;
  publishableKeySha256: string;
};

export type ReleaseTargetBinding = {
  schemaVersion: "tiangong.release-target-binding.v1";
  targetId: string;
  apiBaseUrl: string;
  publishableKeySha256: string;
  targetFingerprint: string;
};

type ReleaseTargetCatalog = {
  schemaVersion: "tiangong.release-target-catalog.v1";
  targets: ReleaseTargetProfile[];
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TARGET_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;

function targetCatalogPath(): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "..",
    "specs",
    "release-targets.json",
  );
}

function normalizeApiBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("release_target_api_base_url_invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("release_target_api_base_url_invalid");
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/u, "");
}

function assertTargetProfile(value: unknown): ReleaseTargetProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release_target_profile_invalid");
  }
  const source = value as Record<string, unknown>;
  if (
    source.schemaVersion !== "tiangong.release-target-profile.v1" ||
    typeof source.targetId !== "string" ||
    !TARGET_ID_PATTERN.test(source.targetId) ||
    typeof source.apiBaseUrl !== "string" ||
    typeof source.publishableKeySha256 !== "string" ||
    !SHA256_PATTERN.test(source.publishableKeySha256)
  ) {
    throw new Error("release_target_profile_contract_invalid");
  }
  return {
    schemaVersion: "tiangong.release-target-profile.v1",
    targetId: source.targetId,
    apiBaseUrl: normalizeApiBaseUrl(source.apiBaseUrl),
    publishableKeySha256: source.publishableKeySha256,
  };
}

export function releaseTargetFingerprint(
  profile: ReleaseTargetProfile,
): string {
  return canonicalSha256(profile as unknown as JsonValue);
}

export function releaseTargetBinding(
  profile: ReleaseTargetProfile,
): ReleaseTargetBinding {
  return {
    schemaVersion: "tiangong.release-target-binding.v1",
    targetId: profile.targetId,
    apiBaseUrl: profile.apiBaseUrl,
    publishableKeySha256: profile.publishableKeySha256,
    targetFingerprint: releaseTargetFingerprint(profile),
  };
}

export function assertReleaseTargetBinding(
  value: unknown,
): ReleaseTargetBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release_target_binding_invalid");
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "targetId",
    "apiBaseUrl",
    "publishableKeySha256",
    "targetFingerprint",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new Error("release_target_binding_unknown_field");
  }
  const profile = assertTargetProfile({
    schemaVersion: "tiangong.release-target-profile.v1",
    targetId: source.targetId,
    apiBaseUrl: source.apiBaseUrl,
    publishableKeySha256: source.publishableKeySha256,
  });
  if (
    source.schemaVersion !== "tiangong.release-target-binding.v1" ||
    typeof source.targetFingerprint !== "string" ||
    !SHA256_PATTERN.test(source.targetFingerprint) ||
    source.targetFingerprint !== releaseTargetFingerprint(profile)
  ) {
    throw new Error("release_target_binding_contract_invalid");
  }
  return releaseTargetBinding(profile);
}

export function loadReleaseTargetProfile(
  targetId: string,
): ReleaseTargetProfile {
  const raw = JSON.parse(readFileSync(targetCatalogPath(), "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("release_target_catalog_invalid");
  }
  const catalog = raw as ReleaseTargetCatalog;
  if (
    catalog.schemaVersion !== "tiangong.release-target-catalog.v1" ||
    !Array.isArray(catalog.targets)
  ) {
    throw new Error("release_target_catalog_invalid");
  }
  const profiles = catalog.targets.map(assertTargetProfile);
  if (
    new Set(profiles.map((profile) => profile.targetId)).size !==
    profiles.length
  ) {
    throw new Error("release_target_catalog_duplicate");
  }
  const profile = profiles.find((candidate) => candidate.targetId === targetId);
  if (!profile) throw new Error(`release_target_unknown:${targetId}`);
  return profile;
}

export function resolveConfiguredReleaseTarget(input: {
  targetId: string;
  env?: NodeJS.ProcessEnv;
  requireCredential?: boolean;
}): ReleaseTargetBinding {
  const env = input.env ?? process.env;
  const profile = loadReleaseTargetProfile(input.targetId);
  const apiBaseUrl = env.TIANGONG_LCA_API_BASE_URL?.trim();
  const publishableKey = env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!apiBaseUrl) throw new Error("release_target_api_base_url_required");
  if (!publishableKey) {
    throw new Error("release_target_publishable_key_required");
  }
  const observedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const observedPublishableKeySha256 = createHash("sha256")
    .update(publishableKey, "utf8")
    .digest("hex");
  if (
    observedApiBaseUrl !== profile.apiBaseUrl ||
    observedPublishableKeySha256 !== profile.publishableKeySha256
  ) {
    throw new Error(`release_target_environment_mismatch:${input.targetId}`);
  }
  if (input.requireCredential !== false && !env.TIANGONG_LCA_API_KEY?.trim()) {
    throw new Error("release_target_actor_credential_required");
  }
  return releaseTargetBinding(profile);
}

export function sameReleaseTargetBinding(
  left: ReleaseTargetBinding,
  right: ReleaseTargetBinding,
): boolean {
  return (
    canonicalize(left as unknown as JsonValue) ===
    canonicalize(right as unknown as JsonValue)
  );
}

export function targetPlanReference(binding: ReleaseTargetBinding): {
  targetId: string;
  targetFingerprint: string;
} {
  return {
    targetId: binding.targetId,
    targetFingerprint: binding.targetFingerprint,
  };
}
