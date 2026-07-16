import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanonicalIdentityCollisionFree,
  formatDatasetVersion,
  parseDatasetVersion,
  resolvePublicDatasetVersion,
} from "../src/versioning/dataset-version.js";

const previous = {
  uuid: "11111111-1111-4111-8111-111111111111",
  version: "01.02.003",
  versionSignificantHash: "version-a",
  semanticHash: "semantic-a",
  canonicalContentHash: "content-a",
};

test("parses and formats bounded ILCD dataset versions", () => {
  assert.deepEqual(parseDatasetVersion("01.02.003"), {
    major: 1,
    minor: 2,
    revision: 3,
  });
  assert.equal(
    formatDatasetVersion({ major: 1, minor: 2, revision: 3 }),
    "01.02.003",
  );
  assert.throws(() => parseDatasetVersion("1.2.3"), /Invalid/u);
  assert.throws(
    () => formatDatasetVersion({ major: 100, minor: 0, revision: 0 }),
    /outside/u,
  );
});

test("resolves initial, replay, metadata-minor, semantic-major, and new-lineage versions", () => {
  assert.deepEqual(
    resolvePublicDatasetVersion({
      uuid: previous.uuid,
      versionSignificantHash: "version-a",
      semanticHash: "semantic-a",
    }),
    { version: "01.00.000", change: "initial" },
  );
  assert.deepEqual(
    resolvePublicDatasetVersion(
      {
        uuid: previous.uuid,
        versionSignificantHash: "version-a",
        semanticHash: "semantic-a",
      },
      previous,
    ),
    { version: "01.02.003", change: "reuse" },
  );
  assert.deepEqual(
    resolvePublicDatasetVersion(
      {
        uuid: previous.uuid,
        versionSignificantHash: "version-b",
        semanticHash: "semantic-a",
      },
      previous,
    ),
    { version: "01.03.000", change: "minor" },
  );
  assert.deepEqual(
    resolvePublicDatasetVersion(
      {
        uuid: previous.uuid,
        versionSignificantHash: "version-b",
        semanticHash: "semantic-b",
      },
      previous,
    ),
    { version: "02.00.000", change: "major" },
  );
  assert.deepEqual(
    resolvePublicDatasetVersion(
      {
        uuid: "22222222-2222-4222-8222-222222222222",
        versionSignificantHash: "version-b",
        semanticHash: "semantic-b",
      },
      previous,
    ),
    { version: "01.00.000", change: "initial" },
  );
});

test("rejects conflicting canonical content for the same dataset key", () => {
  assert.doesNotThrow(() =>
    assertCanonicalIdentityCollisionFree({
      datasetType: "process",
      uuid: previous.uuid,
      version: previous.version,
      canonicalContentHash: "content-a",
      registeredCanonicalContentHash: "content-a",
    }),
  );
  assert.throws(
    () =>
      assertCanonicalIdentityCollisionFree({
        datasetType: "process",
        uuid: previous.uuid,
        version: previous.version,
        canonicalContentHash: "content-b",
        registeredCanonicalContentHash: "content-a",
      }),
    /dataset_identity_content_conflict/u,
  );
});
