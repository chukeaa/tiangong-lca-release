import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyApprovalDecision } from "../src/approval/decision.js";
import { executeReleaseCli } from "../src/cli.js";
import { readJsonFile } from "../src/io/files.js";
import { runReleaseStage } from "../src/stages/runner.js";
import {
  loadReleaseTargetProfile,
  releaseTargetBinding,
} from "../src/target/profile.js";
import {
  initializeReleaseWorkspace,
  readReleaseRun,
} from "../src/workspace/run-store.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

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

type PreparedRun = {
  root: string;
  runDirectory: string;
  publishPlanHash: string;
  targetFingerprint: string;
  restore: () => void;
};

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

async function prepareRun(
  options: { throughCli?: boolean } = {},
): Promise<PreparedRun> {
  const root = mkdtempSync(
    path.join(tmpdir(), "tiangong-release-publication-"),
  );
  const previousTidas = process.env.TIANGONG_TIDAS_EXECUTABLE;
  const previousCli = process.env.TIANGONG_LCA_CLI_EXECUTABLE;
  const previousApiKey = process.env.TIANGONG_LCA_API_KEY;
  const previousApiBaseUrl = process.env.TIANGONG_LCA_API_BASE_URL;
  const previousPublishableKey =
    process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY;
  process.env.TIANGONG_TIDAS_EXECUTABLE = copyExecutable(
    root,
    "fake-tidas.mjs",
    "tidas",
  );
  process.env.TIANGONG_LCA_CLI_EXECUTABLE = copyExecutable(
    root,
    "fake-tiangong-lca.mjs",
    "fake-tiangong-lca",
  );
  process.env.TIANGONG_LCA_API_KEY =
    "password-equivalent-sentinel-must-not-persist";
  process.env.TIANGONG_LCA_API_BASE_URL =
    "https://release.invalid/functions/v1";
  process.env.TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY = "fixture-publishable-key";

  const fixture = createCalculationBundleFixture(root);
  const target = releaseTargetBinding(loadReleaseTargetProfile("fixture"));
  const runDirectory = path.join(root, "run");
  initializeReleaseWorkspace({
    request: { ...fixture.request, target },
    outDirectory: runDirectory,
    profileLock: { schemaVersion: "tiangong.release.profiles.v1" },
  });
  if (options.throughCli) {
    const packaged = await executeReleaseCli([
      "package",
      "--run-dir",
      runDirectory,
      "--json",
    ]);
    assert.equal(packaged.exitCode, 0, packaged.stderr);
  } else {
    for (const stage of PACKAGE_STAGES) {
      assert.equal(
        (await runReleaseStage(runDirectory, stage)).status,
        "passed",
      );
    }
  }
  const publishPlan = readJsonFile<Record<string, unknown>>(
    path.join(runDirectory, "outputs", "publish-plan.json"),
  );
  const restore = () => {
    for (const [name, value] of [
      ["TIANGONG_TIDAS_EXECUTABLE", previousTidas],
      ["TIANGONG_LCA_CLI_EXECUTABLE", previousCli],
      ["TIANGONG_LCA_API_KEY", previousApiKey],
      ["TIANGONG_LCA_API_BASE_URL", previousApiBaseUrl],
      ["TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY", previousPublishableKey],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env.FAKE_LCA_CLI_FAIL_ACTION;
    delete process.env.FAKE_LCA_CLI_FAIL_CODE;
    rmSync(root, { recursive: true, force: true });
  };
  return {
    root,
    runDirectory,
    publishPlanHash: String(publishPlan.planHash),
    targetFingerprint: target.targetFingerprint,
    restore,
  };
}

function assertSecretAbsent(directory: string, secret: string): void {
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else
        assert.equal(
          readFileSync(child).includes(Buffer.from(secret)),
          false,
          child,
        );
    }
  };
  visit(directory);
}

