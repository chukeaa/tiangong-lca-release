#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  applyApprovalDecision,
  readApprovalDecision,
} from "./approval/decision.js";
import type { JsonValue } from "./contracts/json.js";
import { readJsonFile, sha256File, writeJsonAtomic } from "./io/files.js";
import { bootstrapReleaseRun } from "./operator/bootstrap.js";
import { buildReleaseCandidateReport } from "./operator/candidate.js";
import { releaseDoctor } from "./operator/doctor.js";
import { listReleaseRuns } from "./operator/runs.js";
import {
  releasePlan,
  releaseRunSummary,
  runReleaseStage,
} from "./stages/runner.js";
import { STAGE_IDS, type StageId } from "./stages/catalog.js";
import { assertRemoteTargetFrontier } from "./target/frontier.js";
import {
  assertReleaseRequest,
  initializeReleaseWorkspace,
  readReleaseRun,
  type ReleaseRequest,
} from "./workspace/run-store.js";
import { releaseWorkspaceLayout } from "./workspace/layout.js";

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

const mainHelp = `TianGong LCA Release control plane

Usage:
  tiangong-release doctor --target <id> [--json]
  tiangong-release bootstrap --target <id> --package-id <uuid> [--root <dir>] [--json]
  tiangong-release runs list [--root <dir>] [--limit <n>] [--json]
  tiangong-release candidate --run-dir <dir> [--json]
  tiangong-release init --input <file> --out-dir <dir> [--json]
  tiangong-release plan --run-dir <dir> [--json]
  tiangong-release status --run-dir <dir> [--json]
  tiangong-release next --run-dir <dir> [--json]
  tiangong-release run-stage --run-dir <dir> --stage <id> [--json]
  tiangong-release decision apply --run-dir <dir> --input <file> [--json]
  tiangong-release validate --run-dir <dir> [--json]
  tiangong-release package --run-dir <dir> [--json]
  tiangong-release publish --run-dir <dir> --approve-plan <sha256> [--json]
  tiangong-release verify --run-dir <dir> [--json]

Security:
  Remote stages inherit the protected TIANGONG_LCA_API_* environment and invoke
  tiangong-lca. This executable checks only API-key presence and never decodes,
  prints, places in arguments, or persists the credential value.
`;

