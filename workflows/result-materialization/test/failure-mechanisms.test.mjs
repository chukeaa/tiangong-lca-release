import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "../lib/concurrency.mjs";
import { normalizeCompatibleProcessDocument } from "../lib/process-compat.mjs";
import { validateOneHopReconstruction } from "../lib/reconstruction.mjs";
import {
  indexPreviousModelVariants,
  resolveExactSourceVariantVersions,
} from "../lib/versioning.mjs";

test("process compatibility is explicit and does not mutate source input", () => {
  const source = {
    processDataSet: {
      processInformation: { dataSetInformation: { name: { baseName: [] } } },
    },
  };
  const normalized = normalizeCompatibleProcessDocument(source);
  assert.equal(
    normalized.processDataSet.processInformation.dataSetInformation.name
      .treatmentStandardsRoutes[0]["#text"],
    " ",
  );
  assert.equal(
    normalized.processDataSet.processInformation.dataSetInformation.name
      .mixAndLocationTypes[0]["#text"],
    " ",
  );
  assert.equal(
    source.processDataSet.processInformation.dataSetInformation.name
      .treatmentStandardsRoutes,
    undefined,
  );
});

test("concurrency waits for started workers and preserves the first error", async () => {
  const primary = Object.assign(new Error("primary failure"), {
    code: "primary_failure",
  });
  let siblingFinished = false;
  const started = [];
  await assert.rejects(
    mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      if (value === 0) {
        await delay(5);
        throw primary;
      }
      await delay(20);
      siblingFinished = true;
    }),
    (error) => error === primary,
  );
  assert.equal(siblingFinished, true);
  assert.deepEqual(started, [0, 1]);
});

test("reconstruction tolerance uses a commensurate inventory scale", () => {
  const large = record("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "kg", 100);
  const cancellation = record(
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "kg",
    1e-7,
  );
  const context = reconstructionContext([large, cancellation], [large]);
  const evidence = validateOneHopReconstruction(context, 0);
  assert.equal(evidence.outcome, "passed");
  assert.equal(evidence.comparisonScale, "direction_and_unit");

  const materialMismatch = reconstructionContext(
    [large, { ...cancellation, meanAmount: 1e-4 }],
    [large],
  );
  assert.throws(
    () => validateOneHopReconstruction(materialMismatch, 0),
    (error) => error.code === "one_hop_reconstruction_mismatch",
  );
});

test("model variants keep one lineage and receive exact dataset versions", () => {
  const uuid = "cccccccc-cccc-5ccc-8ccc-cccccccccccc";
  const hash = (value) => value.repeat(64);
  const draft = (processIndex, version, value) => ({
    axis: { processIndex },
    provisional: {
      uuid,
      sourceProcess: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        version,
      },
    },
    hashes: {
      semanticHash: hash(value),
      versionSignificantHash: hash(value),
      canonicalContentHash: hash(value),
    },
  });
  const resolutions = resolveExactSourceVariantVersions(
    [draft(1, "01.01.002", "a"), draft(2, "01.01.003", "b")],
    indexPreviousModelVariants(null),
    {
      datasetType: "lifecyclemodel",
      duplicateCode: "model_source_variant_duplicate",
    },
  );
  assert.equal(resolutions.get(1).version, "01.00.000");
  assert.equal(resolutions.get(2).version, "02.00.000");
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(flowId, unit, meanAmount) {
  return {
    flow: { id: flowId, version: "01.00.000" },
    direction: "Input",
    unit,
    meanAmount,
  };
}

function reconstructionContext(providerInventory, expectedInventory) {
  return {
    biosphere: new Map(),
    technosphereEdges: [
      {
        dependentProcessIndex: 0,
        balancingProcessIndex: 1,
        activityRequirement: 1,
      },
    ],
    lci: new Map([
      [0, expectedInventory],
      [1, providerInventory],
    ]),
  };
}
