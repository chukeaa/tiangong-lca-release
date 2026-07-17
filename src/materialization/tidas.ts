import type {
  BundleInventoryRecord,
  BundleLciaRecord,
  BundleProcessRecord,
  BundleTechnosphereEdgeRecord,
} from "../bundle/types.js";
import type { JsonValue } from "../contracts/json.js";
import { resolveSingleQuantitativeReference } from "../identity/quantitative-reference.js";
import { normalizeUuid } from "../identity/uuid.js";
import {
  sourceDatasetIndex,
  sourceDatasetKey,
  type FrozenSourceClosure,
} from "../source/closure.js";
import type { DerivedIdentityRecord, GeneratedDatasetDraft } from "./types.js";

type JsonRecord = Record<string, any>;

function object(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as JsonRecord;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function finiteString(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(`materialization_non_finite:${field}`);
  }
  return String(value);
}

function globalReference(input: {
  type: string;
  category: string;
  uuid: string;
  version: string;
  description: string;
}): JsonRecord {
  return {
    "@refObjectId": normalizeUuid(input.uuid),
    "@type": input.type,
    "@uri": `../${input.category}/${normalizeUuid(input.uuid)}_${input.version}.json`,
    "@version": input.version,
    "common:shortDescription": {
      "@xml:lang": "en",
      "#text": input.description,
    },
  };
}

function appendEnglishSuffix(value: unknown, suffix: string): unknown {
  const copy = clone(value);
  const items = Array.isArray(copy) ? copy : [copy];
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const localized = item as JsonRecord;
      if (
        localized["@xml:lang"] === "en" &&
        typeof localized["#text"] === "string"
      ) {
        localized["#text"] = `${localized["#text"]} — ${suffix}`;
      }
    }
  }
  return Array.isArray(copy) ? items : items[0];
}

function sourceProcessDocument(
  closure: FrozenSourceClosure,
  process: BundleProcessRecord,
): JsonRecord {
  const source = sourceDatasetIndex(closure).get(
    sourceDatasetKey({
      datasetType: "process",
      uuid: process.rootProcess.id,
      version: process.rootProcess.version,
    }),
  );
  if (!source || source.role !== "unit_process") {
    throw new Error(
      `source_unit_process_missing:${process.rootProcess.id}:${process.rootProcess.version}`,
    );
  }
  const document = object(
    source.document,
    "source_unit_process_document_invalid",
  );
  const dataSet = object(
    document.processDataSet,
    "source_unit_process_dataset_invalid",
  );
  const sourceUuid = normalizeUuid(
    String(
      dataSet.processInformation?.dataSetInformation?.["common:UUID"] ?? "",
    ),
  );
  const sourceVersion = String(
    dataSet.administrativeInformation?.publicationAndOwnership?.[
      "common:dataSetVersion"
    ] ?? "",
  );
  if (
    sourceUuid !== process.rootProcess.id ||
    sourceVersion !== process.rootProcess.version
  ) {
    throw new Error(
      `source_unit_process_identity_mismatch:${process.processIndex}`,
    );
  }
  const resolved = resolveSingleQuantitativeReference(document);
  if (
    resolved.exchangeInternalId !==
      process.quantitativeReference.exchangeInternalId ||
    resolved.flowUuid !== process.quantitativeReference.flow.id ||
    resolved.flowVersion !== process.quantitativeReference.flow.version ||
    resolved.meanAmount !== process.quantitativeReference.meanAmount
  ) {
    throw new Error(
      `source_unit_process_quantitative_reference_mismatch:${process.processIndex}`,
    );
  }
  return document;
}

function identityByProcessIndex(
  identities: DerivedIdentityRecord[],
): Map<number, DerivedIdentityRecord> {
  const result = new Map<number, DerivedIdentityRecord>();
  for (const identity of identities) {
    if (result.has(identity.processIndex)) {
      throw new Error(
        `derived_identity_process_index_duplicate:${identity.processIndex}`,
      );
    }
    result.set(identity.processIndex, identity);
  }
  return result;
}

function modelAdministrativeInformation(
  sourceDataSet: JsonRecord,
  modelUuid: string,
): JsonRecord {
  const administrativeInformation = clone(
    object(
      sourceDataSet.administrativeInformation,
      "source_process_administrative_missing",
    ),
  );
  const publication = object(
    administrativeInformation.publicationAndOwnership,
    "source_process_publication_missing",
  );
  publication["common:dataSetVersion"] = "01.00.000";
  publication["common:permanentDataSetURI"] =
    `https://lcdn.tiangong.earth/datasetdetail/lifecyclemodel.xhtml?uuid=${modelUuid}&version=01.00.000`;
  return administrativeInformation;
}

