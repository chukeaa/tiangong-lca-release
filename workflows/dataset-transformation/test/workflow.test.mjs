import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeTransformation } from "../lib/analysis.mjs";
import { executeTransformation } from "../lib/execute.mjs";
import { freezeTransformation } from "../lib/freeze.mjs";
import {
  canonicalJson,
  hashJson,
  sha256Bytes,
  sha256File,
} from "../lib/common.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "cli.mjs");
const VERSION = "01.00.000";
const INPUTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const OUTPUT = "44444444-4444-4444-8444-444444444444";
const FLOW_INPUT = "55555555-5555-4555-8555-555555555555";
const FLOW_REFERENCE = "66666666-6666-4666-8666-666666666666";
const key = (uuid) => `process:${uuid}@${VERSION}`;

test("semantic differences produce needs_decision rather than a failed workflow", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "draft-unresolved.json");
  await writeFile(draftFile, canonicalJson(draft({ decisions: [] })));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "analysis-unresolved"),
  });
  assert.equal(inspection.analysis.status, "needs_decision");
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes("field:geography"),
  );
  assert.ok(
    inspection.analysis.unresolvedConflictIds.includes("field:technology"),
  );
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "must-not-freeze"),
  });
  assert.equal(frozen.status, "needs_decision");
  await assert.rejects(access(path.join(fixture.root, "must-not-freeze")));
});

test("resolved DSL normalizes three quantitative references before weighted aggregation", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const readyDraft = draft({ decisions: resolvedDecisions() });
  const draftFile = path.join(fixture.root, "draft-ready.json");
  await writeFile(draftFile, canonicalJson(readyDraft));
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "analysis-ready"),
  });
  assert.equal(inspection.analysis.status, "ready");
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "frozen"),
  });
  assert.equal(frozen.status, "frozen");
  const execution = await executeTransformation({
    candidateDir: fixture.candidate,
    specDir: frozen.path,
    outDir: path.join(fixture.root, "execution"),
  });
  assert.equal(execution.receipt.validation.outcome, "passed");
  const process = JSON.parse(
    await readFile(
      path.join(execution.path, "canonical-datasets", execution.dataset.path),
      "utf8",
    ),
  ).processDataSet;
  const inputExchange = process.exchanges.exchange.find(
    (exchange) =>
      exchange.referenceToFlowDataSet["@refObjectId"] === FLOW_INPUT,
  );
  const referenceExchange = process.exchanges.exchange.find(
    (exchange) =>
      exchange.referenceToFlowDataSet["@refObjectId"] === FLOW_REFERENCE,
  );
  assert.equal(Number(inputExchange.resultingAmount), 2.7);
  assert.equal(Number(referenceExchange.resultingAmount), 1);
  assert.equal(
    process.processInformation.geography.locationOfOperationSupplyOrProduction[
      "@location"
    ],
    "CN",
  );
  assert.equal(
    process.modellingAndValidation.validation.review["@type"],
    "Not reviewed",
  );
  assert.equal(execution.handoff.nextWorkflow, "calculation");
  assert.equal(execution.handoff.finalTarget, "new-release-candidate");
});

test("annual-production gaps remain decisions and explicit evidenced overrides resolve them", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const incomplete = draft({
    weighting: { mode: "annual-production" },
    decisions: resolvedDecisions({ annualStrategy: "sum-resolved" }),
  });
  const incompleteFile = path.join(fixture.root, "annual-incomplete.json");
  await writeFile(incompleteFile, canonicalJson(incomplete));
  const first = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: incompleteFile,
    outDir: path.join(fixture.root, "annual-analysis-incomplete"),
  });
  assert.equal(first.analysis.status, "needs_decision");
  assert.ok(
    first.analysis.unresolvedConflictIds.includes(`weight:${key(INPUTS[1])}`),
  );
  assert.ok(
    first.analysis.unresolvedConflictIds.includes(`weight:${key(INPUTS[2])}`),
  );

  const complete = structuredClone(incomplete);
  complete.operation.weighting.overrides = {
    [key(INPUTS[1])]: {
      value: 200,
      unit: "kg/year",
      reason: "Corrected annual production supplied by the user",
      evidence: "fixture:evidence-b",
    },
    [key(INPUTS[2])]: {
      value: 300,
      unit: "kg/year",
      reason: "Sentinel replaced by a user-confirmed annual production",
      evidence: "fixture:evidence-c",
    },
  };
  const completeFile = path.join(fixture.root, "annual-complete.json");
  await writeFile(completeFile, canonicalJson(complete));
  const second = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: completeFile,
    outDir: path.join(fixture.root, "annual-analysis-complete"),
  });
  assert.equal(second.analysis.status, "ready");
  assert.equal(second.analysis.operation.weighting.rawTotal, 600);
  assert.deepEqual(
    second.analysis.operation.weighting.values.map(({ source }) => source),
    ["annual-field", "user-override", "user-override"],
  );
});

