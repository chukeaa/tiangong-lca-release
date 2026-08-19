import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "../lib/common.mjs";
import { createIntake } from "../lib/intake.mjs";
import { resolveReferencePivot, sourceKey } from "../lib/context.mjs";
import { modelIdentity, resultIdentity } from "../lib/identity.mjs";
import { materializeModels } from "../lib/materialize-models.mjs";
import { materialize } from "../lib/materialize.mjs";
import {
  materializeResults,
  resolveResultVariantVersions,
} from "../lib/materialize-results.mjs";
import {
  indexPreviousResultVariants,
  resolveVersion,
} from "../lib/versioning.mjs";

const PROCESS_ID = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "99999999-9999-4999-8999-999999999999";
const PROVIDER_FLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("identity contracts reproduce frozen vectors", () => {
  assert.equal(
    modelIdentity(PROCESS_ID, FLOW_ID).uuid,
    "c58f567c-c631-5a3a-90d9-c0cec7290cf8",
  );
  assert.equal(
    resultIdentity(PROCESS_ID, FLOW_ID).uuid,
    "e69b636c-c09d-5584-a00e-5ae3380594de",
  );
  assert.deepEqual(resultIdentity(PROCESS_ID, FLOW_ID).document, {
    rootProcessUuid: PROCESS_ID,
    referenceFlowUuid: FLOW_ID,
  });
});

test("version policy reuses, bumps minor metadata, and bumps major semantics", () => {
  const previous = {
    uuid: PROCESS_ID,
    version: "01.02.000",
    semanticHash: "a".repeat(64),
    versionSignificantHash: "b".repeat(64),
    canonicalContentHash: "c".repeat(64),
  };
  assert.deepEqual(resolveVersion({ ...previous }, previous), {
    version: "01.02.000",
    change: "reuse",
  });
  assert.deepEqual(
    resolveVersion(
      { ...previous, versionSignificantHash: "d".repeat(64) },
      previous,
    ),
    { version: "01.03.000", change: "minor" },
  );
  assert.deepEqual(
    resolveVersion({ ...previous, semanticHash: "e".repeat(64) }, previous),
    { version: "02.00.000", change: "major" },
  );
});

test("CLI exposes one intent-level materialize command and requires all three choices", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /materialize\s+/);
  assert.match(help.stdout, /--output-type <type>/);
  assert.match(help.stdout, /--result-layer <layer>/);
  assert.doesNotMatch(help.stdout, /materialize-results/);
  assert.doesNotMatch(help.stdout, /materialize-models/);
  const invalid = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "materialize",
      "--intake",
      "/tmp/input",
      "--out-dir",
      "/tmp/output",
      "--output-type",
      "result-process",
      "--result-layer",
      "lci",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, "selection_required");
});

