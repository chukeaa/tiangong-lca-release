import { canonicalJson, fail, sha256Bytes } from "./common.mjs";

const VERSION = /^(\d{2})\.(\d{2})\.(\d{3})$/;
const EXCLUDED = new Set([
  "common:dataSetVersion",
  "common:dateOfLastRevision",
  "common:permanentDataSetURI",
  "common:referenceToPrecedingDataSetVersion",
  "common:timeStamp",
]);

export function hashJson(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value).trimEnd()));
}

export function versionSignificantHash(document) {
  return hashJson(stripExcluded(document));
}

export function resolveVersion(current, previous) {
  if (!previous) return { version: "01.00.000", change: "initial" };
  if (previous.uuid.toLowerCase() !== current.uuid.toLowerCase()) {
    fail(
      "previous_identity_mismatch",
      `Previous descriptor UUID differs for ${current.uuid}`,
    );
  }
  if (current.semanticHash !== previous.semanticHash) {
    return { version: bump(previous.version, "major"), change: "major" };
  }
  if (current.versionSignificantHash !== previous.versionSignificantHash) {
    return { version: bump(previous.version, "minor"), change: "minor" };
  }
  return { version: previous.version, change: "reuse" };
}

export function indexPrevious(previousManifest) {
  if (!previousManifest) return new Map();
  const datasets =
    previousManifest.datasets ?? previousManifest.resultCatalog?.datasets;
  if (!Array.isArray(datasets)) {
    fail(
      "previous_manifest_invalid",
      "Previous Manifest must contain datasets[]",
    );
  }
  const result = new Map();
  for (const dataset of datasets) {
    for (const field of [
      "datasetType",
      "uuid",
      "version",
      "versionSignificantHash",
      "semanticHash",
      "canonicalContentHash",
    ]) {
      if (typeof dataset[field] !== "string" || !dataset[field]) {
        fail(
          "previous_manifest_invalid",
          `Previous dataset is missing ${field}`,
        );
      }
    }
    if (!VERSION.test(dataset.version)) {
      fail(
        "previous_manifest_invalid",
        `Invalid previous dataset version: ${dataset.version}`,
      );
    }
    const key = `${dataset.datasetType}:${dataset.uuid.toLowerCase()}`;
    if (result.has(key))
      fail("previous_lineage_duplicate", `Duplicate previous lineage: ${key}`);
    result.set(key, dataset);
  }
  return result;
}

export function assertNoContentCollision(descriptor, previous) {
  if (
    previous &&
    previous.version === descriptor.version &&
    previous.canonicalContentHash !== descriptor.canonicalContentHash
  ) {
    fail(
      "dataset_identity_content_conflict",
      `Same identity/version has conflicting content: ${descriptor.datasetType}:${descriptor.uuid}@${descriptor.version}`,
    );
  }
}

function stripExcluded(value) {
  if (Array.isArray(value)) return value.map(stripExcluded);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !EXCLUDED.has(key))
        .map(([key, item]) => [key, stripExcluded(item)]),
    );
  }
  return value;
}

function bump(value, part) {
  const match = VERSION.exec(value);
  if (!match)
    fail("invalid_dataset_version", `Invalid dataset version: ${value}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  if (part === "major") {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
  if (major > 99 || minor > 99)
    fail("dataset_version_overflow", `Cannot bump dataset version: ${value}`);
  return `${String(major).padStart(2, "0")}.${String(minor).padStart(2, "0")}.000`;
}