test("execution detects Candidate drift after freezing", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "drift-draft.json");
  await writeFile(
    draftFile,
    canonicalJson(draft({ decisions: resolvedDecisions() })),
  );
  const inspection = await analyzeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    outDir: path.join(fixture.root, "drift-analysis"),
  });
  const frozen = await freezeTransformation({
    candidateDir: fixture.candidate,
    dslFile: draftFile,
    analysisDir: inspection.path,
    outDir: path.join(fixture.root, "drift-frozen"),
  });
  const candidateFile = path.join(fixture.candidate, "release-candidate.json");
  const candidate = JSON.parse(await readFile(candidateFile, "utf8"));
  candidate.releaseVersion = "changed-after-freeze";
  await writeFile(candidateFile, canonicalJson(candidate));
  await assert.rejects(
    executeTransformation({
      candidateDir: fixture.candidate,
      specDir: frozen.path,
      outDir: path.join(fixture.root, "drift-execution"),
    }),
    ({ code }) => code === "transformation_input_drift",
  );
});

test("CLI emits bounded needs_decision JSON and a semantic reply template", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const draftFile = path.join(fixture.root, "cli-draft.json");
  await writeFile(draftFile, canonicalJson(draft({ decisions: [] })));
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI,
    "dsl",
    "inspect",
    "--candidate",
    fixture.candidate,
    "--dsl",
    draftFile,
    "--out-dir",
    path.join(fixture.root, "cli-analysis"),
    "--json",
  ]);
  assert.equal(stderr, "");
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "needs_decision");
  assert.equal(payload.replyTemplate.id, "transformation-inspected");
  assert.ok(payload.unresolvedCount > 0);
  assert.equal("conflicts" in payload, false);
});

function draft({ weighting = null, decisions = [] } = {}) {
  return {
    schemaVersion: "tiangong.release.dataset-transformation-dsl.v0",
    status: "draft",
    operation: {
      type: "process.weighted-aggregate.v0",
      inputs: INPUTS.map(key),
      weighting: weighting ?? {
        mode: "explicit",
        values: {
          [key(INPUTS[0])]: 0.5,
          [key(INPUTS[1])]: 0.3,
          [key(INPUTS[2])]: 0.2,
        },
      },
    },
    output: {
      identity: {
        uuid: OUTPUT,
        version: VERSION,
        uri: `https://example.test/process?uuid=${OUTPUT}&version=${VERSION}`,
      },
      generatedAt: "2026-08-26T00:00:00.000Z",
    },
    policies: {
      prototypeInput: key(INPUTS[0]),
      exchangeMetadata: {
        base: "take-from-prototype-then-input-order",
        dataSources: "union-deduplicate",
        comments: "replace-with-lineage",
        uncertainty: "reset",
        allocations: "reset",
      },
    },
    decisions,
  };
}