test("intake, Result Catalog, and resolved one-hop Model complete locally", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "release-materialization-"),
  );
  const bundle = path.join(temp, "bundle");
  for (const directory of ["source", "axes", "results", "graph"]) {
    await mkdir(path.join(bundle, directory), { recursive: true });
  }
  const process = validUnitProcess(PROCESS_ID, FLOW_ID, "Fixture Unit Process");
  const provider = validUnitProcess(
    PROVIDER_ID,
    PROVIDER_FLOW_ID,
    "Fixture Provider Process",
  );
  const sourceRecords = [
    {
      schemaVersion: "tiangong.source-closure.dataset.v1",
      datasetType: "process",
      role: "unit_process",
      uuid: PROCESS_ID,
      version: "01.00.000",
      path: `processes/${PROCESS_ID}_01.00.000.json`,
      sha256: sha(Buffer.from(canonicalJson(process).trimEnd())),
      document: process,
    },
    {
      schemaVersion: "tiangong.source-closure.dataset.v1",
      datasetType: "process",
      role: "unit_process",
      uuid: PROVIDER_ID,
      version: "01.00.000",
      path: `processes/${PROVIDER_ID}_01.00.000.json`,
      sha256: sha(Buffer.from(canonicalJson(provider).trimEnd())),
      document: provider,
    },
  ];
  const axisRecords = [
    {
      processIndex: 0,
      rootProcess: { id: PROCESS_ID, version: "01.00.000" },
      quantitativeReference: {
        exchangeInternalId: "0",
        flow: { id: FLOW_ID, version: "01.00.000" },
        direction: "Output",
        referenceUnit: "kg",
        meanAmount: 1,
      },
    },
    {
      processIndex: 1,
      rootProcess: { id: PROVIDER_ID, version: "01.00.000" },
      quantitativeReference: {
        exchangeInternalId: "0",
        flow: { id: PROVIDER_FLOW_ID, version: "01.00.000" },
        direction: "Output",
        referenceUnit: "kg",
        meanAmount: 1,
      },
    },
  ];
  const technosphereRecords = [
    {
      dependentProcessIndex: 0,
      residualExchangeInternalId: "7",
      balancingProcessIndex: 1,
      balancingReferenceExchangeInternalId: "0",
      residualCoefficient: -2,
      referenceCoefficient: 1,
      routingWeight: 1,
      activityRequirement: 2,
      flow: { id: PROVIDER_FLOW_ID, version: "01.00.000" },
      location: "GLO",
    },
  ];
  const artifactSpecs = [
    ["source_closure", "source/source-closure.ndjson.gz", sourceRecords],
    ["process_axis", "axes/processes-000000.ndjson.gz", axisRecords],
    ["lci", "results/lci-000000.ndjson.gz", []],
    ["lcia", "results/lcia-000000.ndjson.gz", []],
    ["biosphere_edges", "graph/biosphere-000000.ndjson.gz", []],
    [
      "technosphere_edges",
      "graph/technosphere-000000.ndjson.gz",
      technosphereRecords,
    ],
  ];
  const artifacts = [];
  for (const [kind, relative, records] of artifactSpecs) {
    const plain = Buffer.from(
      records.map((record) => canonicalJson(record).trimEnd()).join("\n") +
        (records.length ? "\n" : ""),
    );
    const compressed = gzipSync(plain, { level: 6, mtime: 0 });
    await writeFile(path.join(bundle, relative), compressed);
    artifacts.push({
      kind,
      path: relative,
      schemaVersion: `test.${kind}.v1`,
      mediaType: "application/x-ndjson",
      compression: "gzip",
      sha256: sha(compressed),
      uncompressedSha256: sha(plain),
      byteSize: compressed.length,
      uncompressedByteSize: plain.length,
      recordCount: records.length,
    });
  }
  const manifest = calculationManifest(artifacts);
  const hashInput = structuredClone(manifest);
  delete hashInput.bundleContentHash;
  manifest.bundleContentHash = sha(
    Buffer.from(canonicalJson(hashInput).trimEnd()),
  );
  await writeFile(
    path.join(bundle, "calculation-bundle.json"),
    canonicalJson(manifest).trimEnd(),
  );

  const intakePath = path.join(temp, "intake");
  await createIntake({ bundle, outDir: intakePath });
  const resultPath = path.join(temp, "results");
  const results = await materializeResults({
    intakeDir: intakePath,
    outDir: resultPath,
    processUuids: [PROCESS_ID],
    includeDirectProviders: true,
    firstGeneration: true,
  });
  assert.equal(results.catalog.selection.length, 1);
  assert.equal(results.catalog.datasets.length, 2);
  assert.equal(
    results.catalog.datasets[0].uuid,
    "e69b636c-c09d-5584-a00e-5ae3380594de",
  );
  const models = await materializeModels({
    intakeDir: intakePath,
    resultCatalogPath: path.join(resultPath, "result-catalog.json"),
    outDir: path.join(temp, "models"),
    firstGeneration: true,
  });
  assert.equal(models.catalog.datasets.length, 1);
  assert.equal(
    models.catalog.datasets[0].uuid,
    "c58f567c-c631-5a3a-90d9-c0cec7290cf8",
  );
  assert.equal(models.manifest.validation.modelSchemas, "passed");
  assert.equal(models.catalog.datasets[0].providerCount, 1);

  const previousManifestPath = path.join(
    models.path,
    "materialization-manifest.json",
  );
  const replayResults = await materializeResults({
    intakeDir: intakePath,
    outDir: path.join(temp, "results-replay"),
    processUuids: [PROCESS_ID],
    includeDirectProviders: true,
    previousManifestPath,
  });
  assert.ok(
    replayResults.catalog.datasets.every(
      (item) => item.versionChange === "reuse",
    ),
  );
  const replayModels = await materializeModels({
    intakeDir: intakePath,
    resultCatalogPath: path.join(replayResults.path, "result-catalog.json"),
    outDir: path.join(temp, "models-replay"),
    previousManifestPath,
  });
  assert.ok(
    replayModels.catalog.datasets.every(
      (item) => item.versionChange === "reuse",
    ),
  );

  const resultOnly = await materialize({
    intakeDir: intakePath,
    outDir: path.join(temp, "result-only-delivery"),
    processUuids: [`${PROCESS_ID}@01.00.000`],
    outputType: "result-process",
    resultLayer: "lci",
    firstGeneration: true,
  });
  assert.deepEqual(resultOnly.summary, {
    requestedRootCount: 1,
    primaryDatasetCount: 1,
    dependencyDatasetCount: 0,
    resultingDatasetCount: 0,
  });
  assert.equal(resultOnly.manifest.profiles.result, "lci-result.v2");
  assert.equal(resultOnly.manifest.profiles.model, null);

  const modelDelivery = await materialize({
    intakeDir: intakePath,
    outDir: path.join(temp, "model-delivery"),
    processUuids: [`${PROCESS_ID}@01.00.000`],
    outputType: "lifecycle-model",
    resultLayer: "lci-lcia",
    firstGeneration: true,
  });
  assert.deepEqual(modelDelivery.summary, {
    requestedRootCount: 1,
    primaryDatasetCount: 1,
    dependencyDatasetCount: 1,
    resultingDatasetCount: 1,
  });
  assert.equal(modelDelivery.manifest.datasets.length, 3);
});

