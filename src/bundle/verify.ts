import { statSync } from "node:fs";
import path from "node:path";
import { canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import { normalizeUuid } from "../identity/uuid.js";
import {
  resolveContainedPath,
  sha256File,
  sha256GzipContent,
} from "../io/files.js";
import { readNdjsonFile } from "./ndjson.js";
import type {
  BundleProcessRecord,
  BundleInventoryRecord,
  BundleLciaRecord,
  BundleTechnosphereEdgeRecord,
  CalculationBundleArtifact,
  CalculationBundleArtifactKind,
  CalculationBundleManifest,
} from "./types.js";

const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/;
const canonicalKinds: CalculationBundleArtifactKind[] = [
  "process_axis",
  "inventory_axis",
  "technosphere_edges",
  "biosphere_edges",
  "lci",
  "lcia",
  "coverage",
  "source_closure",
];

export type BundleArtifactVerification = {
  path: string;
  kind: CalculationBundleArtifactKind;
  sha256: string;
  uncompressedSha256?: string;
  byteSize: number;
  recordCount: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`bundle_record_integer_invalid:${field}`);
  }
  return value as number;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`bundle_record_number_invalid:${field}`);
  }
  return value;
}

export function assertBundleProcessRecord(value: unknown): BundleProcessRecord {
  const item = record(value);
  const rootProcess = record(item?.rootProcess);
  const quantitativeReference = record(item?.quantitativeReference);
  const flow = record(quantitativeReference?.flow);
  if (!item || !rootProcess || !quantitativeReference || !flow) {
    throw new Error("bundle_process_record_invalid");
  }
  const processIndex = safeInteger(item.processIndex, "processIndex");
  const rootId = normalizeUuid(String(rootProcess.id ?? ""));
  const rootVersion = String(rootProcess.version ?? "");
  const flowId = normalizeUuid(String(flow.id ?? ""));
  const flowVersion = String(flow.version ?? "");
  const exchangeInternalId = String(
    quantitativeReference.exchangeInternalId ?? "",
  ).trim();
  const referenceUnit = String(
    quantitativeReference.referenceUnit ?? "",
  ).trim();
  if (!versionPattern.test(rootVersion) || !versionPattern.test(flowVersion)) {
    throw new Error("bundle_process_version_invalid");
  }
  if (
    !exchangeInternalId ||
    !referenceUnit ||
    quantitativeReference.direction !== "Output"
  ) {
    throw new Error("bundle_process_quantitative_reference_invalid");
  }
  const meanAmount = finite(
    quantitativeReference.meanAmount,
    "quantitativeReference.meanAmount",
  );
  if (meanAmount === 0) {
    throw new Error("bundle_process_quantitative_reference_zero");
  }
  return {
    processIndex,
    rootProcess: { id: rootId, version: rootVersion },
    quantitativeReference: {
      exchangeInternalId,
      flow: { id: flowId, version: flowVersion },
      direction: "Output",
      referenceUnit,
      meanAmount,
    },
  };
}

function assertTechnosphereRecord(value: unknown): void {
  const item = record(value);
  const flow = record(item?.flow);
  if (!item || !flow) {
    throw new Error("bundle_technosphere_record_invalid");
  }
  safeInteger(item.consumerProcessIndex, "consumerProcessIndex");
  safeInteger(item.providerProcessIndex, "providerProcessIndex");
  if (
    !String(item.consumerInputExchangeInternalId ?? "").trim() ||
    !String(item.providerOutputExchangeInternalId ?? "").trim()
  ) {
    throw new Error("bundle_technosphere_exchange_identity_missing");
  }
  finite(item.providerWeight, "providerWeight");
  finite(item.normalizedAmount, "normalizedAmount");
  normalizeUuid(String(flow.id ?? ""));
  if (!versionPattern.test(String(flow.version ?? ""))) {
    throw new Error("bundle_technosphere_flow_version_invalid");
  }
}

export function parseTechnosphereRecord(
  value: unknown,
): BundleTechnosphereEdgeRecord {
  assertTechnosphereRecord(value);
  const item = value as Record<string, unknown>;
  const flow = item.flow as Record<string, unknown>;
  const location = item.location;
  return {
    consumerProcessIndex: item.consumerProcessIndex as number,
    consumerInputExchangeInternalId: String(
      item.consumerInputExchangeInternalId,
    ),
    providerProcessIndex: item.providerProcessIndex as number,
    providerOutputExchangeInternalId: String(
      item.providerOutputExchangeInternalId,
    ),
    providerWeight: item.providerWeight as number,
    normalizedAmount: item.normalizedAmount as number,
    flow: { id: normalizeUuid(String(flow.id)), version: String(flow.version) },
    ...(location === undefined
      ? {}
      : { location: location === null ? null : String(location) }),
  };
}

