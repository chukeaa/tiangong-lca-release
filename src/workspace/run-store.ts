import { existsSync } from "node:fs";
import path from "node:path";
import { canonicalSha256 } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import { normalizeUuid } from "../identity/uuid.js";
import {
  ensureDirectory,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
} from "../io/files.js";
import { initialStageRecord, STAGE_IDS } from "../stages/catalog.js";
import type { ReleaseRunRecord } from "../stages/types.js";
import { releaseWorkspaceLayout } from "./layout.js";

export type ReleaseRequest = {
  schemaVersion: "tiangong.release-request.v1";
  releaseRunId: string;
  name?: string;
  calculationBundle: { manifestPath: string; bundleContentHash: string };
  scope: {
    coverageMode: "subset" | "global_eligible";
    selectionManifestHash: string;
  };
  profiles: {
    modelProfileId: string;
    resultProfileId: string;
    packageProfileIds: string[];
  };
  sourceClosure: { directory: string; manifestHash: string };
  previousReleaseManifestPath?: string | null;
  releaseProfilePath?: string | null;
};

export function assertReleaseRequest(value: unknown): ReleaseRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release_request_invalid");
  }
  const request = value as ReleaseRequest;
  if (request.schemaVersion !== "tiangong.release-request.v1") {
    throw new Error("release_request_schema_unsupported");
  }
  request.releaseRunId = normalizeUuid(request.releaseRunId);
  if (
    !request.calculationBundle?.manifestPath ||
    !/^[0-9a-f]{64}$/.test(request.calculationBundle.bundleContentHash)
  ) {
    throw new Error("release_request_calculation_bundle_invalid");
  }
  if (
    !request.sourceClosure?.directory ||
    !/^[0-9a-f]{64}$/.test(request.sourceClosure.manifestHash)
  ) {
    throw new Error("release_request_source_closure_invalid");
  }
  if (
    request.profiles?.modelProfileId !==
    "resolved-one-hop-aggregated-background.v1"
  ) {
    throw new Error("release_request_model_profile_unsupported");
  }
  if (request.profiles?.resultProfileId !== "lci-lcia-result.v1") {
    throw new Error("release_request_result_profile_unsupported");
  }
  return request;
}

export function initializeReleaseWorkspace(input: {
  request: ReleaseRequest;
  outDirectory: string;
  profileLock: JsonValue;
  now?: Date;
}): ReleaseRunRecord {
  const layout = releaseWorkspaceLayout(input.outDirectory);
  if (existsSync(layout.run)) {
    throw new Error(`release_workspace_exists:${layout.root}`);
  }
  for (const directory of [
    layout.root,
    layout.stages,
    layout.cache,
    layout.reports,
    layout.outputs,
  ]) {
    ensureDirectory(directory);
  }
  const now = (input.now ?? new Date()).toISOString();
  const request = assertReleaseRequest(structuredClone(input.request));
  const requestHash = canonicalSha256(request as unknown as JsonValue);
  const profileLockHash = canonicalSha256(input.profileLock);
  const stages = STAGE_IDS.map(initialStageRecord);
  stages[0] = {
    ...stages[0]!,
    status: "passed",
    attempt: 1,
    inputHashes: { request: requestHash, profileLock: profileLockHash },
    outputHashes: { request: requestHash, profileLock: profileLockHash },
    startedAt: now,
    completedAt: now,
    summary: "Release request and profile lock were validated and frozen.",
    nextCommands: [
      `tiangong-release run-stage --run-dir ${layout.root} --stage resolve-calculation-bundle`,
    ],
  };
  const run: ReleaseRunRecord = {
    schemaVersion: "tiangong.release-run.v1",
    releaseRunId: request.releaseRunId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    requestHash,
    profileLockHash,
    stages,
  };
  writeJsonAtomic(layout.request, request as unknown as JsonValue);
  writeJsonAtomic(layout.profileLock, input.profileLock);
  writeTextAtomic(layout.artifactIndex, "");
  writeTextAtomic(layout.decisionLog, "");
  writeJsonAtomic(layout.run, run as unknown as JsonValue);
  return run;
}

export function readReleaseRun(runDirectory: string): ReleaseRunRecord {
  const layout = releaseWorkspaceLayout(runDirectory);
  const run = readJsonFile<ReleaseRunRecord>(layout.run);
  if (
    run.schemaVersion !== "tiangong.release-run.v1" ||
    run.stages.length !== STAGE_IDS.length
  ) {
    throw new Error("release_run_invalid");
  }
  return run;
}

export function writeReleaseRun(
  runDirectory: string,
  run: ReleaseRunRecord,
): void {
  run.updatedAt = new Date().toISOString();
  writeJsonAtomic(
    releaseWorkspaceLayout(runDirectory).run,
    run as unknown as JsonValue,
  );
}

export function resolveRequestPath(
  requestFile: string,
  referencedPath: string,
): string {
  return path.resolve(path.dirname(path.resolve(requestFile)), referencedPath);
}
