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

export function indexPrevious(previousManifest, datasetTypes) {
  const allowed = datasetTypes ? new Set(datasetTypes) : null;
  const datasets = previousDatasets(previousManifest).filter(
    (dataset) => !allowed || allowed.has(dataset.datasetType),
  );
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

export function indexPreviousResultVariants(previousManifest) {
  return indexPreviousExactSourceVariants(previousManifest, "process");
}

export function indexPreviousModelVariants(previousManifest) {
  return indexPreviousExactSourceVariants(previousManifest, "lifecyclemodel");
}

function indexPreviousExactSourceVariants(previousManifest, datasetType) {
  const datasets = previousDatasets(previousManifest).filter(
    (dataset) => dataset.datasetType === datasetType,
  );
  const bySource = new Map();
  const byLineage = new Map();
  for (const dataset of datasets) {
    validatePreviousDataset(dataset);
    const source = dataset.sourceProcess;
    if (
      typeof source?.id !== "string" ||
      !source.id ||
      typeof source.version !== "string" ||
      !source.version
    ) {
      fail(
        "previous_manifest_invalid",
        `Previous ${datasetType} is missing sourceProcess: ${dataset.uuid}@${dataset.version}`,
      );
    }
    const lineageKey = `${datasetType}:${dataset.uuid.toLowerCase()}`;
    const sourceKey = `${lineageKey}:${source.id.toLowerCase()}@${source.version}`;
    if (bySource.has(sourceKey)) {
      fail(
        "previous_source_variant_duplicate",
        `Duplicate previous exact source variant: ${sourceKey}`,
      );
    }
    bySource.set(sourceKey, dataset);
    const variants = byLineage.get(lineageKey) ?? [];
    if (variants.some((variant) => variant.version === dataset.version)) {
      fail(
        "previous_dataset_version_duplicate",
        `Duplicate previous dataset version in lineage: ${lineageKey}@${dataset.version}`,
      );
    }
    variants.push(dataset);
    byLineage.set(lineageKey, variants);
  }
  return { bySource, byLineage };
}

export function resolveExactSourceVariantVersions(
  drafts,
  previous,
  { datasetType, duplicateCode },
) {
  const grouped = new Map();
  for (const draft of drafts) {
    const lineageKey = `${datasetType}:${draft.provisional.uuid}`;
    const variants = grouped.get(lineageKey) ?? [];
    variants.push(draft);
    grouped.set(lineageKey, variants);
  }
  const result = new Map();
  for (const [lineageKey, variants] of grouped) {
    variants.sort(
      (left, right) =>
        compareSourceIdentity(
          left.provisional.sourceProcess,
          right.provisional.sourceProcess,
        ) || left.axis.processIndex - right.axis.processIndex,
    );
    const occupied = new Map(
      (previous.byLineage.get(lineageKey) ?? []).map((dataset) => [
        dataset.version,
        exactSourceVariantKey(lineageKey, dataset.sourceProcess),
      ]),
    );
    const currentSources = new Set();
    for (const draft of variants) {
      const sourceKey = exactSourceVariantKey(
        lineageKey,
        draft.provisional.sourceProcess,
      );
      if (currentSources.has(sourceKey)) {
        fail(
          duplicateCode,
          `Calculation contains the same exact ${datasetType} source variant more than once: ${sourceKey}`,
        );
      }
      currentSources.add(sourceKey);
      const historical = previous.bySource.get(sourceKey);
      let resolution = resolveVersion(
        { uuid: draft.provisional.uuid, ...draft.hashes },
        historical,
      );
      const owner = occupied.get(resolution.version);
      if (owner && owner !== sourceKey) {
        resolution = {
          version: nextFreeMajorVersion(occupied, resolution.version),
          change: historical ? "major" : "initial",
        };
      }
      occupied.set(resolution.version, sourceKey);
      result.set(draft.axis.processIndex, { ...resolution, historical });
    }
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

function previousDatasets(previousManifest) {
  if (!previousManifest) return [];
  const datasets =
    previousManifest.datasets ?? previousManifest.resultCatalog?.datasets;
  if (!Array.isArray(datasets)) {
    fail(
      "previous_manifest_invalid",
      "Previous Manifest must contain datasets[]",
    );
  }
  return datasets;
}

function validatePreviousDataset(dataset) {
  for (const field of [
    "datasetType",
    "uuid",
    "version",
    "versionSignificantHash",
    "semanticHash",
    "canonicalContentHash",
  ]) {
    if (typeof dataset[field] !== "string" || !dataset[field]) {
      fail("previous_manifest_invalid", `Previous dataset is missing ${field}`);
    }
  }
  if (!VERSION.test(dataset.version)) {
    fail(
      "previous_manifest_invalid",
      `Invalid previous dataset version: ${dataset.version}`,
    );
  }
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

function exactSourceVariantKey(lineageKey, sourceProcess) {
  return `${lineageKey}:${sourceProcess.id.toLowerCase()}@${sourceProcess.version}`;
}

function nextFreeMajorVersion(occupied, proposed) {
  let major = Number(String(proposed).slice(0, 2));
  while (major <= 99) {
    const candidate = `${String(major).padStart(2, "0")}.00.000`;
    if (!occupied.has(candidate)) return candidate;
    major += 1;
  }
  fail(
    "dataset_version_overflow",
    `Cannot allocate another exact source variant after ${proposed}`,
  );
}

function compareSourceIdentity(left, right) {
  return (
    left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
  );
}