function assertInventoryLikeRecord(value: unknown, kind: string): void {
  const item = record(value);
  const flow = record(item?.flow);
  if (!item || !flow) {
    throw new Error(`bundle_${kind}_record_invalid`);
  }
  normalizeUuid(String(flow.id ?? ""));
  if (!versionPattern.test(String(flow.version ?? ""))) {
    throw new Error(`bundle_${kind}_flow_version_invalid`);
  }
  if (item.direction !== "Input" && item.direction !== "Output") {
    throw new Error(`bundle_${kind}_direction_invalid`);
  }
  if (!String(item.unit ?? "").trim()) {
    throw new Error(`bundle_${kind}_unit_missing`);
  }
  if ("meanAmount" in item) {
    finite(item.meanAmount, "meanAmount");
  }
  if (kind === "inventory_axis" || kind === "biosphere_edges") {
    safeInteger(item.processIndex, "processIndex");
    if (!String(item.exchangeInternalId ?? "").trim()) {
      throw new Error(`bundle_${kind}_exchange_identity_missing`);
    }
    if (!String(item.allocationTargetInternalId ?? "").trim()) {
      throw new Error(`bundle_${kind}_allocation_target_missing`);
    }
    finite(item.allocationFraction, "allocationFraction");
  }
}

export function parseInventoryRecord(
  value: unknown,
  kind = "lci",
): BundleInventoryRecord {
  assertInventoryLikeRecord(value, kind);
  const item = value as Record<string, unknown>;
  const flow = item.flow as Record<string, unknown>;
  const exchangeInternalId = item.exchangeInternalId;
  const location = item.location;
  const allocationTargetInternalId = item.allocationTargetInternalId;
  const allocationFraction = item.allocationFraction;
  return {
    processIndex: safeInteger(item.processIndex, "processIndex"),
    ...(exchangeInternalId === undefined
      ? {}
      : { exchangeInternalId: String(exchangeInternalId) }),
    flow: { id: normalizeUuid(String(flow.id)), version: String(flow.version) },
    direction: item.direction as "Input" | "Output",
    unit: String(item.unit),
    ...(location === undefined
      ? {}
      : { location: location === null ? null : String(location) }),
    meanAmount: finite(item.meanAmount, "meanAmount"),
    ...(allocationTargetInternalId === undefined
      ? {}
      : { allocationTargetInternalId: String(allocationTargetInternalId) }),
    ...(allocationFraction === undefined
      ? {}
      : {
          allocationFraction: finite(allocationFraction, "allocationFraction"),
        }),
  };
}

export function parseLciaRecord(value: unknown): BundleLciaRecord {
  const item = record(value);
  const method = record(item?.method);
  if (!item || !method) {
    throw new Error("bundle_lcia_record_invalid");
  }
  const version = String(method.version ?? "");
  if (!versionPattern.test(version)) {
    throw new Error("bundle_lcia_method_version_invalid");
  }
  return {
    processIndex: safeInteger(item.processIndex, "processIndex"),
    method: { id: normalizeUuid(String(method.id ?? "")), version },
    meanAmount: finite(item.meanAmount, "meanAmount"),
  };
}

