#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (process.env.TIANGONG_LCA_API_KEY) {
  process.stderr.write("protected release credential reached local tool\n");
  process.exit(10);
}
if (args[0] === "--version") {
  process.stdout.write("tidas 0.1.0-fixture\n");
  process.exit(0);
}

const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const action = args[0] === "release" ? args[1] : undefined;

const operation = (release, overrides = {}) => ({
  schema_version: "tidas.operation-report.v1",
  command: "release",
  status: "succeeded",
  exit_class: "success",
  completeness: "complete",
  invocation: {
    schema_version: "tidas.invocation-context.v1",
    config_source: "none",
    config_path: null,
    log_level: "warn",
    progress_mode: "never",
    progress_enabled: false,
    memory_budget_bytes: 536870912,
    queue_capacity: 256,
    input_policy: "explicit-path-or-dash",
    report_destination: "stdout",
    diagnostic_destination: "stderr",
  },
  summary: { release },
  diagnostics: [],
  artifacts: [],
  next_actions: [],
  ...overrides,
});

const executableName = path.basename(process.argv[1]);
const forcedFailures = new Map([
  ["tidas-exit-data-issues", [2, "completed-with-issues", "data-issues"]],
  ["tidas-exit-usage", [64, "failed", "usage"]],
  ["tidas-exit-unavailable", [69, "failed", "unavailable"]],
  ["tidas-exit-internal", [70, "failed", "internal"]],
  ["tidas-exit-io", [74, "failed", "io"]],
  ["tidas-exit-cancelled", [130, "cancelled", "cancelled"]],
]);
const forcedFailure = forcedFailures.get(executableName);
if (
  (executableName.includes("fail") || forcedFailure) &&
  action !== undefined
) {
  const [exitCode, status, exitClass] = forcedFailure ?? [74, "failed", "io"];
  process.stdout.write(
    `${JSON.stringify(
      operation(undefined, {
        status,
        exit_class: exitClass,
        completeness: "not-started",
        summary: {},
        diagnostics: [
          {
            schema_version: "tidas.diagnostic.v1",
            code: forcedFailure
              ? `release_${exitClass.replace("-", "_")}`
              : "release_io_failed",
            message: "fixture failed before atomic publication",
            path: null,
            details: {},
          },
        ],
      }),
    )}\n`,
  );
  process.exit(exitCode);
}

let release;
if (action === "validate-tidas" || action === "validate-ilcd") {
  release = {
    schema_version: "tidas.release-report.v1",
    action,
    ok: true,
    validation: {
      format: action === "validate-tidas" ? "tidas" : "ilcd",
      summary: { ok: true, issue_count: 0 },
    },
    peak_accounted_memory_bytes: 1024,
  };
} else if (action === "convert-ilcd") {
  mkdirSync(option("--output-dir"), { recursive: true });
  release = {
    schema_version: "tidas.release-report.v1",
    action,
    ok: true,
    conversion: {
      dataset_count: 3,
      input_bytes: 100,
      output_bytes: 200,
      conversion_set_sha256: sha256("conversion"),
      output_tree_sha256: sha256("tree"),
      asset_fingerprint: sha256("assets"),
    },
    peak_accounted_memory_bytes: 2048,
  };
} else if (action === "semantic-roundtrip") {
  release = {
    schema_version: "tidas.release-report.v1",
    action,
    ok: true,
    roundtrip: {
      ok: true,
      dataset_count: 3,
      mismatch_count: 0,
      semantic_set_sha256: sha256("semantic"),
      mismatches: [],
      mismatches_truncated: false,
    },
    peak_accounted_memory_bytes: 2048,
  };
} else if (action === "build-packages") {
  if (args.includes("--ilcd-dir")) {
    process.stderr.write("legacy --ilcd-dir reached unified build-packages\n");
    process.exit(64);
  }
  const outputDirectory = option("--output-dir");
  mkdirSync(outputDirectory, { recursive: true });
  const profiles = [
    "unit-process-full-closure.v1",
    "standalone-lifecyclemodel-result-full-closure.v1",
  ];
  const packages = [];
  for (const profileId of profiles) {
    for (const format of ["tidas", "ilcd"]) {
      const filePath = path.join(outputDirectory, `${profileId}.${format}.zip`);
      const body = Buffer.from(`${profileId}:${format}\n`, "utf8");
      writeFileSync(filePath, body);
      packages.push({
        profile_id: profileId,
        format,
        self_contained: true,
        closure_sha256: sha256(`${profileId}:closure`),
        dataset_count: profileId.startsWith("unit-") ? 2 : 4,
        artifact: {
          path: filePath,
          sha256: sha256(body),
          bytes: statSync(filePath).size,
          media_type: "application/zip",
          member_count: 1,
        },
      });
    }
  }
  release = {
    schema_version: "tidas.release-report.v1",
    action,
    ok: true,
    build: {
      tidas_validation: {
        format: "tidas",
        summary: { ok: true, issue_count: 0 },
      },
      conversion: {
        dataset_count: 3,
        input_bytes: 100,
        output_bytes: 200,
        conversion_set_sha256: sha256("conversion"),
        output_tree_sha256: sha256("tree"),
        asset_fingerprint: sha256("assets"),
      },
      ilcd_validation: {
        format: "ilcd",
        summary: { ok: true, issue_count: 0 },
      },
      roundtrip: {
        ok: true,
        dataset_count: 3,
        mismatch_count: 0,
        semantic_set_sha256: sha256("semantic"),
        mismatches: [],
        mismatches_truncated: false,
      },
      profiles: [],
      packages,
      artifact_set_sha256: sha256(
        packages.map((item) => item.artifact.sha256).join(":"),
      ),
    },
    peak_accounted_memory_bytes: 4096,
  };
} else {
  process.stdout.write(
    `${JSON.stringify(
      operation(undefined, {
        status: "failed",
        exit_class: "usage",
        completeness: "not-started",
        summary: {},
        diagnostics: [
          {
            schema_version: "tidas.diagnostic.v1",
            code: "invalid_release_request",
            message: String(action),
            path: null,
            details: {},
          },
        ],
      }),
    )}\n`,
  );
  process.exit(64);
}

process.stdout.write(`${JSON.stringify(operation(release))}\n`);
