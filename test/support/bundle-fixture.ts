import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { calculateBundleContentHash } from "../../src/bundle/manifest.js";
import type {
  CalculationBundleArtifact,
  CalculationBundleArtifactKind,
  CalculationBundleManifest,
} from "../../src/bundle/types.js";
import { canonicalize } from "../../src/canonical/jcs.js";
import type { JsonValue } from "../../src/contracts/json.js";
import type { ReleaseRequest } from "../../src/workspace/run-store.js";

const SHA_ZERO = "0".repeat(64);
const ROOT_PROCESS_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_FLOW_ID = "22222222-2222-4222-8222-222222222222";
const BIOSPHERE_FLOW_ID = "33333333-3333-4333-8333-333333333333";
const LCIA_METHOD_ID = "44444444-4444-4444-8444-444444444444";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const SOURCE_ID = "66666666-6666-4666-8666-666666666666";
const UNIT_GROUP_ID = "77777777-7777-4777-8777-777777777777";
const FLOW_PROPERTY_ID = "88888888-8888-4888-8888-888888888888";
const DATA_SET_VERSION = "01.00.000";
const FIXTURE_TIMESTAMP = "2026-07-16T00:00:00.000Z";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ndjson(records: JsonValue[]): Buffer {
  return records.length
    ? Buffer.from(`${records.map(canonicalize).join("\n")}\n`, "utf8")
    : Buffer.alloc(0);
}

function writeGzipArtifact(input: {
  directory: string;
  kind: CalculationBundleArtifactKind;
  relativePath: string;
  records: JsonValue[];
}): CalculationBundleArtifact {
  const plain = ndjson(input.records);
  const compressed = gzipSync(plain, { level: 6 });
  const filePath = path.join(input.directory, input.relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, compressed);
  return {
    kind: input.kind,
    path: input.relativePath,
    schemaVersion: `tiangong.calculation-bundle.${input.kind}.v1`,
    mediaType: "application/x-ndjson",
    compression: "gzip",
    sha256: sha256(compressed),
    uncompressedSha256: sha256(plain),
    byteSize: compressed.byteLength,
    uncompressedByteSize: plain.byteLength,
    recordCount: input.records.length,
    firstProcessIndex: 0,
    lastProcessIndex: 0,
  };
}

function writeCoverageArtifact(directory: string): CalculationBundleArtifact {
  const relativePath = "artifacts/coverage.json";
  const filePath = path.join(directory, relativePath);
  const body = `${canonicalize({
    schemaVersion: "tiangong.calculation-bundle.coverage.v1",
    complete: true,
    processCount: 1,
  })}\n`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
  return {
    kind: "coverage",
    path: relativePath,
    schemaVersion: "tiangong.calculation-bundle.coverage.v1",
    mediaType: "application/json",
    compression: "none",
    sha256: sha256(body),
    byteSize: statSync(filePath).size,
    recordCount: 1,
    firstProcessIndex: 0,
    lastProcessIndex: 0,
  };
}