function modelValidation(sourceDataSet: JsonRecord): JsonRecord {
  const modelling = object(
    sourceDataSet.modellingAndValidation,
    "source_process_modelling_missing",
  );
  const compliance = object(
    modelling.complianceDeclarations,
    "source_process_compliance_declarations_missing",
  );
  const person = object(
    sourceDataSet.administrativeInformation?.dataEntryBy?.[
      "common:referenceToPersonOrEntityEnteringTheData"
    ],
    "source_process_data_entry_person_missing",
  );
  return {
    validation: {
      review: {
        "common:referenceToNameOfReviewerAndInstitution": clone(person),
      },
    },
    complianceDeclarations: clone(compliance),
  };
}

export function projectModelDrafts(input: {
  processes: BundleProcessRecord[];
  identities: DerivedIdentityRecord[];
  edges: BundleTechnosphereEdgeRecord[];
  sourceClosure: FrozenSourceClosure;
}): GeneratedDatasetDraft[] {
  const identities = identityByProcessIndex(input.identities);
  return input.processes.map((process) => {
    const identity = identities.get(process.processIndex);
    if (!identity) {
      throw new Error(`derived_identity_missing:${process.processIndex}`);
    }
    const source = sourceProcessDocument(input.sourceClosure, process);
    const sourceDataSet = object(
      source.processDataSet,
      "source_unit_process_dataset_invalid",
    );
    const sourceInformation = object(
      sourceDataSet.processInformation,
      "source_process_information_missing",
    );
    const sourceDataSetInformation = object(
      sourceInformation.dataSetInformation,
      "source_process_dataset_information_missing",
    );
    const sourceName = object(
      sourceDataSetInformation.name,
      "source_process_name_missing",
    );
    const directEdges = input.edges
      .filter((edge) => edge.consumerProcessIndex === process.processIndex)
      .sort(
        (left, right) =>
          left.consumerInputExchangeInternalId.localeCompare(
            right.consumerInputExchangeInternalId,
          ) || left.providerProcessIndex - right.providerProcessIndex,
      );
    const processInstances: JsonRecord[] = [
      {
        "@dataSetInternalID": "0",
        "@multiplicationFactor": "1",
        referenceToProcess: globalReference({
          type: "process data set",
          category: "processes",
          uuid: process.rootProcess.id,
          version: process.rootProcess.version,
          description: "Root Unit Process",
        }),
      },
    ];
    directEdges.forEach((edge, index) => {
      const providerIdentity = identities.get(edge.providerProcessIndex);
      if (!providerIdentity) {
        throw new Error(
          `provider_result_identity_missing:${edge.providerProcessIndex}`,
        );
      }
      const factor = edge.normalizedAmount * edge.providerWeight;
      processInstances.push({
        "@dataSetInternalID": String(index + 1),
        "@multiplicationFactor": finiteString(
          factor,
          "providerMultiplicationFactor",
        ),
        referenceToProcess: globalReference({
          type: "process data set",
          category: "processes",
          uuid: providerIdentity.resultProcessUuid,
          version: "01.00.000",
          description: "Provider Result Process",
        }),
        connections: {
          outputExchange: {
            "@flowUUID": edge.flow.id,
            "@version": edge.flow.version,
            downstreamProcess: {
              "@id": "0",
              "@flowUUID": edge.flow.id,
              "@version": edge.flow.version,
              ...(edge.location ? { "@location": edge.location } : {}),
            },
          },
        },
      });
    });

    const document = {
      lifeCycleModelDataSet: {
        "@xmlns": "http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017",
        "@xmlns:acme": "http://acme.com/custom",
        "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
        "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "@locations": "../ILCDLocations.xml",
        "@version": "1.1",
        "@xsi:schemaLocation":
          "http://eplca.jrc.ec.europa.eu/ILCD/LifeCycleModel/2017 ../../schemas/ILCD_LifeCycleModelDataSet.xsd",
        lifeCycleModelInformation: {
          dataSetInformation: {
            "common:UUID": identity.modelUuid,
            name: {
              ...clone(sourceName),
              baseName: appendEnglishSuffix(
                sourceName.baseName,
                "generated one-hop lifecycle model",
              ),
            },
            classificationInformation: clone(
              sourceDataSetInformation.classificationInformation,
            ),
            referenceToResultingProcess: globalReference({
              type: "process data set",
              category: "processes",
              uuid: identity.resultProcessUuid,
              version: "01.00.000",
              description: "Generated LCI/LCIA Result Process",
            }),
            "common:generalComment": {
              "@xml:lang": "en",
              "#text":
                "Deterministically generated one-hop model from a frozen Unit Process and Calculation Bundle.",
            },
          },
          quantitativeReference: { referenceToReferenceProcess: 0 },
          technology: { processes: { processInstance: processInstances } },
        },
        modellingAndValidation: modelValidation(sourceDataSet),
        administrativeInformation: modelAdministrativeInformation(
          sourceDataSet,
          identity.modelUuid,
        ),
      },
    };
    return {
      schemaVersion: "tiangong.release.generated-dataset-draft.v1",
      datasetType: "lifecyclemodel",
      role: "lifecycle_model",
      processIndex: process.processIndex,
      uuid: identity.modelUuid,
      sourceProcess: clone(process.rootProcess),
      document: document as unknown as JsonValue,
    };
  });
}