test("multiple exact source revisions share a Result UUID but receive exact versions", () => {
  const resultUuid = resultIdentity(PROCESS_ID, FLOW_ID).uuid;
  const hash = (value) => value.repeat(64);
  const draft = (processIndex, version, value) => ({
    axis: { processIndex },
    provisional: {
      uuid: resultUuid,
      sourceProcess: { id: PROCESS_ID, version },
    },
    hashes: {
      semanticHash: hash(value),
      versionSignificantHash: hash(value),
      canonicalContentHash: hash(value),
    },
  });
  const drafts = [draft(1, "01.01.002", "a"), draft(2, "01.01.005", "b")];
  const first = resolveResultVariantVersions(
    drafts,
    indexPreviousResultVariants(null),
  );
  assert.equal(first.get(1).version, "01.00.000");
  assert.equal(first.get(2).version, "02.00.000");
  const previousManifest = {
    datasets: drafts.map((item) => ({
      datasetType: "process",
      uuid: resultUuid,
      version: first.get(item.axis.processIndex).version,
      sourceProcess: item.provisional.sourceProcess,
      ...item.hashes,
    })),
  };
  const replay = resolveResultVariantVersions(
    drafts,
    indexPreviousResultVariants(previousManifest),
  );
  assert.equal(replay.get(1).change, "reuse");
  assert.equal(replay.get(2).change, "reuse");
});