function reference(
  type: string,
  category: string,
  id: string,
  description: string,
) {
  return {
    "@refObjectId": id,
    "@type": type,
    "@uri": `../${category}/${id}_01.00.000.json`,
    "@version": DATA_SET_VERSION,
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

function localized(text: string) {
  return { "@xml:lang": "en", "#text": text };
}

function compliance(source: ReturnType<typeof reference>) {
  return {
    complianceDeclarations: {
      compliance: {
        "common:referenceToComplianceSystem": source,
        "common:approvalOfOverallCompliance": "Not defined",
      },
    },
  };
}

function administrativeInformation(input: {
  contact: ReturnType<typeof reference>;
  source: ReturnType<typeof reference>;
}) {
  return {
    dataEntryBy: {
      "common:timeStamp": FIXTURE_TIMESTAMP,
      "common:referenceToDataSetFormat": input.source,
    },
    publicationAndOwnership: {
      "common:dataSetVersion": DATA_SET_VERSION,
      "common:referenceToOwnershipOfDataSet": input.contact,
    },
  };
}

function supportReferences() {
  return {
    contact: reference(
      "contact data set",
      "contacts",
      CONTACT_ID,
      "TianGong release fixture contact",
    ),
    source: reference(
      "source data set",
      "sources",
      SOURCE_ID,
      "TianGong release fixture source",
    ),
    unitGroup: reference(
      "unit group data set",
      "unitgroups",
      UNIT_GROUP_ID,
      "Mass units",
    ),
    flowProperty: reference(
      "flow property data set",
      "flowproperties",
      FLOW_PROPERTY_ID,
      "Mass",
    ),
  };
}

function contactDocument(): JsonValue {
  const refs = supportReferences();
  return {
    contactDataSet: {
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns": "http://lca.jrc.it/ILCD/Contact",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/Contact ../../schemas/ILCD_ContactDataSet.xsd",
      contactInformation: {
        dataSetInformation: {
          "common:UUID": CONTACT_ID,
          "common:shortName": localized("TianGong release fixture contact"),
          "common:name": localized("TianGong Release Fixture Organisation"),
          classificationInformation: {
            "common:classification": {
              "common:class": {
                "@level": "0",
                "@classId": "2",
                "#text": "Organisations",
              },
            },
          },
        },
      },
      administrativeInformation: administrativeInformation(refs),
    },
  };
}

function sourceDocument(): JsonValue {
  const refs = supportReferences();
  return {
    sourceDataSet: {
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns": "http://lca.jrc.it/ILCD/Source",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/Source ../../schemas/ILCD_SourceDataSet.xsd",
      sourceInformation: {
        dataSetInformation: {
          "common:UUID": SOURCE_ID,
          "common:shortName": localized("TianGong release fixture format"),
          classificationInformation: {
            "common:classification": {
              "common:class": {
                "@level": "0",
                "@classId": "1",
                "#text": "Data set formats",
              },
            },
          },
        },
      },
      administrativeInformation: administrativeInformation(refs),
    },
  };
}

function unitGroupDocument(): JsonValue {
  const refs = supportReferences();
  return {
    unitGroupDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/UnitGroup",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/UnitGroup ../../schemas/ILCD_UnitGroupDataSet.xsd",
      unitGroupInformation: {
        dataSetInformation: {
          "common:UUID": UNIT_GROUP_ID,
          "common:name": localized("Mass units"),
          classificationInformation: {
            "common:classification": {
              "common:class": {
                "@level": "0",
                "@classId": "1",
                "#text": "Technical unit groups",
              },
            },
          },
        },
        quantitativeReference: { referenceToReferenceUnit: "0" },
      },
      modellingAndValidation: compliance(refs.source),
      administrativeInformation: administrativeInformation(refs),
      units: {
        unit: {
          "@dataSetInternalID": "0",
          name: "kg",
          meanValue: "1",
        },
      },
    },
  };
}

function flowPropertyDocument(): JsonValue {
  const refs = supportReferences();
  return {
    flowPropertyDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/FlowProperty",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/FlowProperty ../../schemas/ILCD_FlowPropertyDataSet.xsd",
      flowPropertiesInformation: {
        dataSetInformation: {
          "common:UUID": FLOW_PROPERTY_ID,
          "common:name": localized("Mass"),
          classificationInformation: {
            "common:classification": {
              "common:class": {
                "@level": "0",
                "@classId": "1",
                "#text": "Technical flow properties",
              },
            },
          },
        },
        quantitativeReference: {
          referenceToReferenceUnitGroup: refs.unitGroup,
        },
      },
      modellingAndValidation: compliance(refs.source),
      administrativeInformation: administrativeInformation(refs),
    },
  };
}

function productClassification() {
  return {
    "common:classification": {
      "common:class": [
        {
          "@level": "0",
          "@classId": "0",
          "#text": "Agriculture, forestry and fishery products",
        },
        {
          "@level": "1",
          "@classId": "01",
          "#text": "Products of agriculture, horticulture and market gardening",
        },
        { "@level": "2", "@classId": "011", "#text": "Cereals" },
        { "@level": "3", "@classId": "0111", "#text": "Wheat" },
        { "@level": "4", "@classId": "01111", "#text": "Wheat, seed" },
      ],
    },
  };
}

