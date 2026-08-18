import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeResultSet,
  decodeResultSetList,
  ResultSetContractError,
} from "../contracts/result-set.mjs";

const resultSet = {
  schemaVersion: "lcia.result-set.v1",
  resultSetId: "123e4567-e89b-42d3-a456-426614174000",
  name: "Steel baseline",
  createdAt: "2026-08-18T08:00:00.000Z",
};

test("decodes the exact ResultSet v1 projection", () => {
  assert.deepEqual(decodeResultSet(resultSet), resultSet);
  assert.deepEqual(decodeResultSetList({ items: [resultSet] }), {
    items: [resultSet],
  });
});

test("rejects additive or malformed ResultSet projections", () => {
  assert.throws(
    () => decodeResultSet({ ...resultSet, status: "ready" }),
    ResultSetContractError,
  );
  assert.throws(
    () => decodeResultSet({ ...resultSet, resultSetId: "not-a-uuid" }),
    ResultSetContractError,
  );
});
