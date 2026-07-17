import type { StageRecord } from "./types.js";

export const STAGE_IDS = [
  "intake",
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
  "approval",
  "publish",
  "readback-verify",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export function initialStageRecord(stageId: StageId): StageRecord {
  return {
    stageId,
    status: "pending",
    attempt: 0,
    inputHashes: {},
    outputHashes: {},
    toolVersions: { release: "0.1.0" },
    startedAt: null,
    completedAt: null,
    cache: { key: null, hit: false },
    artifacts: [],
    warnings: [],
    blockers: [],
    decisions: [],
    summary: "",
    nextCommands: [],
  };
}

export function assertStageId(value: string): StageId {
  if (!STAGE_IDS.includes(value as StageId)) {
    throw new Error(`unknown_stage:${value}`);
  }
  return value as StageId;
}