function flowDocument(id: string, name: string): JsonValue {
  const refs = supportReferences();
  return {
    flowDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/Flow",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:ecn":
        "http://eplca.jrc.ec.europa.eu/ILCD/Extensions/2018/ECNumber",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@locations": "../ILCDLocations.xml",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/Flow ../../schemas/ILCD_FlowDataSet.xsd",
      flowInformation: {
        dataSetInformation: {
          "common:UUID": id,
          name: {
            baseName: localized(name),
            treatmentStandardsRoutes: localized("release fixture route"),
            mixAndLocationTypes: localized("production mix, GLO"),
          },
          classificationInformation: productClassification(),
        },
        quantitativeReference: { referenceToReferenceFlowProperty: "0" },
      },
      modellingAndValidation: {
        LCIMethod: { typeOfDataSet: "Product flow" },
        ...compliance(refs.source),
      },
      administrativeInformation: administrativeInformation(refs),
      flowProperties: {
        flowProperty: {
          "@dataSetInternalID": "0",
          referenceToFlowPropertyDataSet: refs.flowProperty,
          meanValue: "1",
        },
      },
    },
  };
}

function lciaMethodDocument(): JsonValue {
  const refs = supportReferences();
  return {
    LCIAMethodDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/LCIAMethod",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/LCIAMethod ../../schemas/ILCD_LCIAMethodDataSet.xsd",
      LCIAMethodInformation: {
        dataSetInformation: {
          "common:UUID": LCIA_METHOD_ID,
          "common:name": localized("Fixture midpoint impact method"),
          classificationInformation: {
            "common:classification": {
              "common:class": [
                {
                  "@level": "0",
                  "@classId": "2",
                  "#text": "Midpoint level LCIA methods",
                },
              ],
            },
          },
        },
        quantitativeReference: { referenceQuantity: refs.flowProperty },
        time: {
          referenceYear: localized("2026"),
          duration: localized("time independent"),
          timeRepresentativenessDescription: localized(
            "Release pipeline verification fixture.",
          ),
        },
        geography: {
          interventionLocation: "GLO",
          impactLocation: "GLO",
          geographicalRepresentativenessDescription: localized(
            "Globally applicable release pipeline verification fixture.",
          ),
        },
        impactModel: {
          modelName: "Fixture impact model",
          modelDescription: localized(
            "Deterministic impact model for release pipeline verification.",
          ),
        },
      },
      modellingAndValidation: {
        LCIAMethodNormalisationAndWeighting: {
          typeOfDataSet: "Mid-point indicator",
          LCIAMethodPrinciple: "other",
        },
        dataSources: { referenceToDataSource: refs.source },
        validation: { review: { "@type": "Not reviewed" } },
        complianceDeclarations: {
          compliance: {
            "common:referenceToComplianceSystem": refs.source,
            "common:approvalOfOverallCompliance": "Not defined",
            "common:nomenclatureCompliance": "Not defined",
            "common:methodologicalCompliance": "Not defined",
            "common:reviewCompliance": "Not defined",
            "common:documentationCompliance": "Not defined",
            "common:qualityCompliance": "Not defined",
          },
        },
      },
      administrativeInformation: {
        dataGenerator: {
          "common:referenceToPersonOrEntityGeneratingTheDataSet": refs.contact,
        },
        dataEntryBy: {
          "common:timeStamp": FIXTURE_TIMESTAMP,
          "common:referenceToDataSetFormat": refs.source,
          recommendationBy: {
            referenceToEntity: refs.contact,
            level: "Level I",
            meaning: localized(
              "Recommended for release pipeline verification.",
            ),
          },
        },
        publicationAndOwnership: {
          "common:dateOfLastRevision": FIXTURE_TIMESTAMP,
          "common:dataSetVersion": DATA_SET_VERSION,
          "common:referenceToOwnershipOfDataSet": refs.contact,
        },
      },
      characterisationFactors: {
        factor: {
          referenceToFlowDataSet: reference(
            "flow data set",
            "flows",
            BIOSPHERE_FLOW_ID,
            "Fixture inventory flow",
          ),
          exchangeDirection: "Output",
          meanValue: "1",
          deviatingRecommendation: "Level I",
        },
      },
    },
  };
}

