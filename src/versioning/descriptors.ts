import { canonicalSha256 } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import type { GeneratedDatasetDraft } from "../materialization/types.js";
import {
  assertCanonicalIdentityCollisionFree,
  resolvePublicDatasetVersion,
  type PreviousVersionDescriptor,
} from "./dataset-version.js";

type JsonRecord = Record<string, any>;

export type DatasetDescriptorRecord = {
  schemaVersion: "tiangong.release.dataset-descriptor.v1";
  datasetType: "process" | "lifecyclemodel";
  role: "result_process" | "lifecycle_model";
  processIndex: number;
  uuid: string;
  version: string;
  sourceProcess: { id: string; version: string };
  versionSignificantHash: string;
  semanticHash: string;
  canonicalContentHash: string;
  document: JsonValue;
};

export type PreviousReleaseDataset = PreviousVersionDescriptor & {
  datasetType: string;
  role: string;
};

const excludedVersionFields = new Set([
  "common:dataSetVersion",
  "common:dateOfLastRevision",
  "common:permanentDataSetURI",
  "common:referenceToPrecedingDataSetVersion",
  "common:timeStamp",
]);

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("generated_dataset_document_invalid");
  }
  return value as JsonRecord;
}

function stripVersionExcluded(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(stripVersionExcluded);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !excludedVersionFields.has(key))
        .map(([key, item]) => [key, stripVersionExcluded(item)]),
    );
  }
  return value;
}

function normalizedArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function modelSemanticProjection(document: JsonRecord): JsonValue {
  const dataSet = record(document.lifeCycleModelDataSet);
  const information = record(dataSet.lifeCycleModelInformation);
  const dataSetInformation = record(information.dataSetInformation);
  const instances = normalizedArray(
    information.technology?.processes?.processInstance,
  ).map((value) => {
    const instance = record(value);
    const reference = record(instance.referenceToProcess);
    return {
      id: String(instance["@dataSetInternalID"]),
      multiplicationFactor: String(instance["@multiplicationFactor"]),
      process: {
        uuid: String(reference["@refObjectId"]).toLowerCase(),
        version: String(reference["@version"]),
      },
      connections: (instance.connections ?? null) as JsonValue,
    };
  });
  const resulting = record(dataSetInformation.referenceToResultingProcess);
  return {
    schema: "tiangong.release.lifecycle-model-semantic.v1",
    profileId: "resolved-one-hop-aggregated-background.v1",
    uuid: String(dataSetInformation["common:UUID"]).toLowerCase(),
    quantitativeReference: information.quantitativeReference as JsonValue,
    resultingProcess: {
      uuid: String(resulting["@refObjectId"]).toLowerCase(),
      version: String(resulting["@version"]),
    },
    processInstances: instances as JsonValue,
  };
}

function resultSemanticProjection(document: JsonRecord): JsonValue {
  const dataSet = record(document.processDataSet);
  const information = record(dataSet.processInformation);
  const dataSetInformation = record(information.dataSetInformation);
  const exchanges = normalizedArray(dataSet.exchanges?.exchange).map(
    (value) => {
      const exchange = record(value);
      const flow = record(exchange.referenceToFlowDataSet);
      return {
        internalId: String(exchange["@dataSetInternalID"]),
        flow: {
          uuid: String(flow["@refObjectId"]).toLowerCase(),
          version: String(flow["@version"]),
        },
        location: (exchange.location ?? null) as JsonValue,
        direction: String(exchange.exchangeDirection),
        meanAmount: String(exchange.meanAmount),
        resultingAmount: String(exchange.resultingAmount),
      };
    },
  );
  const lcia = normalizedArray(dataSet.LCIAResults?.LCIAResult).map((value) => {
    const result = record(value);
    const method = record(result.referenceToLCIAMethodDataSet);
    return {
      method: {
        uuid: String(method["@refObjectId"]).toLowerCase(),
        version: String(method["@version"]),
      },
      meanAmount: String(result.meanAmount),
    };
  });
  return {
    schema: "tiangong.release.result-process-semantic.v1",
    profileId: "lci-lcia-result.v1",
    uuid: String(dataSetInformation["common:UUID"]).toLowerCase(),
    typeOfDataSet: String(
      dataSet.modellingAndValidation?.LCIMethodAndAllocation?.typeOfDataSet,
    ),
    quantitativeReference: information.quantitativeReference as JsonValue,
    exchanges: exchanges as JsonValue,
    lciaResults: lcia as JsonValue,
  };
}

export function datasetHashes(draft: GeneratedDatasetDraft): {
  versionSignificantHash: string;
  semanticHash: string;
  canonicalContentHash: string;
} {
  const document = record(draft.document);
  return {
    versionSignificantHash: canonicalSha256(
      stripVersionExcluded(draft.document),
    ),
    semanticHash: canonicalSha256(
      draft.datasetType === "lifecyclemodel"
        ? modelSemanticProjection(document)
        : resultSemanticProjection(document),
    ),
    canonicalContentHash: canonicalSha256(draft.document),
  };
}

