export type StageStatus =
  "pending" | "running" | "passed" | "blocked" | "failed" | "skipped";

export type StageCache = {
  key: string | null;
  hit: boolean;
};

export type StageArtifact = {
  path: string;
  sha256: string;
  mediaType: string;
};

export type StageIssue = {
  code: string;
  message: string;
  subject?: string;
};

export type StageRecord = {
  stageId: string;
  status: StageStatus;
  attempt: number;
  inputHashes: Record<string, string>;
  outputHashes: Record<string, string>;
  toolVersions: Record<string, string>;
  startedAt: string | null;
  completedAt: string | null;
  cache: StageCache;
  artifacts: StageArtifact[];
  warnings: StageIssue[];
  blockers: StageIssue[];
  decisions: string[];
  summary: string;
  nextCommands: string[];
};

export type ReleaseRunRecord = {
  schemaVersion: "tiangong.release-run.v1";
  releaseRunId: string;
  status:
    | "active"
    | "blocked"
    | "failed"
    | "ready_for_approval"
    | "approved"
    | "published"
    | "verified";
  createdAt: string;
  updatedAt: string;
  requestHash: string;
  profileLockHash: string;
  stages: StageRecord[];
};
