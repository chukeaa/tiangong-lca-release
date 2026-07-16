import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { canonicalSha256 } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import { ensureDirectory, sha256File, writeJsonAtomic } from "../io/files.js";
import type {
  FrozenSourceClosure,
  SourceDatasetType,
} from "../source/closure.js";
import type { DatasetDescriptorRecord } from "../versioning/descriptors.js";

const categoryByType: Record<SourceDatasetType | "lifecyclemodel", string> = {
  process: "processes",
  lifecyclemodel: "lifecyclemodels",
  flow: "flows",
  flowproperty: "flowproperties",
  unitgroup: "unitgroups",
  lciamethod: "lciamethods",
  source: "sources",
  contact: "contacts",
};

export type CanonicalDatasetIndexEntry = {
  datasetType: string;
  role: string;
  uuid: string;
  version: string;
  path: string;
  sha256: string;
  byteSize: number;
  canonicalContentHash: string;
};

export async function buildCanonicalTidasTree(input: {
  outputDirectory: string;
  sourceClosure: FrozenSourceClosure;
  generated: DatasetDescriptorRecord[];
}): Promise<CanonicalDatasetIndexEntry[]> {
  const outputDirectory = path.resolve(input.outputDirectory);
  const temporary = `${outputDirectory}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  ensureDirectory(temporary);
  const index: CanonicalDatasetIndexEntry[] = [];

  for (const source of input.sourceClosure.datasets) {
    const category = categoryByType[source.datasetType];
    const relativePath = `${category}/${source.uuid}_${source.version}.json`;
    const target = path.join(temporary, relativePath);
    ensureDirectory(path.dirname(target));
    copyFileSync(source.filePath, target);
    index.push({
      datasetType: source.datasetType,
      role: source.role,
      uuid: source.uuid,
      version: source.version,
      path: relativePath,
      sha256: await sha256File(target),
      byteSize: statSync(target).size,
      canonicalContentHash: canonicalSha256(source.document),
    });
  }

  for (const generated of input.generated) {
    const category = categoryByType[generated.datasetType];
    const relativePath = `${category}/${generated.uuid}_${generated.version}.json`;
    if (index.some((entry) => entry.path === relativePath)) {
      throw new Error(`canonical_dataset_path_conflict:${relativePath}`);
    }
    const target = path.join(temporary, relativePath);
    writeJsonAtomic(target, generated.document);
    index.push({
      datasetType: generated.datasetType,
      role: generated.role,
      uuid: generated.uuid,
      version: generated.version,
      path: relativePath,
      sha256: await sha256File(target),
      byteSize: statSync(target).size,
      canonicalContentHash: generated.canonicalContentHash,
    });
  }

  index.sort(
    (left, right) =>
      left.datasetType.localeCompare(right.datasetType) ||
      left.uuid.localeCompare(right.uuid) ||
      left.version.localeCompare(right.version),
  );
  if (existsSync(outputDirectory)) {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
  renameSync(temporary, outputDirectory);
  return index;
}

export function canonicalIndexDocument(
  entries: CanonicalDatasetIndexEntry[],
): JsonValue {
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: entries.length,
    byteSize: entries.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: canonicalSha256(entries as unknown as JsonValue),
    datasets: entries as unknown as JsonValue,
  };
}
