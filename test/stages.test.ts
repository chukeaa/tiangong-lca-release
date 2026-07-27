import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readDatasetDescriptors } from "../src/materialization/io.js";
import { releaseRunSummary, runReleaseStage } from "../src/stages/runner.js";
import {
  initializeReleaseWorkspace,
  readReleaseRun,
} from "../src/workspace/run-store.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

const PROFILE_LOCK = {
  schemaVersion: "tiangong.release.profiles.v1",
  modelProfileId: "resolved-one-hop-aggregated-background.v1",
  resultProfileId: "lci-lcia-result.v1",
};

test("release workspace verifies a bundle, graph evidence, identity vectors, and previous state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-"));
  const previousExecutable = process.env.TIANGONG_TIDAS_EXECUTABLE;
  try {
    const executable = path.join(root, "tidas");
    copyFileSync(
      fileURLToPath(new URL("./fixtures/fake-tidas.mjs", import.meta.url)),
      executable,
    );
    chmodSync(executable, 0o755);
    process.env.TIANGONG_TIDAS_EXECUTABLE = executable;
    const fixture = createCalculationBundleFixture(root);
    const runDirectory = path.join(root, "run");
    initializeReleaseWorkspace({
      request: fixture.request,
      outDirectory: runDirectory,
      profileLock: PROFILE_LOCK,
      now: new Date("2026-07-16T00:00:00.000Z"),
    });

    for (const stage of [
      "resolve-calculation-bundle",
      "verify-graph-evidence",
      "derive-identities",
      "load-previous-release",
      "project-model-drafts",
      "materialize-result-drafts",
      "metadata-completion",
      "build-version-significant-descriptors",
      "resolve-final-version-set",
      "render-exact-references",
      "finalize-canonical-artifacts",
      "validate-tidas",
    ]) {
      const result = await runReleaseStage(runDirectory, stage);
      assert.equal(result.status, "passed");
    }

    const identity = JSON.parse(
      readFileSync(
        path.join(runDirectory, "outputs", "identities.jsonl"),
        "utf8",
      ).trim(),
    ) as Record<string, unknown>;
    assert.equal(identity.modelUuid, "c58f567c-c631-5a3a-90d9-c0cec7290cf8");
    assert.equal(
      identity.resultProcessUuid,
      "ba3386d3-39c0-5a48-ae4d-e7ad90ec4996",
    );

    const generated = readDatasetDescriptors(
      path.join(runDirectory, "outputs", "rendered-datasets.jsonl"),
    );
    assert.equal(generated.length, 2);
    const model = generated.find(
      (item) => item.datasetType === "lifecyclemodel",
    )!;
    const result = generated.find((item) => item.role === "result_process")!;
    assert.equal(model.version, "01.00.000");
    assert.equal(result.version, "01.00.000");
    assert.equal(
      (model.document as any).lifeCycleModelDataSet.lifeCycleModelInformation
        .dataSetInformation.referenceToResultingProcess["@refObjectId"],
      result.uuid,
    );
    assert.equal(
      (result.document as any).processDataSet.exchanges.exchange.length,
      2,
    );
    assert.equal(
      (result.document as any).processDataSet.LCIAResults.LCIAResult.length,
      1,
    );

    const summary = releaseRunSummary(runDirectory);
    assert.equal(summary.counts.passed, 13);
    assert.equal(summary.partial, true);
    assert.equal(summary.complete, false);
    assert.equal(summary.nextStage, "convert-ilcd");
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.TIANGONG_TIDAS_EXECUTABLE;
    } else {
      process.env.TIANGONG_TIDAS_EXECUTABLE = previousExecutable;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("stages fail closed on predecessor and artifact hash mismatches and remain retryable", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-"));
  try {
    const fixture = createCalculationBundleFixture(root);
    const runDirectory = path.join(root, "run");
    initializeReleaseWorkspace({
      request: fixture.request,
      outDirectory: runDirectory,
      profileLock: PROFILE_LOCK,
    });

    await assert.rejects(
      runReleaseStage(runDirectory, "derive-identities"),
      /stage_predecessor_incomplete:resolve-calculation-bundle:pending/,
    );

    const artifactPath = path.join(
      fixture.bundleDirectory,
      fixture.manifest.artifacts[0]!.path,
    );
    const original = readFileSync(artifactPath);
    const { appendFileSync, writeFileSync } = await import("node:fs");
    appendFileSync(artifactPath, "corrupt");
    await assert.rejects(
      runReleaseStage(runDirectory, "resolve-calculation-bundle"),
      /calculation_bundle_artifact_size_mismatch/,
    );
    let run = readReleaseRun(runDirectory);
    assert.equal(run.stages[1]!.status, "failed");
    assert.equal(run.stages[1]!.attempt, 1);

    writeFileSync(artifactPath, original);
    const retried = await runReleaseStage(
      runDirectory,
      "resolve-calculation-bundle",
    );
    assert.equal(retried.status, "passed");
    assert.equal(retried.attempt, 2);
    run = readReleaseRun(runDirectory);
    assert.equal(run.status, "active");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("calculation bundle scope must match the frozen release request", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-"));
  try {
    const fixture = createCalculationBundleFixture(root);
    const runDirectory = path.join(root, "run");
    initializeReleaseWorkspace({
      request: {
        ...fixture.request,
        scope: {
          ...fixture.request.scope,
          selectionManifestHash: "f".repeat(64),
        },
      },
      outDirectory: runDirectory,
      profileLock: PROFILE_LOCK,
    });
    await assert.rejects(
      runReleaseStage(runDirectory, "resolve-calculation-bundle"),
      /calculation_bundle_scope_mismatch/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
