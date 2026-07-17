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
import { runReleaseStage } from "../src/stages/runner.js";
import { initializeReleaseWorkspace } from "../src/workspace/run-store.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

test("conversion, validation, round-trip, and packaging stages produce an immutable publish plan", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-external-"));
  const previousExecutable = process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE;
  try {
    const fakeSource = fileURLToPath(
      new URL("./fixtures/fake-tidas-release-tool.mjs", import.meta.url),
    );
    const fakeExecutable = path.join(root, "fake-tidas-release-tool");
    copyFileSync(fakeSource, fakeExecutable);
    chmodSync(fakeExecutable, 0o755);
    process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE = fakeExecutable;

    const fixture = createCalculationBundleFixture(root);
    const runDirectory = path.join(root, "run");
    initializeReleaseWorkspace({
      request: fixture.request,
      outDirectory: runDirectory,
      profileLock: { schemaVersion: "tiangong.release.profiles.v1" },
    });
    const stages = [
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
      "convert-ilcd",
      "validate-ilcd",
      "semantic-roundtrip",
      "build-packages",
    ];
    for (const stage of stages) {
      assert.equal(
        (await runReleaseStage(runDirectory, stage)).status,
        "passed",
      );
    }

    const manifest = JSON.parse(
      readFileSync(
        path.join(runDirectory, "outputs", "release-manifest.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    const plan = JSON.parse(
      readFileSync(
        path.join(runDirectory, "outputs", "publish-plan.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    assert.equal(manifest.schemaVersion, "tiangong.release-manifest.v1");
    assert.equal(manifest.packages.length, 4);
    const generatedDatasets = manifest.datasets.filter(
      (dataset: Record<string, unknown>) =>
        dataset.role === "lifecycle_model" || dataset.role === "result_process",
    );
    assert.equal(generatedDatasets.length, 2);
    assert.ok(
      generatedDatasets.every(
        (dataset: Record<string, any>) =>
          dataset.sourceProcess?.id ===
            "11111111-1111-4111-8111-111111111111" &&
          dataset.sourceProcess?.version === "01.00.000",
      ),
    );
    assert.equal(manifest.publishPlanHash, plan.planHash);
    assert.match(plan.planHash, /^[0-9a-f]{64}$/);

    const firstPlanHash = plan.planHash;
    assert.equal(
      (await runReleaseStage(runDirectory, "build-packages")).attempt,
      2,
    );
    const retriedPlan = JSON.parse(
      readFileSync(
        path.join(runDirectory, "outputs", "publish-plan.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    assert.equal(retriedPlan.planHash, firstPlanHash);
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE;
    } else {
      process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE = previousExecutable;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
