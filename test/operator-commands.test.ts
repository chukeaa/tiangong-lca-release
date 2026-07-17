import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeReleaseCli } from "../src/cli.js";
import { readJsonFile } from "../src/io/files.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

const PACKAGE_ID = "90000000-0000-4000-8000-000000000001";

function copyExecutable(
  root: string,
  fixtureName: string,
  targetName: string,
): string {
  const source = fileURLToPath(
    new URL(`./fixtures/${fixtureName}`, import.meta.url),
  );
  const target = path.join(root, targetName);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  return target;
}

function assertTextAbsent(directory: string, forbidden: string): void {
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else
        assert.equal(
          readFileSync(child).includes(Buffer.from(forbidden)),
          false,
          child,
        );
    }
  };
  visit(directory);
}

test("doctor, bootstrap, runs list, and exact candidate form a read-only operator intake", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-operator-"));
  const releaseRoot = path.join(root, ".release");
  const secret = "operator-secret-sentinel-must-not-persist";
  const names = [
    "TIANGONG_LCA_CLI_EXECUTABLE",
    "TIANGONG_TIDAS_TOOLS_EXECUTABLE",
    "TIANGONG_LCA_API_BASE_URL",
    "TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY",
    "TIANGONG_LCA_API_KEY",
    "FAKE_CALCULATION_PACKAGE_ID",
    "FAKE_CALCULATION_BUNDLE_DIRECTORY",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    const fixture = createCalculationBundleFixture(root);
    process.env.TIANGONG_LCA_CLI_EXECUTABLE = copyExecutable(
      root,
      "fake-tiangong-lca.mjs",
      "fake-tiangong-lca",
    );
    process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE = copyExecutable(
      root,
      "fake-tidas-release-tool.mjs",
      "fake-tidas-release-tool",
    );
    process.env.TIANGONG_LCA_API_BASE_URL =
      "https://release.invalid/functions/v1";
    process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY =
      "fixture-publishable-key";
    process.env.TIANGONG_LCA_API_KEY = secret;
    process.env.FAKE_CALCULATION_PACKAGE_ID = PACKAGE_ID;
    process.env.FAKE_CALCULATION_BUNDLE_DIRECTORY = fixture.bundleDirectory;

    const doctor = await executeReleaseCli([
      "doctor",
      "--target",
      "fixture",
      "--json",
    ]);
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorBody = JSON.parse(doctor.stdout) as Record<string, unknown>;
    assert.equal(doctorBody.status, "ready");
    assert.equal(doctorBody.complete, true);
    assert.equal(doctorBody.truncated, false);
    assert.doesNotMatch(doctor.stdout, new RegExp(secret, "u"));

    const first = await executeReleaseCli([
      "bootstrap",
      "--target",
      "fixture",
      "--package-id",
      PACKAGE_ID,
      "--root",
      releaseRoot,
      "--json",
    ]);
    assert.equal(first.exitCode, 0, first.stderr);
    const firstBody = JSON.parse(first.stdout) as Record<string, any>;
    assert.equal(firstBody.status, "completed");
    assert.equal(firstBody.reused, false);
    assert.equal(firstBody.calculationBundle.artifactCount, 8);
    assert.equal(firstBody.sourceClosure.datasetCount, 8);

    const second = await executeReleaseCli([
      "bootstrap",
      "--target",
      "fixture",
      "--package-id",
      PACKAGE_ID,
      "--root",
      releaseRoot,
      "--json",
    ]);
    assert.equal(second.exitCode, 0, second.stderr);
    const secondBody = JSON.parse(second.stdout) as Record<string, any>;
    assert.equal(secondBody.releaseRunId, firstBody.releaseRunId);
    assert.equal(secondBody.reused, true);

    const runs = await executeReleaseCli([
      "runs",
      "list",
      "--root",
      releaseRoot,
      "--json",
    ]);
    assert.equal(runs.exitCode, 0, runs.stderr);
    const runsBody = JSON.parse(runs.stdout) as Record<string, any>;
    assert.equal(runsBody.total, 1);
    assert.equal(runsBody.runs[0].runDirectory, firstBody.runDirectory);

    const candidate = await executeReleaseCli([
      "candidate",
      "--run-dir",
      firstBody.runDirectory,
      "--json",
    ]);
    assert.equal(candidate.exitCode, 0, candidate.stderr);
    const candidateBody = JSON.parse(candidate.stdout) as Record<string, any>;
    assert.equal(candidateBody.releaseRunId, firstBody.releaseRunId);
    assert.equal(candidateBody.target.targetId, "fixture");
    assert.equal(candidateBody.publishPlan, null);
    assert.equal(candidateBody.truncated, false);
    const storedCandidate = readJsonFile<Record<string, unknown>>(
      candidateBody.reportPath,
    );
    assert.equal(
      storedCandidate.schemaVersion,
      "tiangong.release-candidate-report.v1",
    );

    const implicit = await executeReleaseCli(["candidate", "--json"]);
    assert.equal(implicit.exitCode, 1);
    assert.match(implicit.stderr, /option_required:--run-dir/u);

    assertTextAbsent(releaseRoot, secret);
    assertTextAbsent(releaseRoot, "signedDownloadUrl");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor blocks a mismatched explicit target without exposing credentials", async () => {
  const previousBaseUrl = process.env.TIANGONG_LCA_API_BASE_URL;
  const previousPublishable = process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  const previousKey = process.env.TIANGONG_LCA_API_KEY;
  try {
    process.env.TIANGONG_LCA_API_BASE_URL =
      "https://different.invalid/functions/v1";
    process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY =
      "fixture-publishable-key";
    process.env.TIANGONG_LCA_API_KEY = "mismatch-secret-sentinel";
    const result = await executeReleaseCli([
      "doctor",
      "--target",
      "fixture",
      "--json",
    ]);
    assert.equal(result.exitCode, 2);
    assert.equal(JSON.parse(result.stdout).status, "blocked");
    assert.doesNotMatch(result.stdout, /mismatch-secret-sentinel/u);
  } finally {
    if (previousBaseUrl === undefined)
      delete process.env.TIANGONG_LCA_API_BASE_URL;
    else process.env.TIANGONG_LCA_API_BASE_URL = previousBaseUrl;
    if (previousPublishable === undefined)
      delete process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
    else
      process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = previousPublishable;
    if (previousKey === undefined) delete process.env.TIANGONG_LCA_API_KEY;
    else process.env.TIANGONG_LCA_API_KEY = previousKey;
  }
});
