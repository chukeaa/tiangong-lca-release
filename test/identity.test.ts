import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalize } from "../src/canonical/jcs.js";
import {
  generatedModelUuid,
  generatedResultProcessUuid,
  processIdentityDocument,
  resultIdentityDocument,
} from "../src/identity/identity.js";
import {
  NS_TG_LIFECYCLE_MODEL_V1,
  NS_TG_RELEASE_ROOT_V1,
  NS_TG_RESULT_PROCESS_V1,
  UUID_NAMESPACE_URL,
  uuidV5,
} from "../src/identity/uuid.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/identity-vectors.json", import.meta.url),
    "utf8",
  ),
) as any;

test("namespace constants retain their deterministic derivation", () => {
  assert.equal(
    uuidV5(
      UUID_NAMESPACE_URL,
      "https://lca.tiangong.earth/identity/tidas-release/v1",
    ),
    NS_TG_RELEASE_ROOT_V1,
  );
  assert.equal(
    uuidV5(NS_TG_RELEASE_ROOT_V1, "lifecycle-model/v1"),
    NS_TG_LIFECYCLE_MODEL_V1,
  );
  assert.equal(
    uuidV5(NS_TG_RELEASE_ROOT_V1, "result-process/v1"),
    NS_TG_RESULT_PROCESS_V1,
  );
});

test("primary Model and Result vectors are stable", () => {
  const processIdentity = processIdentityDocument(
    vectors.primary.processIdentity,
  );
  assert.equal(
    canonicalize(processIdentity),
    vectors.primary.processCanonicalJson,
  );
  assert.equal(generatedModelUuid(processIdentity), vectors.primary.modelUuid);

  const resultIdentity = resultIdentityDocument(vectors.primary.resultIdentity);
  assert.equal(
    canonicalize(resultIdentity),
    vectors.primary.resultCanonicalJson,
  );
  assert.equal(
    generatedResultProcessUuid(resultIdentity),
    vectors.primary.resultUuid,
  );
});

test("identity input normalization is order, case, and NFC stable", () => {
  const document = processIdentityDocument({
    modelProfileId: "resolved-one-hop-aggregated-background.v1",
    referenceFlowUuid: "22222222-2222-4222-8222-222222222222".toUpperCase(),
    rootProcessUuid: "11111111-1111-4111-8111-111111111111".toUpperCase(),
  });
  assert.equal(generatedModelUuid(document), vectors.primary.modelUuid);
  assert.equal(
    canonicalize({ label: vectors.unicode.decomposed }),
    canonicalize({ label: vectors.unicode.nfc }),
  );
});

test("profile changes create isolated lineages", () => {
  const changedModel = processIdentityDocument({
    ...vectors.primary.processIdentity,
    modelProfileId: "resolved-one-hop-aggregated-background.v2",
  });
  assert.equal(
    generatedModelUuid(changedModel),
    vectors.profileChanges.modelProfileV2Uuid,
  );
  const changedResult = resultIdentityDocument({
    lifecycleModelUuid: vectors.primary.modelUuid,
    resultProfileId: "lci-lcia-result.method-family-v2",
  });
  assert.equal(
    generatedResultProcessUuid(changedResult),
    vectors.profileChanges.resultMethodFamilyV2Uuid,
  );
});

test("canonical JSON rejects non-finite values, lone surrogates, and NFC key collisions", () => {
  assert.throws(() => canonicalize({ value: Number.NaN }), /non-finite/u);
  assert.throws(() => canonicalize({ value: "\ud800" }), /surrogates/u);
  assert.throws(() => canonicalize({ Café: 1, Café: 2 }), /collide/u);
});
