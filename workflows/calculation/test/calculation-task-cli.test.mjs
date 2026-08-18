import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../cli.mjs";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const jobId = "223e4567-e89b-42d3-a456-426614174000";
const env = {
  TIANGONG_LCA_DATA_PRODUCT_COMMAND_URL: "https://example.invalid/commands",
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  TIANGONG_LCA_ACCESS_TOKEN: "header.payload.signature",
};
function buffer() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += chunk;
      },
    },
    value: () => value,
  };
}

test("worker logs delegates exact job lookup to workspace_ops", async () => {
  const stdout = buffer();
  assert.equal(
    await runCli(
      [
        "worker",
        "logs",
        "--job-id",
        jobId,
        "--environment",
        "production",
        "--format",
        "json",
      ],
      { stdout: stdout.stream },
    ),
    0,
  );
  const result = JSON.parse(stdout.value());
  assert.equal(result.completeness.status, "delegated");
  assert.match(
    result.data.instruction,
    /python -m workspace_ops\.cli worker job/,
  );
  assert.match(result.data.instruction, new RegExp(jobId));
  assert.match(result.data.instruction, /--all-configs/);
});

test("closure submission requires confirmation before configuration or network", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    [
      "closure",
      "start",
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-token",
      "closure-1",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(code, 3);
  assert.equal(calls, 0);
});

test("closure submission projects identities and returns workspace_ops log command", async () => {
  const stdout = buffer();
  const code = await runCli(
    [
      "closure",
      "start",
      "--result-set-id",
      uuid,
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-token",
      "closure-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), {
          action: "create_closure_check",
          resultSetId: uuid,
          requestedScope: {
            coverageMode: "global_eligible",
            lciaMethods: [{ id: uuid, version: "01.00.000" }],
          },
          requestIdempotencyToken: "closure-1",
        });
        return Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            workerJob: { id: jobId, status: "queued", providerExtra: true },
            schemaVersion: "provider.changed.v9",
          },
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.deepEqual(result.data, {
    kind: "closure",
    jobId,
    resourceId: uuid,
    status: "queued",
    reused: false,
  });
  assert.match(result.nextActions[0], /workspace_ops/);
});

test("calculation submission binds the selected closure evidence", async () => {
  const stdout = buffer();
  const code = await runCli(
    [
      "calculation",
      "start",
      "--name",
      "Steel",
      "--closure-check-id",
      uuid,
      "--requested-scope-hash",
      "scope-hash",
      "--policy-fingerprint",
      "policy-hash",
      "--coverage-mode",
      "global_eligible",
      "--method",
      `${uuid}@01.00.000`,
      "--idempotency-key",
      "build-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.action, "create_build");
        assert.equal(body.closureCheckId, uuid);
        return Response.json({
          ok: true,
          data: { buildId: uuid, workerJob: { jobId, status: "queued" } },
        });
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.value()).data.kind, "calculation");
});