function unitProcessDocument(): JsonValue {
  const { contact, source } = supportReferences();
  return {
    processDataSet: {
      "@xmlns": "http://lca.jrc.it/ILCD/Process",
      "@xmlns:common": "http://lca.jrc.it/ILCD/Common",
      "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      "@version": "1.1",
      "@locations": "../ILCDLocations.xml",
      "@xsi:schemaLocation":
        "http://lca.jrc.it/ILCD/Process ../../schemas/ILCD_ProcessDataSet.xsd",
      processInformation: {
        dataSetInformation: {
          "common:UUID": ROOT_PROCESS_ID,
          name: {
            baseName: { "@xml:lang": "en", "#text": "Fixture Unit Process" },
            treatmentStandardsRoutes: {
              "@xml:lang": "en",
              "#text": "fixture route",
            },
            mixAndLocationTypes: {
              "@xml:lang": "en",
              "#text": "production mix, GLO",
            },
          },
          classificationInformation: {
            "common:classification": {
              "common:class": [
                {
                  "@level": "0",
                  "@classId": "A",
                  "#text": "Agriculture, forestry and fishing",
                },
                {
                  "@level": "1",
                  "@classId": "01",
                  "#text":
                    "Crop and animal production, hunting and related service activities",
                },
                {
                  "@level": "2",
                  "@classId": "011",
                  "#text": "Growing of non-perennial crops",
                },
                {
                  "@level": "3",
                  "@classId": "0111",
                  "#text":
                    "Growing of cereals (except rice), leguminous crops and oil seeds",
                },
              ],
            },
          },
          "common:generalComment": {
            "@xml:lang": "en",
            "#text": "Strict source Unit Process for release pipeline tests.",
          },
        },
        quantitativeReference: {
          "@type": "Reference flow(s)",
          referenceToReferenceFlow: "0",
        },
        time: { "common:referenceYear": 2026 },
        geography: {
          locationOfOperationSupplyOrProduction: { "@location": "GLO" },
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: "Unit process, single operation",
          LCIMethodPrinciple: "Attributional",
        },
        validation: { review: { "@type": "Not reviewed" } },
        complianceDeclarations: {
          compliance: {
            "common:referenceToComplianceSystem": source,
            "common:approvalOfOverallCompliance": "Not defined",
            "common:nomenclatureCompliance": "Not defined",
            "common:methodologicalCompliance": "Not defined",
            "common:reviewCompliance": "Not defined",
            "common:documentationCompliance": "Not defined",
            "common:qualityCompliance": "Not defined",
          },
        },
      },
      administrativeInformation: {
        "common:commissionerAndGoal": {
          "common:referenceToCommissioner": contact,
          "common:intendedApplications": {
            "@xml:lang": "en",
            "#text": "Release pipeline verification.",
          },
        },
        dataEntryBy: {
          "common:timeStamp": FIXTURE_TIMESTAMP,
          "common:referenceToDataSetFormat": source,
          "common:referenceToPersonOrEntityEnteringTheData": contact,
        },
        publicationAndOwnership: {
          "common:dataSetVersion": DATA_SET_VERSION,
          "common:permanentDataSetURI": `https://lcdn.tiangong.earth/datasetdetail/process.xhtml?uuid=${ROOT_PROCESS_ID}&version=01.00.000`,
          "common:referenceToOwnershipOfDataSet": contact,
          "common:copyright": "false",
          "common:licenseType": "Free of charge for all users and uses",
        },
      },
      exchanges: {
        exchange: [
          {
            "@dataSetInternalID": "0",
            referenceToFlowDataSet: reference(
              "flow data set",
              "flows",
              REFERENCE_FLOW_ID,
              "Fixture reference flow",
            ),
            exchangeDirection: "Output",
            meanAmount: "1",
            resultingAmount: "1",
            dataDerivationTypeStatus: "Measured",
          },
        ],
      },
    },
  };
}