export async function verifyBundleArtifacts(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<BundleArtifactVerification[]> {
  for (const kind of canonicalKinds) {
    if (
      !manifest.artifacts.some(
        (artifact) => artifact.kind === kind && !artifact.derived,
      )
    ) {
      throw new Error(`calculation_bundle_artifact_kind_missing:${kind}`);
    }
  }
  const verifications: BundleArtifactVerification[] = [];
  for (const artifact of manifest.artifacts) {
    const filePath = resolveContainedPath(bundleDirectory, artifact.path);
    const byteSize = statSync(filePath).size;
    if (byteSize !== artifact.byteSize) {
      throw new Error(
        `calculation_bundle_artifact_size_mismatch:${artifact.path}`,
      );
    }
    const sha256 = await sha256File(filePath);
    if (sha256 !== artifact.sha256) {
      throw new Error(
        `calculation_bundle_artifact_hash_mismatch:${artifact.path}`,
      );
    }
    const verification: BundleArtifactVerification = {
      path: artifact.path,
      kind: artifact.kind,
      sha256,
      byteSize,
      recordCount: artifact.recordCount,
    };
    if (artifact.compression === "gzip" && artifact.uncompressedSha256) {
      const uncompressedSha256 = await sha256GzipContent(filePath);
      if (uncompressedSha256 !== artifact.uncompressedSha256) {
        throw new Error(
          `calculation_bundle_uncompressed_hash_mismatch:${artifact.path}`,
        );
      }
      verification.uncompressedSha256 = uncompressedSha256;
    }
    verifications.push(verification);
  }
  return verifications;
}

export async function loadBundleProcessRecords(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<BundleProcessRecord[]> {
  const artifacts = manifest.artifacts.filter(
    (artifact) => artifact.kind === "process_axis",
  );
  const records: BundleProcessRecord[] = [];
  for (const artifact of artifacts) {
    const filePath = resolveContainedPath(bundleDirectory, artifact.path);
    let artifactCount = 0;
    for await (const value of readNdjsonFile<unknown>(
      filePath,
      artifact.compression ?? "none",
    )) {
      const parsed = assertBundleProcessRecord(value);
      canonicalize(parsed as unknown as JsonValue);
      records.push(parsed);
      artifactCount += 1;
    }
    if (artifactCount !== artifact.recordCount) {
      throw new Error(
        `calculation_bundle_record_count_mismatch:${artifact.path}`,
      );
    }
  }
  records.sort((left, right) => left.processIndex - right.processIndex);
  if (records.length !== manifest.scope.processCount) {
    throw new Error("calculation_bundle_process_axis_count_mismatch");
  }
  records.forEach((item, index) => {
    if (item.processIndex !== index) {
      throw new Error(`calculation_bundle_process_index_gap:${index}`);
    }
  });
  return records;
}

export async function verifyGraphEvidenceRecords(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const artifact of manifest.artifacts.filter((item) =>
    ["inventory_axis", "technosphere_edges", "biosphere_edges"].includes(
      item.kind,
    ),
  )) {
    const filePath = resolveContainedPath(bundleDirectory, artifact.path);
    let count = 0;
    for await (const value of readNdjsonFile<unknown>(
      filePath,
      artifact.compression ?? "none",
    )) {
      if (artifact.kind === "technosphere_edges") {
        assertTechnosphereRecord(value);
      } else {
        assertInventoryLikeRecord(value, artifact.kind);
      }
      count += 1;
    }
    if (count !== artifact.recordCount) {
      throw new Error(
        `calculation_bundle_record_count_mismatch:${artifact.path}`,
      );
    }
    counts[artifact.kind] = (counts[artifact.kind] ?? 0) + count;
  }
  return counts;
}

async function loadRecords<T>(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
  kind: CalculationBundleArtifactKind,
  parse: (value: unknown) => T,
): Promise<T[]> {
  const records: T[] = [];
  for (const artifact of manifest.artifacts.filter(
    (item) => item.kind === kind && !item.derived,
  )) {
    const filePath = resolveContainedPath(bundleDirectory, artifact.path);
    let artifactCount = 0;
    for await (const value of readNdjsonFile<unknown>(
      filePath,
      artifact.compression ?? "none",
    )) {
      records.push(parse(value));
      artifactCount += 1;
    }
    if (artifactCount !== artifact.recordCount) {
      throw new Error(
        `calculation_bundle_record_count_mismatch:${artifact.path}`,
      );
    }
  }
  return records;
}

export function loadTechnosphereRecords(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<BundleTechnosphereEdgeRecord[]> {
  return loadRecords(
    manifest,
    bundleDirectory,
    "technosphere_edges",
    parseTechnosphereRecord,
  );
}

export function loadLciRecords(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<BundleInventoryRecord[]> {
  return loadRecords(manifest, bundleDirectory, "lci", (value) =>
    parseInventoryRecord(value),
  );
}

export function loadLciaRecords(
  manifest: CalculationBundleManifest,
  bundleDirectory: string,
): Promise<BundleLciaRecord[]> {
  return loadRecords(manifest, bundleDirectory, "lcia", parseLciaRecord);
}

export function bundleDirectoryForManifest(manifestPath: string): string {
  return path.dirname(path.resolve(manifestPath));
}
