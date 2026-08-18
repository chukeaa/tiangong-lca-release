import assert from "node:assert/strict";
import test from "node:test";

import { recommendResultSetName } from "../contracts/result-set-name.mjs";

test("recommends a compact Asia/Shanghai ResultSet name", () => {
  assert.equal(
    recommendResultSetName(new Date("2026-08-18T08:34:00.000Z")),
    "ResultSet-20260818-1634",
  );
});
