import assert from "node:assert/strict";
import test from "node:test";

import {
  createResultSetOperations,
  ResultSetOperationError,
} from "../result-set-operations.mjs";

const resultSet = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "Steel baseline",
  createdAt: "2026-08-18T08:00:00.000Z",
  source: {
    system: "tiangong-lca",
    externalSchemaVersion: "provider.result-set.v2",
  },
};

test("preserves the exact remote identity when local recovery persistence fails", async () => {
  const operations = createResultSetOperations({
    api: {
      target: {
        commandUrl: "https://example.invalid",
        publishableKey: "public",
      },
      create: async () => resultSet,
    },
    contextStore: {
      save: async () => {
        throw new Error("disk full");
      },
    },
  });

  await assert.rejects(
    operations.create({ name: resultSet.name, confirmed: true }),
    (error) =>
      error instanceof ResultSetOperationError &&
      error.code === "local_context_write_failed" &&
      error.details.resultSet.id === resultSet.id &&
      !error.details.nextCommand.includes("npm --prefix") &&
      error.details.nextCommand.includes("/workflows/calculation/cli.mjs") &&
      error.details.nextCommand.endsWith(resultSet.id),
  );
});