function writeSourceClosure(directory: string): {
  directory: string;
  manifestHash: string;
} {
  const sourceDocuments = [
    {
      datasetType: "contact",
      role: "support",
      uuid: CONTACT_ID,
      category: "contacts",
      document: contactDocument(),
    },
    {
      datasetType: "flowproperty",
      role: "support",
      uuid: FLOW_PROPERTY_ID,
      category: "flowproperties",
      document: flowPropertyDocument(),
    },
    {
      datasetType: "flow",
      role: "support",
      uuid: REFERENCE_FLOW_ID,
      category: "flows",
      document: flowDocument(REFERENCE_FLOW_ID, "Fixture reference flow"),
    },
    {
      datasetType: "flow",
      role: "support",
      uuid: BIOSPHERE_FLOW_ID,
      category: "flows",
      document: flowDocument(BIOSPHERE_FLOW_ID, "Fixture inventory flow"),
    },
    {
      datasetType: "lciamethod",
      role: "support",
      uuid: LCIA_METHOD_ID,
      category: "lciamethods",
      document: lciaMethodDocument(),
    },
    {
      datasetType: "process",
      role: "unit_process",
      uuid: ROOT_PROCESS_ID,
      category: "processes",
      document: unitProcessDocument(),
    },
    {
      datasetType: "source",
      role: "support",
      uuid: SOURCE_ID,
      category: "sources",
      document: sourceDocument(),
    },
    {
      datasetType: "unitgroup",
      role: "support",
      uuid: UNIT_GROUP_ID,
      category: "unitgroups",
      document: unitGroupDocument(),
    },
  ].map((item) => {
    const relativePath = `${item.category}/${item.uuid}_${DATA_SET_VERSION}.json`;
    const body = `${JSON.stringify(item.document, null, 2)}\n`;
    const filePath = path.join(directory, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, body, "utf8");
    return {
      datasetType: item.datasetType,
      role: item.role,
      uuid: item.uuid,
      version: DATA_SET_VERSION,
      path: relativePath,
      sha256: sha256(body),
    };
  });
  const manifest = {
    schemaVersion: "tiangong.source-closure.v1",
    datasets: sourceDocuments,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path.join(directory, "manifest.json"), manifestBody, "utf8");
  return { directory, manifestHash: sha256(manifestBody) };
}