test("approval, publish, and independent readback complete through public CLIs", async () => {
  const prepared = await prepareRun({ throughCli: true });
  try {
    const decisionPath = path.join(prepared.root, "approval.json");
    writeFileSync(
      decisionPath,
      `${JSON.stringify({
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
        publishPlanHash: prepared.publishPlanHash,
        targetFingerprint: prepared.targetFingerprint,
        decision: "approve",
        reason: "Reviewed exact package and validation evidence.",
      })}\n`,
      "utf8",
    );
    const decision = await executeReleaseCli([
      "decision",
      "apply",
      "--run-dir",
      prepared.runDirectory,
      "--input",
      decisionPath,
      "--json",
    ]);
    assert.equal(decision.exitCode, 0, decision.stderr);
    assert.equal(JSON.parse(decision.stdout).reused, false);

    const wrongPlan = await executeReleaseCli([
      "publish",
      "--run-dir",
      prepared.runDirectory,
      "--approve-plan",
      "f".repeat(64),
      "--json",
    ]);
    assert.equal(wrongPlan.exitCode, 1);
    assert.match(wrongPlan.stderr, /approval_plan_hash_mismatch/u);

    const published = await executeReleaseCli([
      "publish",
      "--run-dir",
      prepared.runDirectory,
      "--approve-plan",
      prepared.publishPlanHash,
      "--json",
    ]);
    assert.equal(published.exitCode, 0, published.stderr);
    assert.equal(JSON.parse(published.stdout).summary.status, "published");

    const verified = await executeReleaseCli([
      "verify",
      "--run-dir",
      prepared.runDirectory,
      "--json",
    ]);
    assert.equal(verified.exitCode, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).summary.status, "verified");
    const summary = JSON.parse(verified.stdout).summary;
    assert.equal(summary.complete, true);
    assert.equal(summary.ambiguous, false);

    const readback = readJsonFile<Record<string, unknown>>(
      path.join(
        prepared.runDirectory,
        "reports",
        "independent-readback-report.json",
      ),
    );
    assert.equal(readback.status, "passed");
    assert.equal((readback.artifacts as unknown[]).length, 4);
    const invocations = readFileSync(
      path.join(prepared.runDirectory, ".fake-lca-cli-invocations.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { argv: string[] });
    assert.deepEqual(
      invocations.map((item) => item.argv[1]),
      [
        "prepare",
        "upload",
        "finalize",
        "approve",
        "publish",
        "status",
        "artifact-download",
        "artifact-download",
        "artifact-download",
        "artifact-download",
        "readback-verify",
        "status",
      ],
    );
    assert.equal(
      invocations.every((item) => item.argv.includes("--force")),
      true,
    );
    assert.equal(
      invocations.some((item) => item.argv.includes("--api-key")),
      false,
    );
    assertSecretAbsent(
      prepared.runDirectory,
      "password-equivalent-sentinel-must-not-persist",
    );

    await assert.rejects(
      runReleaseStage(prepared.runDirectory, "build-packages"),
      /stage_successor_already_completed:approval/u,
    );
    const validateAgain = await executeReleaseCli([
      "validate",
      "--run-dir",
      prepared.runDirectory,
      "--json",
    ]);
    assert.equal(validateAgain.exitCode, 0);
  } finally {
    prepared.restore();
  }
});

test("approval stage preserves manager errors and resumes idempotently", async () => {
  const prepared = await prepareRun();
  try {
    const firstDecision = await applyApprovalDecision({
      runDirectory: prepared.runDirectory,
      value: {
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
        publishPlanHash: prepared.publishPlanHash,
        targetFingerprint: prepared.targetFingerprint,
        decision: "approve",
      },
    });
    assert.equal(firstDecision.reused, false);
    assert.equal(
      (
        await applyApprovalDecision({
          runDirectory: prepared.runDirectory,
          value: firstDecision.decision,
        })
      ).reused,
      true,
    );
    await assert.rejects(
      applyApprovalDecision({
        runDirectory: prepared.runDirectory,
        value: { ...firstDecision.decision, reason: "Different approval." },
      }),
      /approval_decision_conflict/u,
    );
    process.env.FAKE_LCA_CLI_FAIL_ACTION = "approve";
    await assert.rejects(
      runReleaseStage(prepared.runDirectory, "approval"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code: string }).code === "not_data_product_manager",
    );
    let run = readReleaseRun(prepared.runDirectory);
    assert.equal(run.stages[17]!.status, "failed");
    assert.equal(run.stages[17]!.attempt, 1);

    delete process.env.FAKE_LCA_CLI_FAIL_ACTION;
    const retried = await runReleaseStage(prepared.runDirectory, "approval");
    assert.equal(retried.status, "passed");
    assert.equal(retried.attempt, 2);
    run = readReleaseRun(prepared.runDirectory);
    assert.equal(run.status, "approved");
  } finally {
    prepared.restore();
  }
});