function updateGeneratedReferences(
  value: JsonValue,
  versions: Map<string, string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => updateGeneratedReferences(item, versions));
    return;
  }
  if (!value || typeof value !== "object") return;
  const item = value as JsonRecord;
  const referenceUuid = item["@refObjectId"];
  if (typeof referenceUuid === "string") {
    const version = versions.get(referenceUuid.toLowerCase());
    if (version) {
      item["@version"] = version;
      if (typeof item["@uri"] === "string") {
        item["@uri"] = item["@uri"].replace(
          /[0-9a-f-]{36}(?:_[0-9.]+)?\.(?:json|xml)$/i,
          `${referenceUuid.toLowerCase()}_${version}.json`,
        );
      }
    }
  }
  Object.values(item).forEach((child) =>
    updateGeneratedReferences(child as JsonValue, versions),
  );
}

export function renderDatasetVersion(
  draft: GeneratedDatasetDraft,
  versions: Map<string, string>,
): GeneratedDatasetDraft {
  const rendered = structuredClone(draft);
  updateGeneratedReferences(rendered.document, versions);
  const version = versions.get(rendered.uuid.toLowerCase());
  if (!version) {
    throw new Error(`generated_dataset_version_missing:${rendered.uuid}`);
  }
  const document = record(rendered.document);
  const dataSet = record(
    rendered.datasetType === "lifecyclemodel"
      ? document.lifeCycleModelDataSet
      : document.processDataSet,
  );
  const publication = record(
    dataSet.administrativeInformation?.publicationAndOwnership,
  );
  publication["common:dataSetVersion"] = version;
  const typePath =
    rendered.datasetType === "lifecyclemodel" ? "lifecyclemodel" : "process";
  publication["common:permanentDataSetURI"] =
    `https://lcdn.tiangong.earth/datasetdetail/${typePath}.xhtml?uuid=${rendered.uuid}&version=${version}`;
  return rendered;
}

function previousIndex(
  previous: PreviousReleaseDataset[],
): Map<string, PreviousReleaseDataset> {
  const result = new Map<string, PreviousReleaseDataset>();
  for (const dataset of previous) {
    const key = `${dataset.datasetType}:${dataset.uuid.toLowerCase()}`;
    const existing = result.get(key);
    if (existing) {
      throw new Error(`previous_release_lineage_duplicate:${key}`);
    }
    result.set(key, dataset);
  }
  return result;
}

function versionsEqual(
  left: Map<string, string>,
  right: Map<string, string>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([uuid, version]) => right.get(uuid) === version)
  );
}

export function resolveGeneratedVersionSet(input: {
  drafts: GeneratedDatasetDraft[];
  previous: PreviousReleaseDataset[];
  maxRounds?: number;
}): DatasetDescriptorRecord[] {
  const previous = previousIndex(input.previous);
  let versions = new Map(
    input.drafts.map((draft) => [
      draft.uuid.toLowerCase(),
      previous.get(`${draft.datasetType}:${draft.uuid.toLowerCase()}`)
        ?.version ?? "01.00.000",
    ]),
  );
  const maxRounds = input.maxRounds ?? 2;
  for (let round = 0; round < maxRounds; round += 1) {
    const next = new Map<string, string>();
    for (const draft of input.drafts) {
      const rendered = renderDatasetVersion(draft, versions);
      const hashes = datasetHashes(rendered);
      const historical = previous.get(
        `${draft.datasetType}:${draft.uuid.toLowerCase()}`,
      );
      const resolution = resolvePublicDatasetVersion(
        { uuid: draft.uuid, ...hashes },
        historical,
      );
      next.set(draft.uuid.toLowerCase(), resolution.version);
    }
    if (versionsEqual(versions, next)) {
      versions = next;
      break;
    }
    versions = next;
    if (round === maxRounds - 1) {
      const check = new Map<string, string>();
      for (const draft of input.drafts) {
        const hashes = datasetHashes(renderDatasetVersion(draft, versions));
        const historical = previous.get(
          `${draft.datasetType}:${draft.uuid.toLowerCase()}`,
        );
        check.set(
          draft.uuid.toLowerCase(),
          resolvePublicDatasetVersion(
            { uuid: draft.uuid, ...hashes },
            historical,
          ).version,
        );
      }
      if (!versionsEqual(versions, check)) {
        throw new Error("version_set_not_converged");
      }
    }
  }

  return input.drafts
    .map((draft): DatasetDescriptorRecord => {
      const rendered = renderDatasetVersion(draft, versions);
      const hashes = datasetHashes(rendered);
      const version = versions.get(draft.uuid.toLowerCase())!;
      const historical = previous.get(
        `${draft.datasetType}:${draft.uuid.toLowerCase()}`,
      );
      assertCanonicalIdentityCollisionFree({
        datasetType: draft.datasetType,
        uuid: draft.uuid,
        version,
        canonicalContentHash: hashes.canonicalContentHash,
        ...(historical?.version === version
          ? { registeredCanonicalContentHash: historical.canonicalContentHash }
          : {}),
      });
      return {
        schemaVersion: "tiangong.release.dataset-descriptor.v1",
        datasetType: draft.datasetType,
        role: draft.role,
        processIndex: draft.processIndex,
        uuid: draft.uuid,
        version,
        sourceProcess: rendered.sourceProcess,
        ...hashes,
        document: rendered.document,
      };
    })
    .sort(
      (left, right) =>
        left.datasetType.localeCompare(right.datasetType) ||
        left.uuid.localeCompare(right.uuid),
    );
}
