import type { JsonValue } from "../contracts/json.js";

export type GeneratedDatasetRole = "lifecycle_model" | "result_process";

export type GeneratedDatasetDraft = {
  schemaVersion: "tiangong.release.generated-dataset-draft.v1";
  datasetType: "lifecyclemodel" | "process";
  role: GeneratedDatasetRole;
  processIndex: number;
  uuid: string;
  sourceProcess: { id: string; version: string };
  document: JsonValue;
};

export type DerivedIdentityRecord = {
  schemaVersion: "tiangong.release.derived-identity.v1";
  processIndex: number;
  rootProcess: { id: string; version: string };
  modelUuid: string;
  resultProcessUuid: string;
};
