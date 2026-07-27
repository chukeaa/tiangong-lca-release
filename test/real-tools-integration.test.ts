import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runReleaseStage } from "../src/stages/runner.js";
import { initializeReleaseWorkspace } from "../src/workspace/run-store.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

const REAL_TOOLS_EXECUTABLE =
  process.env.TIANGONG_TIDAS_INTEGRATION_EXECUTABLE ??
  process.env.TIANGONG_TIDAS_EXECUTABLE;

const PACKAGE_STAGES = [
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
] as const;

test(
  "real Rust tidas validates, round-trips, and packages a complete release closure",
  {
    skip: REAL_TOOLS_EXECUTABLE
      ? false
      : "set TIANGONG_TIDAS_INTEGRATION_EXECUTABLE or TIANGONG_TIDAS_EXECUTABLE to run",
  },
  async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "tiangong-release-real-tools-integration-"),
    );
    const previousExecutable = process.env.TIANGONG_TIDAS_EXECUTABLE;
    try {
      process.env.TIANGONG_TIDAS_EXECUTABLE = REAL_TOOLS_EXECUTABLE!;
      const fixture = createCalculationBundleFixture(root);
      const runDirectory = path.join(root, "run");
      initializeReleaseWorkspace({
        request: fixture.request,
        outDirectory: runDirectory,
        profileLock: {
          schemaVersion: "tiangong.release.profiles.v1",
          modelProfileId: "resolved-one-hop-aggregated-background.v1",
          resultProfileId: "lci-lcia-result.v1",
        },
        now: new Date("2026-07-16T00:00:00.000Z"),
      });

      for (const stage of PACKAGE_STAGES) {
        const result = await runReleaseStage(runDirectory, stage);
        assert.equal(
          result.status,
          "passed",
          `${stage}: ${result.blockers.map((item) => item.message).join("; ")}`,
        );
      }

      for (const reportName of [
        "tidas-validation-report.json",
        "ilcd-validation-report.json",
        "semantic-roundtrip-report.json",
      ]) {
        const report = JSON.parse(
          readFileSync(path.join(runDirectory, "reports", reportName), "utf8"),
        ) as Record<string, any>;
        assert.equal(
          report.schema_version,
          "tidas.operation-report.v1",
          reportName,
        );
        assert.equal(report.status, "succeeded", reportName);
      }

      const manifest = JSON.parse(
        readFileSync(
          path.join(runDirectory, "outputs", "release-manifest.json"),
          "utf8",
        ),
      ) as {
        packages: Array<{
          profileId: string;
          format: string;
          artifact: { path: string };
        }>;
      };
      assert.deepEqual(
        manifest.packages.map((item) => [item.profileId, item.format]).sort(),
        [
          ["standalone-lifecyclemodel-result-full-closure.v1", "ilcd"],
          ["standalone-lifecyclemodel-result-full-closure.v1", "tidas"],
          ["unit-process-full-closure.v1", "ilcd"],
          ["unit-process-full-closure.v1", "tidas"],
        ],
      );
      assert.ok(
        manifest.packages.every((item) =>
          existsSync(path.resolve(runDirectory, item.artifact.path)),
        ),
      );
    } finally {
      if (previousExecutable === undefined) {
        delete process.env.TIANGONG_TIDAS_EXECUTABLE;
      } else {
        process.env.TIANGONG_TIDAS_EXECUTABLE = previousExecutable;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