test("quantitative-reference pivot uses Bundle v2 evidence and bounded legacy fallback", () => {
  const process = validUnitProcess(
    PROCESS_ID,
    FLOW_ID,
    "Input reference fixture",
  );
  const referenceExchange = process.processDataSet.exchanges.exchange[0];
  referenceExchange.exchangeDirection = "Input";
  referenceExchange.meanAmount = "2.5";
  const sources = new Map([
    [
      sourceKey("process", PROCESS_ID, "01.00.000"),
      { role: "unit_process", document: process },
    ],
  ]);
  const axis = {
    processIndex: 0,
    rootProcess: { id: PROCESS_ID, version: "01.00.000" },
    quantitativeReference: {
      exchangeInternalId: "0",
      flow: { id: FLOW_ID, version: "01.00.000" },
      meanAmount: 1,
    },
  };
  const legacy = resolveReferencePivot(axis, sources);
  assert.deepEqual(legacy, {
    rawDirection: "Input",
    rawMeanAmount: 2.5,
    signedRawCoefficient: -2.5,
    normalizationScale: 0.4,
    normalizedCoefficient: -1,
    normalizedMeanAmount: 1,
    evidenceSource: "exact_source_closure_legacy_fallback.v1",
  });
  axis.quantitativeReference.pivot = {
    rawDirection: "Input",
    rawMeanAmount: 2.5,
    signedRawCoefficient: -2.5,
    normalizationScale: 0.4,
    normalizedCoefficient: -1,
  };
  assert.equal(
    resolveReferencePivot(axis, sources).evidenceSource,
    "calculation_bundle_process_axis.v2",
  );
});

function calculationManifest(artifacts) {
  return {
    schemaVersion: "tiangong.calculation-bundle.v2",
    calculationContractVersion: "1.0.0",
    calculationId: "33333333-3333-4333-8333-333333333333",
    bundleContentHash: "0".repeat(64),
    scope: {
      coverageMode: "subset",
      processCount: 2,
      selectionManifestHash: "a".repeat(64),
    },
    snapshot: {
      id: "44444444-4444-4444-8444-444444444444",
      sha256: "b".repeat(64),
      processCount: 2,
      flowCount: 2,
      impactCount: 0,
    },
    solver: {},
    methodSet: {},
    artifacts,
    calculationEvidence: {},
    hashes: { algorithm: "sha256", canonicalJson: "RFC8785/JCS" },
  };
}

function validUnitProcess(processId, flowId, processName) {
  const contact = reference(
    "contact data set",
    "contacts",
    "55555555-5555-4555-8555-555555555555",
    "Fixture contact",
  );
  const source = reference(
    "source data set",
    "sources",
    "66666666-6666-4666-8666-666666666666",
    "Fixture source",
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
          "common:UUID": processId,
          name: {
            baseName: { "@xml:lang": "en", "#text": processName },
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
                { "@level": "0", "@classId": "A", "#text": "Agriculture" },
                { "@level": "1", "@classId": "01", "#text": "Crop production" },
                { "@level": "2", "@classId": "011", "#text": "Crops" },
                { "@level": "3", "@classId": "0111", "#text": "Cereals" },
              ],
            },
          },
          "common:generalComment": {
            "@xml:lang": "en",
            "#text": "Fixture process.",
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
            "#text": "Workflow test.",
          },
        },
        dataEntryBy: {
          "common:timeStamp": "2026-07-16T00:00:00.000Z",
          "common:referenceToDataSetFormat": source,
          "common:referenceToPersonOrEntityEnteringTheData": contact,
        },
        publicationAndOwnership: {
          "common:dataSetVersion": "01.00.000",
          "common:permanentDataSetURI": `https://example.test/process/${processId}`,
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
              flowId,
              "Reference flow",
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

function reference(type, category, uuid, description) {
  return {
    "@refObjectId": uuid,
    "@type": type,
    "@uri": `../${category}/${uuid}_01.00.000.json`,
    "@version": "01.00.000",
    "common:shortDescription": { "@xml:lang": "en", "#text": description },
  };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
