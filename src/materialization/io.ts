import { readFileSync } from "node:fs";
import { canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import { writeTextAtomic } from "../io/files.js";
import type { DerivedIdentityRecord, GeneratedDatasetDraft } from "./types.js";
import type { DatasetDescriptorRecord } from "../versioning/descriptors.js";

function readLines<T>(filePath: string): T[] {
  const text = readFileSync(filePath, "utf8");
  if (!text.endsWith("\n")) {
    throw new Error(`ndjson_final_newline_missing:${filePath}`);
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.some((line) => !line)) {
    throw new Error(`ndjson_empty_line:${filePath}`);
  }
  return lines.map((line) => JSON.parse(line) as T);
}

export function readDerivedIdentities(
  filePath: string,
): DerivedIdentityRecord[] {
  return readLines<DerivedIdentityRecord>(filePath);
}

export function readGeneratedDrafts(filePath: string): GeneratedDatasetDraft[] {
  return readLines<GeneratedDatasetDraft>(filePath);
}

export function readDatasetDescriptors(
  filePath: string,
): DatasetDescriptorRecord[] {
  return readLines<DatasetDescriptorRecord>(filePath);
}

export function writeGeneratedDrafts(
  filePath: string,
  drafts: GeneratedDatasetDraft[],
): void {
  const ordered = [...drafts].sort(
    (left, right) =>
      left.processIndex - right.processIndex ||
      left.role.localeCompare(right.role),
  );
  writeTextAtomic(
    filePath,
    `${ordered.map((draft) => canonicalize(draft as unknown as JsonValue)).join("\n")}\n`,
  );
}

export function writeDatasetDescriptors(
  filePath: string,
  descriptors: DatasetDescriptorRecord[],
): void {
  writeTextAtomic(
    filePath,
    `${descriptors
      .map((descriptor) => canonicalize(descriptor as unknown as JsonValue))
      .join("\n")}\n`,
  );
}