function resultExchange(input: {
  internalId: number;
  flowId: string;
  flowVersion: string;
  direction: "Input" | "Output";
  meanAmount: number;
  location?: string | null;
  description: string;
}): JsonRecord {
  const amount = finiteString(input.meanAmount, "resultExchange.meanAmount");
  return {
    "@dataSetInternalID": String(input.internalId),
    referenceToFlowDataSet: globalReference({
      type: "flow data set",
      category: "flows",
      uuid: input.flowId,
      version: input.flowVersion,
      description: input.description,
    }),
    ...(input.location ? { location: input.location } : {}),
    exchangeDirection: input.direction,
    meanAmount: amount,
    resultingAmount: amount,
    dataDerivationTypeStatus: "Calculated",
  };
}

export function materializeResultDrafts(input: {
  processes: BundleProcessRecord[];
  identities: DerivedIdentityRecord[];
  lci: BundleInventoryRecord[];
  lcia: BundleLciaRecord[];
  sourceClosure: FrozenSourceClosure;
}): GeneratedDatasetDraft[] {
  const identities = identityByProcessIndex(input.identities);
  return input.processes.map((process) => {
    const identity = identities.get(process.processIndex);
    if (!identity) {
      throw new Error(`derived_identity_missing:${process.processIndex}`);
    }
    const source = clone(sourceProcessDocument(input.sourceClosure, process));
    const dataSet = object(
      source.processDataSet,
      "source_unit_process_dataset_invalid",
    );
    const dataSetInformation = object(
      dataSet.processInformation?.dataSetInformation,
      "source_process_dataset_information_missing",
    );
    dataSetInformation["common:UUID"] = identity.resultProcessUuid;
    const name = object(dataSetInformation.name, "source_process_name_missing");
    name.baseName = appendEnglishSuffix(name.baseName, "LCI/LCIA result");
    dataSet.processInformation.quantitativeReference = {
      "@type": "Reference flow(s)",
      referenceToReferenceFlow: "0",
    };
    dataSet.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet =
      "LCI result";
    const publication = object(
      dataSet.administrativeInformation?.publicationAndOwnership,
      "source_process_publication_missing",
    );
    publication["common:dataSetVersion"] = "01.00.000";
    publication["common:permanentDataSetURI"] =
      `https://lcdn.tiangong.earth/datasetdetail/process.xhtml?uuid=${identity.resultProcessUuid}&version=01.00.000`;

    const records = input.lci
      .filter(
        (record) =>
          record.processIndex === process.processIndex &&
          !(
            record.flow.id === process.quantitativeReference.flow.id &&
            record.flow.version ===
              process.quantitativeReference.flow.version &&
            record.direction === "Output"
          ),
      )
      .sort(
        (left, right) =>
          left.flow.id.localeCompare(right.flow.id) ||
          left.flow.version.localeCompare(right.flow.version) ||
          left.direction.localeCompare(right.direction) ||
          String(left.location ?? "").localeCompare(
            String(right.location ?? ""),
          ),
      );
    dataSet.exchanges = {
      exchange: [
        resultExchange({
          internalId: 0,
          flowId: process.quantitativeReference.flow.id,
          flowVersion: process.quantitativeReference.flow.version,
          direction: "Output",
          meanAmount: 1,
          description: "Quantitative reference flow",
        }),
        ...records.map((record, index) =>
          resultExchange({
            internalId: index + 1,
            flowId: record.flow.id,
            flowVersion: record.flow.version,
            direction: record.direction,
            meanAmount: record.meanAmount,
            ...(record.location === undefined
              ? {}
              : { location: record.location }),
            description: `Aggregated LCI flow (${record.unit})`,
          }),
        ),
      ],
    };
    const impactResults = input.lcia
      .filter((record) => record.processIndex === process.processIndex)
      .sort(
        (left, right) =>
          left.method.id.localeCompare(right.method.id) ||
          left.method.version.localeCompare(right.method.version),
      )
      .map((record) => ({
        referenceToLCIAMethodDataSet: globalReference({
          type: "LCIA method data set",
          category: "lciamethods",
          uuid: record.method.id,
          version: record.method.version,
          description: "LCIA method result",
        }),
        meanAmount: finiteString(record.meanAmount, "lcia.meanAmount"),
      }));
    dataSet.LCIAResults = { LCIAResult: impactResults };

    return {
      schemaVersion: "tiangong.release.generated-dataset-draft.v1",
      datasetType: "process",
      role: "result_process",
      processIndex: process.processIndex,
      uuid: identity.resultProcessUuid,
      sourceProcess: clone(process.rootProcess),
      document: source as unknown as JsonValue,
    };
  });
}