function resolvedDecisions({ annualStrategy = "drop" } = {}) {
  const first = key(INPUTS[0]);
  return [
    {
      conflictId: "field:name",
      strategy: "rewrite",
      value: {
        baseName: [{ "@xml:lang": "en", "#text": "Weighted electricity mix" }],
        functionalUnitFlowProperties: [],
        mixAndLocationTypes: [],
        treatmentStandardsRoutes: [],
      },
      reason: "The aggregate needs a distinct name",
    },
    {
      conflictId: "field:geography",
      strategy: "rewrite",
      value: {
        locationOfOperationSupplyOrProduction: { "@location": "CN" },
      },
      reason: "The output combines three regions",
    },
    {
      conflictId: "field:technology",
      strategy: "take-from",
      input: first,
      reason: "Fixture chooses the prototype technology explicitly",
    },
    {
      conflictId: "field:annualVolume",
      strategy: annualStrategy,
      reason: "Fixture makes the annual-volume policy explicit",
    },
  ];
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "transformation-v0-"));
  const candidate = path.join(root, "candidate");
  const packageRoot = path.join(root, "package-root");
  await mkdir(path.join(candidate, "packages"), { recursive: true });
  await mkdir(path.join(packageRoot, "processes"), { recursive: true });
  const documents = [
    processDocument({
      uuid: INPUTS[0],
      location: "CN-HB",
      refAmount: 1,
      inputAmount: 2,
      annual: "100 kg/year",
    }),
    processDocument({
      uuid: INPUTS[1],
      location: "CN-SN",
      refAmount: 2,
      inputAmount: 6,
      annual: null,
    }),
    processDocument({
      uuid: INPUTS[2],
      location: "CN-JS",
      refAmount: 4,
      inputAmount: 16,
      annual: "9999 missing-data-sentinel/year",
    }),
  ];
  const entries = [];
  for (const [index, document] of documents.entries()) {
    const file = `${INPUTS[index]}_${VERSION}.json`;
    const relative = `processes/${file}`;
    const bytes = Buffer.from(canonicalJson(document));
    await writeFile(path.join(packageRoot, relative), bytes);
    entries.push({
      byteSize: bytes.length,
      canonicalContentHash: hashJson(document),
      datasetType: "process",
      path: relative,
      role: "unit_process",
      sha256: sha256Bytes(bytes),
      uuid: INPUTS[index],
      version: VERSION,
    });
  }
  const archiveName = "TiangongLCA-test-UnitProcessDatabase.tidas.zip";
  const archive = path.join(candidate, "packages", archiveName);
  await execFileAsync("zip", ["-X", "-q", "-r", archive, "."], {
    cwd: packageRoot,
  });
  const archiveInfo = await readFile(archive);
  const packages = [
    {
      path: `packages/${archiveName}`,
      mediaType: "application/zip",
      byteSize: archiveInfo.length,
      sha256: await sha256File(archive),
    },
    ...[
      "UnitProcessDatabase.ilcd.zip",
      "ResultDatabase.tidas.zip",
      "ResultDatabase.ilcd.zip",
    ].map((name, index) => ({
      path: `packages/TiangongLCA-test-${name}`,
      mediaType: "application/zip",
      byteSize: index + 1,
      sha256: String(index + 1).repeat(64),
    })),
  ];
  const index = {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: entries.length,
    datasets: entries,
  };
  await writeFile(
    path.join(candidate, "canonical-dataset-index.json"),
    canonicalJson(index),
  );
  const releaseCandidate = {
    schemaVersion: "tiangong.release.release-candidate.v1",
    status: "local_candidate",
    publicationAuthorized: false,
    releaseVersion: "fixture",
    profile: "standalone-lifecyclemodel-result-full-closure.v1",
    packagePlanSha256: "a".repeat(64),
    canonicalDatasetIndexSha256: hashJson(index),
    packages,
    packageSetHash: hashJson(
      packages.map(({ path: itemPath, sha256, byteSize }) => ({
        path: itemPath,
        sha256,
        byteSize,
      })),
    ),
    validation: {
      delegatedTo: "tidas-tools",
      outcome: "passed",
      reportPath: "tidas-release-report.json",
      archiveReadbackReportPath: "package-verification-report.json",
    },
    scopeDecisionSha256: null,
  };
  await writeFile(
    path.join(candidate, "release-candidate.json"),
    canonicalJson(releaseCandidate),
  );
  return { root, candidate };
}

function processDocument({ uuid, location, refAmount, inputAmount, annual }) {
  return {
    processDataSet: {
      "@version": "1.1",
      processInformation: {
        dataSetInformation: {
          "common:UUID": uuid,
          name: {
            baseName: [
              { "@xml:lang": "en", "#text": `Electricity ${location}` },
            ],
            functionalUnitFlowProperties: [],
            mixAndLocationTypes: [],
            treatmentStandardsRoutes: [],
          },
          "common:generalComment": [],
        },
        quantitativeReference: {
          "@type": "Reference flow(s)",
          referenceToReferenceFlow: "1",
        },
        time: { "common:referenceYear": 2019 },
        geography: {
          locationOfOperationSupplyOrProduction: { "@location": location },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: [
            { "@xml:lang": "en", "#text": `Technology ${location}` },
          ],
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: "Unit process, single operation",
        },
        dataSourcesTreatmentAndRepresentativeness: {
          annualSupplyOrProductionVolume: annual
            ? [{ "@xml:lang": "en", "#text": annual }]
            : [],
        },
        validation: { review: { "@type": "Not reviewed" } },
      },
      administrativeInformation: {
        dataEntryBy: { "common:timeStamp": "2026-01-01T00:00:00.000Z" },
        publicationAndOwnership: {
          "common:dataSetVersion": VERSION,
          "common:dateOfLastRevision": "2026-01-01T00:00:00.000Z",
          "common:permanentDataSetURI": `https://example.test/${uuid}/${VERSION}`,
        },
      },
      exchanges: {
        exchange: [
          exchange("0", "Input", FLOW_INPUT, inputAmount),
          exchange("1", "Output", FLOW_REFERENCE, refAmount),
        ],
      },
    },
  };
}

function exchange(id, direction, flow, amount) {
  return {
    "@dataSetInternalID": id,
    exchangeDirection: direction,
    meanAmount: String(amount),
    resultingAmount: String(amount),
    referenceToFlowDataSet: {
      "@refObjectId": flow,
      "@version": VERSION,
      "@type": "flow data set",
    },
  };
}
