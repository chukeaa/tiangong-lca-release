import { canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import {
  normalizeUuid,
  NS_TG_LIFECYCLE_MODEL_V1,
  NS_TG_RESULT_PROCESS_V1,
  uuidV5,
} from "./uuid.js";

export const MODEL_PROFILE_ID = "resolved-one-hop-aggregated-background.v1";
export const RESULT_PROFILE_ID = "lci-lcia-result.v1";

export type ProcessIdentityDocument = {
  schema: "tiangong-release-process-identity.v1";
  rootProcessUuid: string;
  referenceFlowUuid: string;
  modelProfileId: string;
};

export type ResultIdentityDocument = {
  schema: "tiangong-result-process-identity.v1";
  lifecycleModelUuid: string;
  resultProfileId: string;
};

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!normalized) {
    throw new TypeError(`${field} must not be empty.`);
  }
  return normalized;
}

export function processIdentityDocument(input: {
  rootProcessUuid: string;
  referenceFlowUuid: string;
  modelProfileId?: string;
}): ProcessIdentityDocument {
  return {
    schema: "tiangong-release-process-identity.v1",
    rootProcessUuid: normalizeUuid(input.rootProcessUuid),
    referenceFlowUuid: normalizeUuid(input.referenceFlowUuid),
    modelProfileId: requireNonEmpty(
      input.modelProfileId ?? MODEL_PROFILE_ID,
      "modelProfileId",
    ),
  };
}

export function generatedModelUuid(document: ProcessIdentityDocument): string {
  return uuidV5(
    NS_TG_LIFECYCLE_MODEL_V1,
    canonicalize(document as unknown as JsonValue),
  );
}

export function resultIdentityDocument(input: {
  lifecycleModelUuid: string;
  resultProfileId?: string;
}): ResultIdentityDocument {
  return {
    schema: "tiangong-result-process-identity.v1",
    lifecycleModelUuid: normalizeUuid(input.lifecycleModelUuid),
    resultProfileId: requireNonEmpty(
      input.resultProfileId ?? RESULT_PROFILE_ID,
      "resultProfileId",
    ),
  };
}

export function generatedResultProcessUuid(
  document: ResultIdentityDocument,
): string {
  return uuidV5(
    NS_TG_RESULT_PROCESS_V1,
    canonicalize(document as unknown as JsonValue),
  );
}
