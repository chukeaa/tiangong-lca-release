import assert from "node:assert/strict";
import test from "node:test";

import {
  projectResultSetReference,
  projectResultSetReferenceList,
  ResultSetContractError,
} from "../contracts/result-set.mjs";

const externalResultSet = {
  schemaVersion: "lcia.result-set.v1",
  resultSetId: "123e4567-e89b-42d3-a456-426614174000",
  name: "Steel baseline",
  createdAt: "2026-08-18T08:00:00.000Z",
};

const reference = {
  id: externalResultSet.resultSetId,
  name: externalResultSet.name,
  createdAt: externalResultSet.createdAt,
  source: {
    system: "tiangong-lca",
    externalSchemaVersion: externalResultSet.schemaVersion,
  },
};

test("projects provider payloads into the Release-owned ResultSet reference", () => {
  assert.deepEqual(projectResultSetReference(externalResultSet), reference);
  assert.deepEqual(
    projectResultSetReferenceList({ items: [externalResultSet] }),
    { items: [reference] },
  );
});

test("accepts additive fields and provider version changes", () => {
  assert.deepEqual(
    projectResultSetReference({
      ...externalResultSet,
      schemaVersion: "provider.result-set.v27",
      status: "ready",
      nestedProjection: { future: true },
    }),
    {
      ...reference,
      source: {
        system: "tiangong-lca",
        externalSchemaVersion: "provider.result-set.v27",
      },
    },
  );
});

test("accepts compatible aliases and a bare list without changing the internal model", () => {
  const aliased = {
    id: externalResultSet.resultSetId,
    displayName: externalResultSet.name,
    created_at: externalResultSet.createdAt,
    schema_version: "provider.result-set.v2",
  };
  assert.deepEqual(projectResultSetReferenceList([aliased]), {
    items: [
      {
        ...reference,
        source: {
          system: "tiangong-lca",
          externalSchemaVersion: "provider.result-set.v2",
        },
      },
    ],
  });
});

test("keeps optional provider metadata nullable", () => {
  assert.deepEqual(
    projectResultSetReference({
      id: externalResultSet.resultSetId,
      name: externalResultSet.name,
    }),
    {
      id: externalResultSet.resultSetId,
      name: externalResultSet.name,
      createdAt: null,
      source: { system: "tiangong-lca", externalSchemaVersion: null },
    },
  );
});

test("rejects payloads that lack required identity semantics", () => {
  assert.throws(
    () =>
      projectResultSetReference({
        ...externalResultSet,
        resultSetId: "not-a-uuid",
      }),
    ResultSetContractError,
  );
  assert.throws(
    () => projectResultSetReference({ id: externalResultSet.resultSetId }),
    ResultSetContractError,
  );
});