export function createCalculationBundleFixture(rootDirectory: string): {
  bundleDirectory: string;
  manifestPath: string;
  manifest: CalculationBundleManifest;
  request: ReleaseRequest;
} {
  const bundleDirectory = path.join(rootDirectory, "calculation-bundle");
  const sourceClosureDirectory = path.join(rootDirectory, "source-closure");
  mkdirSync(bundleDirectory, { recursive: true });
  mkdirSync(sourceClosureDirectory, { recursive: true });

  const flow = { id: REFERENCE_FLOW_ID, version: "01.00.000" };
  const artifacts = [
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "biosphere_edges",
      relativePath: "artifacts/biosphere-0000.ndjson.gz",
      records: [
        {
          processIndex: 0,
          exchangeInternalId: "biosphere-1",
          flow: {
            id: BIOSPHERE_FLOW_ID,
            version: DATA_SET_VERSION,
          },
          direction: "Output",
          unit: "kg",
          location: "GLO",
          meanAmount: 0.25,
          allocationTargetInternalId: "0",
          allocationFraction: 1,
        },
      ],
    }),
    writeCoverageArtifact(bundleDirectory),
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "inventory_axis",
      relativePath: "artifacts/inventory-0000.ndjson.gz",
      records: [
        {
          processIndex: 0,
          exchangeInternalId: "0",
          flow,
          direction: "Output",
          unit: "kg",
          location: "GLO",
          meanAmount: 1,
          allocationTargetInternalId: "0",
          allocationFraction: 1,
        },
      ],
    }),
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "lci",
      relativePath: "artifacts/lci-0000.ndjson.gz",
      records: [
        {
          processIndex: 0,
          flow: {
            id: BIOSPHERE_FLOW_ID,
            version: DATA_SET_VERSION,
          },
          direction: "Output",
          unit: "kg",
          location: "GLO",
          meanAmount: 0.25,
        },
      ],
    }),
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "lcia",
      relativePath: "artifacts/lcia-0000.ndjson.gz",
      records: [
        {
          processIndex: 0,
          method: {
            id: LCIA_METHOD_ID,
            version: DATA_SET_VERSION,
          },
          meanAmount: 2.5,
        },
      ],
    }),
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "process_axis",
      relativePath: "artifacts/process-0000.ndjson.gz",
      records: [
        {
          processIndex: 0,
          rootProcess: { id: ROOT_PROCESS_ID, version: "01.00.000" },
          quantitativeReference: {
            exchangeInternalId: "0",
            flow,
            direction: "Output",
            referenceUnit: "kg",
            meanAmount: 1,
          },
        },
      ],
    }),
    writeGzipArtifact({
      directory: bundleDirectory,
      kind: "technosphere_edges",
      relativePath: "artifacts/technosphere-0000.ndjson.gz",
      records: [],
    }),
  ].sort((left, right) => left.path.localeCompare(right.path));

  const manifest: CalculationBundleManifest = {
    schemaVersion: "tiangong.calculation-bundle.v1",
    calculationContractVersion: "1.0.0",
    calculationId: randomUUID(),
    bundleContentHash: SHA_ZERO,
    scope: {
      coverageMode: "global_eligible",
      processCount: 1,
      selectionManifestHash: SHA_ZERO,
    },
    snapshot: {
      id: randomUUID(),
      sha256: "1".repeat(64),
      processCount: 1,
      flowCount: 2,
      impactCount: 1,
    },
    solver: {
      engineVersion: "fixture-1",
      numericalPolicy: { tolerance: "exact" },
      providerPolicy: { mode: "deterministic" },
      allocationPolicy: { mode: "none" },
      zeroPolicy: { mode: "preserve" },
    },
    methodSet: {
      schemaVersion: "lcia.static_cache_bundle.v1",
      bundleVersion: "1.2.4",
      methodCount: 25,
      rawManifestSha256:
        "e9b4e7f9a5125bb921efbffba9a4b50711f9ea982e22b500f35211884a0479c5",
      sourceSnapshotSha256:
        "4efbe0b027969dc2b3b151a84422b3fb749bf1fc2d334c60d1fcf37bf7cc2c11",
      methodManifestSha256:
        "801e886d2d02fc57c6815cfae2f33904139597c1665b55ee0f57bcacdd6be609",
      methodIdentityManifestSha256:
        "dedd7f932f8418a2babb0a9b3ac93c7c812bda4988f974859ac6981e855a0b19",
      factorManifestSha256:
        "40ffd33323c9882dbd0b0d9c99982bad1752e311062231bcf1f490ee96f92e96",
    },
    artifacts,
    calculationEvidence: { graphEvidence: "complete" },
    hashes: { algorithm: "sha256" },
  };
  manifest.bundleContentHash = calculateBundleContentHash(manifest);
  const manifestPath = path.join(bundleDirectory, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const sourceClosure = writeSourceClosure(sourceClosureDirectory);
  return {
    bundleDirectory,
    manifestPath,
    manifest,
    request: {
      schemaVersion: "tiangong.release-request.v1",
      releaseRunId: randomUUID(),
      calculationBundle: {
        manifestPath,
        bundleContentHash: manifest.bundleContentHash,
      },
      scope: {
        coverageMode: "global_eligible",
        selectionManifestHash: SHA_ZERO,
      },
      profiles: {
        modelProfileId: "resolved-one-hop-aggregated-background.v1",
        resultProfileId: "lci-lcia-result.v1",
        packageProfileIds: [
          "unit-process-full-closure.v1",
          "standalone-lifecyclemodel-result-full-closure.v1",
        ],
      },
      sourceClosure,
    },
  };
}