function jsonOutput(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function humanStatus(value: ReturnType<typeof releaseRunSummary>): string {
  return [
    `Release ${value.releaseRunId}`,
    "",
    "Summary:",
    `- status: ${value.status}`,
    `- passed: ${value.counts.passed}; blocked: ${value.counts.blocked}; failed: ${value.counts.failed}; remaining: ${value.counts.pending}`,
    `- complete: ${value.complete}; partial: ${value.partial}; ambiguous: ${value.ambiguous}`,
    "",
    "Next:",
    ...(value.nextCommands.length
      ? value.nextCommands.map((command) => `- ${command}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function humanOperatorResult(input: {
  title: string;
  status: string;
  nextCommands: string[];
  artifactPaths?: string[];
}): string {
  return [
    input.title,
    "",
    `Status: ${input.status}`,
    ...(input.artifactPaths?.length
      ? ["", "Artifacts:", ...input.artifactPaths.map((item) => `- ${item}`)]
      : []),
    "",
    "Next:",
    ...(input.nextCommands.length
      ? input.nextCommands.map((item) => `- ${item}`)
      : ["- none"]),
    "",
  ].join("\n");
}

function required(value: string | undefined, option: string): string {
  if (!value?.trim()) {
    throw new Error(`option_required:${option}`);
  }
  return value.trim();
}

type ParsedOptionValue = string | boolean | Array<string | boolean> | undefined;

function parseCommandOptions(
  args: string[],
  names: string[],
): Record<string, ParsedOptionValue> {
  const options = Object.fromEntries([
    ...names.map((name) => [name, { type: "string" as const }]),
    ["json", { type: "boolean" as const, default: false }],
    ["help", { type: "boolean" as const, default: false }],
  ]);
  return parseArgs({ args, options, strict: true, allowPositionals: false })
    .values as Record<string, ParsedOptionValue>;
}

function specPath(name: string): string {
  return path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "specs",
    name,
  );
}

function normalizeRequestPaths(
  request: ReleaseRequest,
  inputPath: string,
): ReleaseRequest {
  const base = path.dirname(inputPath);
  const resolved = structuredClone(request);
  resolved.calculationBundle.manifestPath = path.resolve(
    base,
    resolved.calculationBundle.manifestPath,
  );
  resolved.sourceClosure.directory = path.resolve(
    base,
    resolved.sourceClosure.directory,
  );
  if (resolved.previousReleaseManifestPath) {
    resolved.previousReleaseManifestPath = path.resolve(
      base,
      resolved.previousReleaseManifestPath,
    );
  }
  if (resolved.releaseProfilePath) {
    resolved.releaseProfilePath = path.resolve(
      base,
      resolved.releaseProfilePath,
    );
  }
  return resolved;
}

async function runDoctorCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["target"]);
  if (values.help) return { exitCode: 0, stdout: mainHelp, stderr: "" };
  const targetId = required(values.target as string | undefined, "--target");
  const report = await releaseDoctor({ targetId });
  return {
    exitCode: report.status === "ready" ? 0 : 2,
    stdout: values.json
      ? jsonOutput(report)
      : humanOperatorResult({
          title: `Release doctor (${targetId})`,
          status: report.status,
          nextCommands: report.nextCommands,
        }),
    stderr: "",
  };
}

async function runBootstrapCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, [
    "target",
    "package-id",
    "root",
    "previous-release-manifest",
  ]);
  if (values.help) return { exitCode: 0, stdout: mainHelp, stderr: "" };
  const targetId = required(values.target as string | undefined, "--target");
  const packageId = required(
    values["package-id"] as string | undefined,
    "--package-id",
  );
  const report = await bootstrapReleaseRun({
    packageId,
    targetId,
    ...(values.root ? { releaseRoot: String(values.root) } : {}),
    ...(values["previous-release-manifest"]
      ? {
          previousReleaseManifestPath: String(
            values["previous-release-manifest"],
          ),
        }
      : {}),
  });
  return {
    exitCode: 0,
    stdout: values.json
      ? jsonOutput(report)
      : humanOperatorResult({
          title: `Release run ${report.releaseRunId}`,
          status: report.status,
          artifactPaths: report.artifactPaths,
          nextCommands: report.nextCommands,
        }),
    stderr: "",
  };
}

function runRunsListCommand(args: string[]): CliResult {
  const values = parseCommandOptions(args, ["root", "limit"]);
  if (values.help) return { exitCode: 0, stdout: mainHelp, stderr: "" };
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const report = listReleaseRuns({
    ...(values.root ? { releaseRoot: String(values.root) } : {}),
    ...(limit === undefined ? {} : { limit }),
  });
  return {
    exitCode: 0,
    stdout: values.json
      ? jsonOutput(report)
      : humanOperatorResult({
          title: `Release runs (${report.returned}/${report.total})`,
          status: report.status,
          artifactPaths: report.artifactPaths,
          nextCommands: report.nextCommands,
        }),
    stderr: "",
  };
}

async function runCandidateCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir"]);
  if (values.help) return { exitCode: 0, stdout: mainHelp, stderr: "" };
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const candidate = await buildReleaseCandidateReport({ runDirectory });
  const body = {
    ...candidate.report,
    reportPath: candidate.reportPath,
    reportSha256: candidate.reportSha256,
  };
  return {
    exitCode: 0,
    stdout: values.json
      ? jsonOutput(body)
      : humanOperatorResult({
          title: `Release candidate ${candidate.report.releaseRunId}`,
          status: candidate.report.releaseStatus,
          artifactPaths: [
            candidate.reportPath,
            ...candidate.report.artifactPaths,
          ],
          nextCommands: candidate.report.nextCommands,
        }),
    stderr: "",
  };
}

async function runInit(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["input", "out-dir"]);
  if (values.help) {
    return { exitCode: 0, stdout: mainHelp, stderr: "" };
  }
  const inputPath = path.resolve(
    required(values.input as string | undefined, "--input"),
  );
  const outDirectory = path.resolve(
    required(values["out-dir"] as string | undefined, "--out-dir"),
  );
  const request = normalizeRequestPaths(
    assertReleaseRequest(JSON.parse(readFileSync(inputPath, "utf8"))),
    inputPath,
  );
  const profileLock = readJsonFile<JsonValue>(
    specPath("release-profiles.json"),
  );
  const run = initializeReleaseWorkspace({
    request,
    outDirectory,
    profileLock,
  });
  const summary = releaseRunSummary(outDirectory);
  const body = {
    runDirectory: outDirectory,
    requestHash: run.requestHash,
    profileLockHash: run.profileLockHash,
    ...summary,
  };
  return {
    exitCode: 0,
    stdout: values.json ? jsonOutput(body) : humanStatus(summary),
    stderr: "",
  };
}

async function runPlanCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const plan = releasePlan(runDirectory);
  const reportPath = path.join(
    releaseWorkspaceLayout(runDirectory).reports,
    "release-plan.json",
  );
  writeJsonAtomic(reportPath, plan as unknown as JsonValue);
  const reportSha256 = await sha256File(reportPath);
  const body = { ...plan, reportPath, reportSha256 };
  const summary = releaseRunSummary(runDirectory);
  return {
    exitCode: 0,
    stdout: values.json ? jsonOutput(body) : humanStatus(summary),
    stderr: "",
  };
}

function runStatusCommand(args: string[], nextOnly = false): CliResult {
  const values = parseCommandOptions(args, ["run-dir"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const summary = releaseRunSummary(runDirectory);
  const body = nextOnly
    ? {
        schemaVersion: "tiangong.release-next.v1",
        releaseRunId: summary.releaseRunId,
        nextStage: summary.nextStage,
        nextCommands: summary.nextCommands,
        blocked: summary.blocked,
        ambiguous: summary.ambiguous,
      }
    : summary;
  return {
    exitCode: 0,
    stdout: values.json ? jsonOutput(body) : humanStatus(summary),
    stderr: "",
  };
}

async function runStageCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir", "stage"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const stageId = required(values.stage as string | undefined, "--stage");
  const stage = await runReleaseStage(runDirectory, stageId);
  const summary = releaseRunSummary(runDirectory);
  return {
    exitCode:
      stage.status === "failed" ? 1 : stage.status === "blocked" ? 2 : 0,
    stdout: values.json
      ? jsonOutput({
          schemaVersion: "tiangong.release-stage-result.v1",
          stage,
          summary,
        })
      : humanStatus(summary),
    stderr: "",
  };
}

async function runDecisionApplyCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir", "input"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const inputPath = path.resolve(
    required(values.input as string | undefined, "--input"),
  );
  const applied = await applyApprovalDecision({
    runDirectory,
    value: readJsonFile<unknown>(inputPath),
  });
  const summary = releaseRunSummary(runDirectory);
  const body = {
    schemaVersion: "tiangong.release.decision-apply.v1",
    releaseRunId: applied.decision.releaseRunId,
    publishPlanHash: applied.decision.publishPlanHash,
    ...(applied.decision.schemaVersion ===
    "tiangong.release.approval-decision.v2"
      ? { targetFingerprint: applied.decision.targetFingerprint }
      : {}),
    decision: applied.decision.decision,
    decisionPath: applied.path,
    decisionSha256: applied.sha256,
    reused: applied.reused,
    nextCommands: summary.nextCommands,
  };
  return {
    exitCode: 0,
    stdout: values.json ? jsonOutput(body) : humanStatus(summary),
    stderr: "",
  };
}

async function runThroughStage(
  runDirectory: string,
  targetStage: StageId,
): Promise<{ blocked: boolean; stageId: StageId | null }> {
  const targetIndex = STAGE_IDS.indexOf(targetStage);
  for (const stageId of STAGE_IDS.slice(1, targetIndex + 1)) {
    const run = readReleaseRun(runDirectory);
    const current = run.stages[STAGE_IDS.indexOf(stageId)]!;
    if (current.status === "passed" || current.status === "skipped") continue;
    const result = await runReleaseStage(runDirectory, stageId);
    if (result.status === "blocked") return { blocked: true, stageId };
  }
  return { blocked: false, stageId: null };
}

function commandResult(
  command: string,
  runDirectory: string,
  json: boolean,
  exitCode = 0,
): CliResult {
  const summary = releaseRunSummary(runDirectory);
  return {
    exitCode,
    stdout: json
      ? jsonOutput({
          schemaVersion: "tiangong.release-command-result.v1",
          command,
          summary,
        })
      : humanStatus(summary),
    stderr: "",
  };
}

async function runThroughCommand(
  command: "validate" | "package",
  args: string[],
): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const target = command === "validate" ? "validate-tidas" : "build-packages";
  const result = await runThroughStage(runDirectory, target);
  return commandResult(
    command,
    runDirectory,
    Boolean(values.json),
    result.blocked ? 2 : 0,
  );
}

async function runPublishCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir", "approve-plan"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const approvedPlanHash = required(
    values["approve-plan"] as string | undefined,
    "--approve-plan",
  );
  const layout = releaseWorkspaceLayout(runDirectory);
  if (!existsSync(layout.publishPlan)) throw new Error("publish_plan_required");
  const plan = readJsonFile<Record<string, unknown>>(layout.publishPlan);
  if (plan.planHash !== approvedPlanHash) {
    throw new Error("approval_plan_hash_mismatch");
  }
  const target = assertRemoteTargetFrontier({
    runDirectory,
    requireApproval: false,
  });
  if (existsSync(layout.approvalDecision)) {
    readApprovalDecision(runDirectory);
  } else {
    await applyApprovalDecision({
      runDirectory,
      value: {
        schemaVersion: "tiangong.release.approval-decision.v2",
        releaseRunId: plan.releaseRunId,
        publishPlanHash: approvedPlanHash,
        targetFingerprint: target.targetFingerprint,
        decision: "approve",
      },
    });
  }
  for (const stageId of ["approval", "publish"] as const) {
    const run = readReleaseRun(runDirectory);
    const current = run.stages[STAGE_IDS.indexOf(stageId)]!;
    if (current.status === "passed") continue;
    const result = await runReleaseStage(runDirectory, stageId);
    if (result.status === "blocked") {
      return commandResult("publish", runDirectory, Boolean(values.json), 2);
    }
  }
  return commandResult("publish", runDirectory, Boolean(values.json));
}

async function runVerifyCommand(args: string[]): Promise<CliResult> {
  const values = parseCommandOptions(args, ["run-dir"]);
  const runDirectory = path.resolve(
    required(values["run-dir"] as string | undefined, "--run-dir"),
  );
  const run = readReleaseRun(runDirectory);
  const stage = run.stages[STAGE_IDS.indexOf("readback-verify")]!;
  if (stage.status !== "passed") {
    const result = await runReleaseStage(runDirectory, "readback-verify");
    if (result.status === "blocked") {
      return commandResult("verify", runDirectory, Boolean(values.json), 2);
    }
  }
  return commandResult("verify", runDirectory, Boolean(values.json));
}

export async function executeReleaseCli(argv: string[]): Promise<CliResult> {
  try {
    const [command, subcommand, ...rest] = argv;
    if (
      !command ||
      command === "help" ||
      command === "--help" ||
      command === "-h"
    ) {
      return { exitCode: 0, stdout: mainHelp, stderr: "" };
    }
    if (command === "init") {
      return await runInit(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "doctor") {
      return await runDoctorCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "bootstrap") {
      return await runBootstrapCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "runs" && subcommand === "list") {
      return runRunsListCommand(rest);
    }
    if (command === "candidate") {
      return await runCandidateCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "plan") {
      return await runPlanCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "status") {
      return runStatusCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "next") {
      return runStatusCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
        true,
      );
    }
    if (command === "run-stage") {
      return await runStageCommand(
        [subcommand, ...rest].filter((item): item is string => Boolean(item)),
      );
    }
    if (command === "decision" && subcommand === "apply") {
      return await runDecisionApplyCommand(rest);
    }
    const commandArgs = [subcommand, ...rest].filter((item): item is string =>
      Boolean(item),
    );
    if (command === "validate" || command === "package") {
      return await runThroughCommand(command, commandArgs);
    }
    if (command === "publish") {
      return await runPublishCommand(commandArgs);
    }
    if (command === "verify") {
      return await runVerifyCommand(commandArgs);
    }
    throw new Error(`unknown_command:${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : message.split(":", 1)[0];
    return {
      exitCode: 1,
      stdout: "",
      stderr: jsonOutput({
        schemaVersion: "tiangong.release-error.v1",
        code,
        message,
        retryable: !message.startsWith("unknown_command"),
      }),
    };
  }
}

if (import.meta.main) {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const result = await executeReleaseCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
