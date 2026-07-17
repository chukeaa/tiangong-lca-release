import { existsSync } from "node:fs";
import path from "node:path";
import type { JsonValue } from "../contracts/json.js";
import {
  readJsonFile,
  resolveContainedPath,
  sha256File,
  writeJsonAtomic,
} from "../io/files.js";
import { releaseRunSummary } from "../stages/runner.js";
import { targetPlanReference } from "../target/profile.js";
import { releaseWorkspaceLayout } from "../workspace/layout.js";
import { readReleaseRun, type ReleaseRequest } from "../workspace/run-store.js";

type JsonRecord = Record<string, unknown>;

export type ReleaseCandidateReport = {
  schemaVersion: "tiangong.release-candidate-report.v1";
  status: "completed";
  complete: boolean;
  truncated: boolean;
  releaseRunId: string;
  runDirectory: string;
  releaseStatus: string;
  target: { targetId: string; targetFingerprint: string } | null;
  calculationBundle: {
    manifestPath: string;
    bundleContentHash: string;
  };
  stageCounts: Record<string, number>;
  publishPlan: {
    planHash: string;
    releaseVersion: string;
    path: string;
    sha256: string;
  } | null;
  packages: Array<{
    profileId: string;
    format: string;
    sha256: string;
    byteSize: number;
    path: string;
  }>;
  validation: JsonRecord | null;
  blockers: Array<{ code: string; message: string; subject?: string }>;
  warnings: Array<{ code: string; message: string; subject?: string }>;
  artifactPaths: string[];
  nextCommands: string[];
};

const MAX_FINDINGS = 50;

function findings(
  run: ReturnType<typeof readReleaseRun>,
  field: "blockers" | "warnings",
): Array<{ code: string; message: string; subject?: string }> {
  return run.stages.flatMap((stage) =>
    stage[field].map((item) => ({
      code: item.code,
      message: item.message,
      ...(item.subject ? { subject: item.subject } : {}),
    })),
  );
}

export async function buildReleaseCandidateReport(input: {
  runDirectory: string;
}): Promise<{
  report: ReleaseCandidateReport;
  reportPath: string;
  reportSha256: string;
}> {
  const layout = releaseWorkspaceLayout(input.runDirectory);
  const run = readReleaseRun(layout.root);
  const request = readJsonFile<ReleaseRequest>(layout.request);
  const summary = releaseRunSummary(layout.root);
  const allBlockers = findings(run, "blockers");
  const allWarnings = findings(run, "warnings");
  const truncated =
    allBlockers.length > MAX_FINDINGS || allWarnings.length > MAX_FINDINGS;

  let publishPlan: ReleaseCandidateReport["publishPlan"] = null;
  if (existsSync(layout.publishPlan)) {
    const plan = readJsonFile<JsonRecord>(layout.publishPlan);
    publishPlan = {
      planHash: String(plan.planHash ?? ""),
      releaseVersion: String(plan.releaseVersion ?? ""),
      path: layout.publishPlan,
      sha256: await sha256File(layout.publishPlan),
    };
  }

  let packages: ReleaseCandidateReport["packages"] = [];
  let validation: JsonRecord | null = null;
  if (existsSync(layout.releaseManifest)) {
    const manifest = readJsonFile<JsonRecord>(layout.releaseManifest);
    validation =
      manifest.validation &&
      typeof manifest.validation === "object" &&
      !Array.isArray(manifest.validation)
        ? (manifest.validation as JsonRecord)
        : null;
    if (Array.isArray(manifest.packages)) {
      packages = manifest.packages.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const item = value as JsonRecord;
        if (
          !item.artifact ||
          typeof item.artifact !== "object" ||
          Array.isArray(item.artifact)
        ) {
          return [];
        }
        const artifact = item.artifact as JsonRecord;
        return [
          {
            profileId: String(item.profileId ?? ""),
            format: String(item.format ?? ""),
            sha256: String(artifact.sha256 ?? ""),
            byteSize: Number(artifact.byteSize ?? 0),
            path: resolveContainedPath(
              layout.root,
              String(artifact.path ?? ""),
            ),
          },
        ];
      });
    }
  }

  const artifactPaths = [
    layout.request,
    layout.profileLock,
    ...(existsSync(layout.publishPlan) ? [layout.publishPlan] : []),
    ...(existsSync(layout.releaseManifest) ? [layout.releaseManifest] : []),
    ...packages.map((item) => item.path),
  ];
  const report: ReleaseCandidateReport = {
    schemaVersion: "tiangong.release-candidate-report.v1",
    status: "completed",
    complete: !truncated,
    truncated,
    releaseRunId: run.releaseRunId,
    runDirectory: layout.root,
    releaseStatus: run.status,
    target: request.target ? targetPlanReference(request.target) : null,
    calculationBundle: request.calculationBundle,
    stageCounts: summary.counts,
    publishPlan,
    packages,
    validation,
    blockers: allBlockers.slice(0, MAX_FINDINGS),
    warnings: allWarnings.slice(0, MAX_FINDINGS),
    artifactPaths,
    nextCommands: summary.nextCommands,
  };
  const reportPath = path.join(layout.reports, "release-candidate.json");
  writeJsonAtomic(reportPath, report as unknown as JsonValue);
  return {
    report,
    reportPath,
    reportSha256: await sha256File(reportPath),
  };
}