test("approval revalidates the canonical publish-plan hash before remote writes", async () => {
  const prepared = await prepareRun();
  try {
    await applyApprovalDecision({
      runDirectory: prepared.runDirectory,
      value: {
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
        publishPlanHash: prepared.publishPlanHash,
        targetFingerprint: prepared.targetFingerprint,
        decision: "approve",
      },
    });
    const planPath = path.join(
      prepared.runDirectory,
      "outputs",
      "publish-plan.json",
    );
    const plan = readJsonFile<Record<string, any>>(planPath);
    plan.packages[0].sha256 = "e".repeat(64);
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await assert.rejects(
      runReleaseStage(prepared.runDirectory, "approval"),
      /release_publish_plan_binding_mismatch/u,
    );
    assert.equal(
      existsSync(
        path.join(prepared.runDirectory, ".fake-lca-cli-invocations.jsonl"),
      ),
      false,
    );
  } finally {
    prepared.restore();
  }
});

test("remote publication denies target environment drift before the first write", async () => {
  const prepared = await prepareRun();
  try {
    await applyApprovalDecision({
      runDirectory: prepared.runDirectory,
      value: {
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
        publishPlanHash: prepared.publishPlanHash,
        targetFingerprint: prepared.targetFingerprint,
        decision: "approve",
      },
    });
    process.env.TIANGONG_LCA_API_BASE_URL =
      "https://drift.invalid/functions/v1";
    await assert.rejects(
      runReleaseStage(prepared.runDirectory, "approval"),
      /release_target_environment_mismatch:fixture/u,
    );
    assert.equal(
      existsSync(
        path.join(prepared.runDirectory, ".fake-lca-cli-invocations.jsonl"),
      ),
      false,
    );
  } finally {
    prepared.restore();
  }
});

test("target-bound publish plans reject legacy or mismatched approvals", async () => {
  const prepared = await prepareRun();
  try {
    await assert.rejects(
      applyApprovalDecision({
        runDirectory: prepared.runDirectory,
        value: {
          schemaVersion: "tiangong.release.approval-decision.v1",
          releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
          publishPlanHash: prepared.publishPlanHash,
          decision: "approve",
        },
      }),
      /approval_decision_binding_mismatch/u,
    );
    await assert.rejects(
      applyApprovalDecision({
        runDirectory: prepared.runDirectory,
        value: {
          schemaVersion: "tiangong.release.approval-decision.v2",
          releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
          publishPlanHash: prepared.publishPlanHash,
          targetFingerprint: "f".repeat(64),
          decision: "approve",
        },
      }),
      /approval_decision_binding_mismatch/u,
    );
  } finally {
    prepared.restore();
  }
});

test("independent readback fails before confirmation when remote bytes drift", async () => {
  const prepared = await prepareRun();
  try {
    await applyApprovalDecision({
      runDirectory: prepared.runDirectory,
      value: {
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: readReleaseRun(prepared.runDirectory).releaseRunId,
        publishPlanHash: prepared.publishPlanHash,
        targetFingerprint: prepared.targetFingerprint,
        decision: "approve",
      },
    });
    await runReleaseStage(prepared.runDirectory, "approval");
    await runReleaseStage(prepared.runDirectory, "publish");
    const fakeState = readJsonFile<{
      artifacts: Array<{ remotePath: string }>;
    }>(path.join(prepared.runDirectory, ".fake-lca-cli-state.json"));
    appendFileSync(fakeState.artifacts[0]!.remotePath, "drift");
    await assert.rejects(
      runReleaseStage(prepared.runDirectory, "readback-verify"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code: string }).code ===
          "LCA_RELEASE_DOWNLOAD_SIZE_MISMATCH",
    );
    assert.equal(
      existsSync(
        path.join(prepared.runDirectory, "outputs", "readback-receipt.json"),
      ),
      false,
    );
    assert.equal(readReleaseRun(prepared.runDirectory).status, "failed");
  } finally {
    prepared.restore();
  }
});
