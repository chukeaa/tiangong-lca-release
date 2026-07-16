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
    "@version": "01.00.000",
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

function unitProcessDocument(): JsonValue {
  const contact = reference(
    "contact data set",
    "contacts",
    "55555555-5555-4555-8555-555555555555",
    "TianGong release fixture contact",
  );
  const source = reference(
    "source data set",
    "sources",
    "66666666-6666-4666-8666-666666666666",
    "TianGong release fixture source",
  );
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
          "common:timeStamp": "2026-07-16T00:00:00.000Z",
          "common:referenceToDataSetFormat": source,
          "common:referenceToPersonOrEntityEnteringTheData": contact,
        },
        publicationAndOwnership: {
          "common:dataSetVersion": "01.00.000",
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
  const processPath = `processes/${ROOT_PROCESS_ID}_01.00.000.json`;
  const processDocument = unitProcessDocument();
  const processBody = `${JSON.stringify(processDocument, null, 2)}\n`;
  const processFile = path.join(directory, processPath);
  mkdirSync(path.dirname(processFile), { recursive: true });
  writeFileSync(processFile, processBody, "utf8");
  const manifest = {
    schemaVersion: "tiangong.source-closure.v1",
    datasets: [
      {
        datasetType: "process",
        role: "unit_process",
        uuid: ROOT_PROCESS_ID,
        version: "01.00.000",
        path: processPath,
        sha256: sha256(processBody),
      },
    ],
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
            id: "33333333-3333-4333-8333-333333333333",
            version: "01.00.000",
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
            id: "33333333-3333-4333-8333-333333333333",
            version: "01.00.000",
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
            id: "44444444-4444-4444-8444-444444444444",
            version: "01.00.000",
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
