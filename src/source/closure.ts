import path from "node:path";
import type { JsonValue } from "../contracts/json.js";
import { normalizeUuid } from "../identity/uuid.js";
import { readJsonFile, resolveContainedPath, sha256File } from "../io/files.js";

export type SourceDatasetType =
  | "process"
  | "lifecyclemodel"
  | "flow"
  | "flowproperty"
  | "unitgroup"
  | "lciamethod"
  | "source"
  | "contact";

export type SourceClosureEntry = {
  datasetType: SourceDatasetType;
  role: "unit_process" | "support";
  uuid: string;
  version: string;
  path: string;
  sha256: string;
};

export type SourceClosureManifest = {
  schemaVersion: "tiangong.source-closure.v1";
  datasets: SourceClosureEntry[];
};

export type FrozenSourceDataset = SourceClosureEntry & {
  filePath: string;
  document: JsonValue;
};

export type FrozenSourceClosure = {
  directory: string;
  manifestPath: string;
  manifestSha256: string;
  manifest: SourceClosureManifest;
  datasets: FrozenSourceDataset[];
};

const datasetTypes = new Set<SourceDatasetType>([
  "process",
  "lifecyclemodel",
  "flow",
  "flowproperty",
  "unitgroup",
  "lciamethod",
  "source",
  "contact",
]);
const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/;
const shaPattern = /^[0-9a-f]{64}$/;

export function sourceDatasetKey(input: {
  datasetType: string;
  uuid: string;
  version: string;
}): string {
  return `${input.datasetType}:${input.uuid.toLowerCase()}:${input.version}`;
}

export function assertSourceClosureManifest(
  value: unknown,
): SourceClosureManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source_closure_manifest_invalid");
  }
  const manifest = value as SourceClosureManifest;
  if (
    manifest.schemaVersion !== "tiangong.source-closure.v1" ||
    !Array.isArray(manifest.datasets)
  ) {
    throw new Error("source_closure_schema_unsupported");
  }
  if (manifest.datasets.length === 0) {
    throw new Error("source_closure_empty");
  }
  let previousPath = "";
  const paths = new Set<string>();
  const keys = new Set<string>();
  for (const entry of manifest.datasets) {
    if (!datasetTypes.has(entry.datasetType)) {
      throw new Error(
        `source_closure_dataset_type_invalid:${String(entry.datasetType)}`,
      );
    }
    entry.uuid = normalizeUuid(entry.uuid);
    if (!versionPattern.test(entry.version) || !shaPattern.test(entry.sha256)) {
      throw new Error(`source_closure_dataset_identity_invalid:${entry.path}`);
    }
    if (entry.role !== "unit_process" && entry.role !== "support") {
      throw new Error(`source_closure_dataset_role_invalid:${entry.path}`);
    }
    if (!entry.path || entry.path <= previousPath || paths.has(entry.path)) {
      throw new Error(`source_closure_paths_not_strictly_sorted:${entry.path}`);
    }
    previousPath = entry.path;
    paths.add(entry.path);
    const key = sourceDatasetKey(entry);
    if (keys.has(key)) {
      throw new Error(`source_closure_dataset_duplicate:${key}`);
    }
    keys.add(key);
  }
  return manifest;
}

export async function loadFrozenSourceClosure(input: {
  directory: string;
  manifestHash: string;
}): Promise<FrozenSourceClosure> {
  const directory = path.resolve(input.directory);
  const manifestPath = path.join(directory, "manifest.json");
  const manifestSha256 = await sha256File(manifestPath);
  if (manifestSha256 !== input.manifestHash) {
    throw new Error("source_closure_manifest_hash_mismatch");
  }
  const manifest = assertSourceClosureManifest(
    readJsonFile<unknown>(manifestPath),
  );
  const datasets: FrozenSourceDataset[] = [];
  for (const entry of manifest.datasets) {
    const filePath = resolveContainedPath(directory, entry.path);
    if ((await sha256File(filePath)) !== entry.sha256) {
      throw new Error(`source_closure_dataset_hash_mismatch:${entry.path}`);
    }
    datasets.push({
      ...entry,
      filePath,
      document: readJsonFile<JsonValue>(filePath),
    });
  }
  return { directory, manifestPath, manifestSha256, manifest, datasets };
}

export function sourceDatasetIndex(
  closure: FrozenSourceClosure,
): Map<string, FrozenSourceDataset> {
  return new Map(
    closure.datasets.map((dataset) => [sourceDatasetKey(dataset), dataset]),
  );
}
