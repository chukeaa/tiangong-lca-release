import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createResultSetContextStore } from "../runtime/result-set-context.mjs";

test("writes a minimal recovery reference without credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-result-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createResultSetContextStore({
    root,
    now: () => new Date("2026-08-18T08:30:00.000Z"),
  });
  const resultSet = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    name: "Steel baseline",
    createdAt: "2026-08-18T08:00:00.000Z",
    source: {
      system: "tiangong-lca",
      externalSchemaVersion: "provider.result-set.v2",
    },
  };

  const outputPath = await store.save(resultSet, {
    commandUrl:
      "https://example.supabase.co/functions/v1/app_data_product_commands",
    publishableKey: "sb_publishable_example",
    accessToken: "must-not-be-read",
  });
  const text = await readFile(outputPath, "utf8");
  const document = JSON.parse(text);
  assert.equal(
    document.schemaVersion,
    "tiangong.calculation-result-set-reference.v1",
  );
  assert.deepEqual(document.resultSet, resultSet);
  assert.equal(text.includes("lcia.result-set.v1"), false);
  assert.match(document.targetFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(text.includes("must-not-be-read"), false);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
});
