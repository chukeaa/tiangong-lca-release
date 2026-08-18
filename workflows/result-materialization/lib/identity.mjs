import { v5 as uuidv5 } from "uuid";
import { canonicalJson } from "./common.mjs";

export const MODEL_NAMESPACE = "1f09df9a-9a14-5247-a355-90ce73b521dd";
export const RESULT_NAMESPACE = "6d130f3d-ca65-5a6f-a842-4b2f9c2f5461";
export const MODEL_PROFILE = "resolved-one-hop-aggregated-background.v1";
export const RESULT_PROFILE = "lci-lcia-result.v2";

export function modelIdentity(rootProcessUuid, referenceFlowUuid) {
  const document = {
    schema: "tiangong-release-process-identity.v1",
    rootProcessUuid: rootProcessUuid.toLowerCase(),
    referenceFlowUuid: referenceFlowUuid.toLowerCase(),
    modelProfileId: MODEL_PROFILE,
  };
  return {
    document,
    uuid: uuidv5(canonicalJson(document).trimEnd(), MODEL_NAMESPACE),
  };
}

export function resultIdentity(rootProcessUuid, referenceFlowUuid) {
  const document = {
    schema: "tiangong-result-process-identity.v2",
    rootProcessUuid: rootProcessUuid.toLowerCase(),
    referenceFlowUuid: referenceFlowUuid.toLowerCase(),
    resultProfileId: RESULT_PROFILE,
  };
  return {
    document,
    uuid: uuidv5(canonicalJson(document).trimEnd(), RESULT_NAMESPACE),
  };
}
