import { canonicalSha256 } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import type { CalculationBundleManifest } from "./types.js";

export function calculationBundleHashInput(
  manifest: CalculationBundleManifest,
): JsonValue {
  const {
    bundleContentHash: _bundleContentHash,
    createdAt: _createdAt,
    ...hashInput
  } = manifest;
  return hashInput as unknown as JsonValue;
}

export function calculateBundleContentHash(
  manifest: CalculationBundleManifest,
): string {
  return canonicalSha256(calculationBundleHashInput(manifest));
}

export function assertCalculationBundleManifest(
  value: unknown,
): CalculationBundleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("calculation_bundle_manifest_invalid");
  }
  const manifest = value as CalculationBundleManifest;
  if (manifest.schemaVersion !== "tiangong.calculation-bundle.v1") {
    throw new Error("calculation_bundle_schema_unsupported");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 8) {
    throw new Error("calculation_bundle_artifacts_incomplete");
  }
  if (
    !Number.isSafeInteger(manifest.scope?.processCount) ||
    manifest.scope.processCount < 1
  ) {
    throw new Error("calculation_bundle_process_count_invalid");
  }
  if (manifest.snapshot?.processCount !== manifest.scope.processCount) {
    throw new Error("calculation_bundle_snapshot_process_count_mismatch");
  }
  const paths = manifest.artifacts.map((artifact) => artifact.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("calculation_bundle_artifact_path_duplicate");
  }
  const sortedPaths = [...paths].sort();
  if (paths.some((item, index) => item !== sortedPaths[index])) {
    throw new Error("calculation_bundle_artifacts_not_path_sorted");
  }
  return manifest;
}
