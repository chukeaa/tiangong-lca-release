import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../cli.mjs";
import { DEFAULT_CALCULATION_PROFILE } from "../contracts/default-profile.mjs";

const defaultMethodIdentities = DEFAULT_CALCULATION_PROFILE.lciaMethods.map(
  ({ id, version }) => ({ id, version }),
);

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
  assert.equal(result.replyTemplate.id, "worker-log-delegated");
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
    identityCompleteness: "complete",
    status: "queued",
    reused: false,
    effectiveInput: {
      coverageMode: "global_eligible",
      lciaMethods: [{ id: uuid, version: "01.00.000" }],
      defaultedInputs: [],
    },
  });
  assert.match(result.nextActions[0], /workspace_ops/);
  assert.equal(result.replyTemplate.id, "closure-submitted");
});

test("closure submission uses and discloses the workflow default profile", async () => {
  const stdout = buffer();
  await runCli(
    [
      "closure",
      "start",
      "--result-set-id",
      uuid,
      "--idempotency-token",
      "default-profile-1",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.requestedScope.coverageMode, "global_eligible");
        assert.deepEqual(
          body.requestedScope.lciaMethods,
          defaultMethodIdentities,
        );
        assert.equal(body.requestedScope.lciaMethods.length, 25);
        assert.deepEqual(body.requestedScope.lciaMethods[13], {
          id: "b2ad66ce-c78d-11e6-9d9d-cec0c932ce01",
          version: "03.00.014",
        });
        return Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            workerJob: { id: jobId, status: "queued" },
          },
        });
      },
    },
  );
  assert.deepEqual(
    JSON.parse(stdout.value()).data.effectiveInput.defaultedInputs,
    ["coverageMode", "lciaMethods"],
  );
});

test("closure get returns exact calculation bindings only when evidence is ready", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    ["closure", "get", "--closure-check-id", uuid, "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.deepEqual(JSON.parse(options.body), {
          action: "get_closure_check",
          closureCheckId: uuid,
        });
        return Response.json({
          ok: true,
          data: {
            schemaVersion: "provider.changed.v9",
            closureCheckId: uuid,
            runStatus: "passed",
            scanCompleteness: "complete",
            certificateValidity: "valid",
            requestedScopeHash: "scope-hash",
            effectiveScopeHash: "effective-hash",
            policyFingerprint: "policy-hash",
            dataSnapshotToken: "snapshot-token",
            blockerCodes: [],
            workerJob: {
              jobId,
              status: "completed",
              phase: "finalize_evidence",
              progressFraction: 1,
            },
            createdAt: "2026-08-18T00:00:00Z",
            updatedAt: "2026-08-18T00:01:00Z",
            finishedAt: "2026-08-18T00:01:00Z",
            providerExtra: true,
          },
        });
      },
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.equal(result.command, "closure.get");
  assert.equal(result.data.calculationReady, true);
  assert.deepEqual(result.data.binding, {
    requestedScopeHash: "scope-hash",
    policyFingerprint: "policy-hash",
    effectiveScopeHash: "effective-hash",
  });
  assert.equal(result.completeness.status, "calculation_ready");
  assert.equal(result.completeness.bindingComplete, true);
  assert.equal(result.completeness.scopeIdentityReturned, false);
  assert.match(result.nextActions[0], /calculation start/);
  assert.match(result.nextActions[0], /--requested-scope-hash scope-hash/);
  assert.match(result.nextActions[0], /--policy-fingerprint policy-hash/);
  assert.match(result.nextActions[0], /REUSE_ORIGINAL_COVERAGE_MODE/);
  assert.match(result.nextActions[0], /REUSE_ORIGINAL_METHOD_ID@VERSION/);
  assert.equal(result.replyTemplate.id, "closure-inspected");
  assert.equal("providerExtra" in result.data, false);
});

test("closure get keeps incomplete evidence on the same read-only recovery node", async () => {
  const stdout = buffer();
  await runCli(
    ["closure", "get", "--closure-check-id", uuid, "--format", "json"],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          data: {
            closureCheckId: uuid,
            runStatus: "running",
            scanCompleteness: "pending",
            certificateValidity: "pending",
            workerJob: { jobId, status: "running", progressFraction: 0.5 },
          },
        }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(result.data.calculationReady, false);
  assert.equal(result.data.binding.requestedScopeHash, null);
  assert.equal(result.completeness.status, "not_ready");
  assert.match(result.nextActions[0], /closure get/);
  assert.doesNotMatch(result.nextActions[0], /calculation start/);
});

test("closure get rejects a non-exact identity before network access", async () => {
  const stdout = buffer();
  let calls = 0;
  const code = await runCli(
    ["closure", "get", "--closure-check-id", "latest", "--format", "json"],
    {
      stdout: stdout.stream,
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(code, 2);
  assert.equal(calls, 0);
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
        assert.equal(body.defaultImpactCategory, uuid);
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

test("calculation default profile sends all reviewed methods and a separate display default", async () => {
  const stdout = buffer();
  await runCli(
    [
      "calculation",
      "start",
      "--name",
      "Reviewed catalog",
      "--closure-check-id",
      uuid,
      "--requested-scope-hash",
      "scope-hash",
      "--policy-fingerprint",
      "policy-hash",
      "--idempotency-key",
      "build-default-profile",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.lciaMethodSet.length, 25);
        assert.deepEqual(body.lciaMethodSet, defaultMethodIdentities);
        assert.equal(
          body.defaultImpactCategory,
          DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
        );
        return Response.json({
          ok: true,
          data: { buildId: uuid, workerJob: { jobId, status: "queued" } },
        });
      },
    },
  );
  const effectiveInput = JSON.parse(stdout.value()).data.effectiveInput;
  assert.equal(effectiveInput.lciaMethods.length, 25);
  assert.equal(
    effectiveInput.defaultImpactCategory,
    DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
  );
  assert.deepEqual(effectiveInput.defaultedInputs, [
    "coverageMode",
    "lciaMethods",
    "defaultImpactCategory",
  ]);
});

test("reviewed profile records human-readable method names and indicators", () => {
  assert.equal(DEFAULT_CALCULATION_PROFILE.lciaMethods.length, 25);
  assert.deepEqual(
    DEFAULT_CALCULATION_PROFILE.lciaMethods.find(
      ({ id }) => id === DEFAULT_CALCULATION_PROFILE.defaultImpactCategory,
    ),
    {
      id: "6209b35f-9447-40b5-b68c-a1099e3674a0",
      version: "01.00.000",
      name: "Climate change",
      indicator: "Radiative forcing as Global Warming Potential (GWP100)",
    },
  );
  for (const method of DEFAULT_CALCULATION_PROFILE.lciaMethods) {
    assert.ok(method.name);
    assert.ok(method.indicator);
  }
});

test("calculation submission succeeds with job-only identity before package materialization", async () => {
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
      "--idempotency-key",
      "build-job-only",
      "--confirm-start",
      "--format",
      "json",
    ],
    {
      stdout: stdout.stream,
      env,
      fetchImpl: async () =>
        Response.json({
          ok: true,
          data: { workerJobId: jobId, status: "queued" },
        }),
    },
  );
  const result = JSON.parse(stdout.value());
  assert.equal(code, 0);
  assert.equal(result.data.jobId, jobId);
  assert.equal(result.data.resourceId, null);
  assert.equal(result.data.identityCompleteness, "job_only");
  assert.equal(result.completeness.status, "submitted");
  assert.equal(result.replyTemplate.id, "calculation-submitted");
});
