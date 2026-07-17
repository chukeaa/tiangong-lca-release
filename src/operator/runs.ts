import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { readJsonFile } from "../io/files.js";
import { targetPlanReference } from "../target/profile.js";
import { readReleaseRun, type ReleaseRequest } from "../workspace/run-store.js";

export type ReleaseRunsReport = {
  schemaVersion: "tiangong.release-runs-report.v1";
  status: "completed";
  complete: boolean;
  truncated: boolean;
  releaseRoot: string;
  total: number;
  returned: number;
  runs: Array<{
    releaseRunId: string;
    runDirectory: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    target: { targetId: string; targetFingerprint: string } | null;
  }>;
  warnings: Array<{ code: string; message: string; subject?: string }>;
  artifactPaths: string[];
  nextCommands: string[];
};

export function listReleaseRuns(input: {
  releaseRoot?: string;
  limit?: number;
}): ReleaseRunsReport {
  const requestedReleaseRoot = path.resolve(input.releaseRoot ?? ".release");
  const releaseRoot = existsSync(requestedReleaseRoot)
    ? realpathSync(requestedReleaseRoot)
    : requestedReleaseRoot;
  const workspaces = path.join(releaseRoot, "workspaces");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("runs_limit_invalid");
  }
  const warnings: ReleaseRunsReport["warnings"] = [];
  const runs: ReleaseRunsReport["runs"] = [];
  if (existsSync(workspaces)) {
    for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runDirectory = path.join(workspaces, entry.name);
      if (!existsSync(path.join(runDirectory, "run.json"))) continue;
      try {
        const run = readReleaseRun(runDirectory);
        const request = readJsonFile<ReleaseRequest>(
          path.join(runDirectory, "release-request.json"),
        );
        runs.push({
          releaseRunId: run.releaseRunId,
          runDirectory,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          target: request.target ? targetPlanReference(request.target) : null,
        });
      } catch {
        warnings.push({
          code: "release_run_unreadable",
          message: "Run directory was skipped because its contract is invalid.",
          subject: runDirectory,
        });
      }
    }
  }
  runs.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.releaseRunId.localeCompare(right.releaseRunId),
  );
  const total = runs.length;
  const selected = runs.slice(0, limit);
  const truncated = selected.length < total;
  return {
    schemaVersion: "tiangong.release-runs-report.v1",
    status: "completed",
    complete: !truncated,
    truncated,
    releaseRoot,
    total,
    returned: selected.length,
    runs: selected,
    warnings,
    artifactPaths: selected.map((run) => run.runDirectory),
    nextCommands: selected.map(
      (run) =>
        `tiangong-release candidate --run-dir ${run.runDirectory} --json`,
    ),
  };
}
