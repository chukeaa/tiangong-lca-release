#!/usr/bin/env node
import path from "node:path";
import {
  buildPackageCandidate,
  PACKAGE_PROFILE,
} from "./lib/package-build.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const COMMAND = "package build";
const VALUE_OPTIONS = new Set([
  "materialization",
  "intake",
  "profile",
  "release-version",
  "out-dir",
  "tidas-bin",
]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);

const HELP = `release-package <command> [options]

Commands:
  package build       Build one local, unapproved Release Candidate from a frozen LifecycleModel materialization

package build options:
  --materialization <path>  Completed Result Materialization directory
  --intake <path>           Verified local intake containing source_closure
  --profile <id>            ${PACKAGE_PROFILE}
  --release-version <id>    Formal database release version used in distributed filenames
  --out-dir <path>          New immutable Release Candidate directory
  --tidas-bin <path>        tidas executable; defaults to TIDAS_BIN or PATH lookup

Common:
  --json                    Emit one bounded JSON result on stdout
  --help                    Show this help

The command performs no upload or publication and does not authorize either action. It delegates closure validation,
TIDAS/eILCD validation, semantic round-trip, and deterministic ZIP creation to tidas-tools.

Example:
  release-package package build --materialization .release/materialization/lifecycle-model \\
    --intake .release/materialization/intakes/<bundle-hash> \\
    --profile ${PACKAGE_PROFILE} --release-version 2026.08.0 \
    --out-dir .release/candidates/<candidate-name> --json

JSON results include outcome, completeness, artifact paths, nextActions, and a workflow-local replyTemplate.
`;

async function main() {
  const [command, action, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command !== "package" || action !== "build") {
    throw Object.assign(
      new Error(
        `Unknown command: ${[command, action].filter(Boolean).join(" ")}`,
      ),
      {
        code: "unknown_command",
      },
    );
  }
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  requireOptions(options, [
    "materialization",
    "intake",
    "profile",
    "release-version",
    "out-dir",
  ]);
  if (options.profile !== PACKAGE_PROFILE) {
    throw Object.assign(
      new Error(
        `Unsupported profile: ${options.profile}; expected ${PACKAGE_PROFILE}`,
      ),
      { code: "unsupported_package_profile" },
    );
  }
  const result = await buildPackageCandidate({
    materializationDir: path.resolve(options.materialization),
    intakeDir: path.resolve(options.intake),
    outDir: path.resolve(options["out-dir"]),
    tidasBin: options["tidas-bin"],
    releaseVersion: options["release-version"],
  });
  const candidateManifest = path.join(result.path, "release-candidate.json");
  respond(options, {
    ok: true,
    command: COMMAND,
    outcome: "candidate_built",
    completeness: "full-closure-and-archives-validated",
    profile: result.candidate.profile,
    releaseVersion: result.candidate.releaseVersion,
    candidate: result.path,
    packageCount: result.candidate.packages.length,
    packageSetHash: result.candidate.packageSetHash,
    publicationAuthorized: false,
    artifacts: {
      releaseCandidate: candidateManifest,
      packagePlan: path.join(result.path, "package-plan.json"),
      canonicalDatasetIndex: path.join(
        result.path,
        "canonical-dataset-index.json",
      ),
      tidasReport: path.join(result.path, "tidas-release-report.json"),
      packageVerification: path.join(
        result.path,
        "package-verification-report.json",
      ),
      packagesDirectory: path.join(result.path, "packages"),
    },
    nextActions: [
      {
        kind: "inspect_candidate",
        description:
          "Review the frozen candidate manifest before any separate approval or publication action.",
        command: `jq . ${shellQuote(candidateManifest)}`,
        argv: ["jq", ".", candidateManifest],
      },
    ],
    replyTemplate: replyTemplateFor(COMMAND, { ok: true }),
  });
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw Object.assign(new Error(`Unexpected argument: ${token}`), {
        code: "invalid_arguments",
      });
    const key = token.slice(2);
    if (!VALUE_OPTIONS.has(key) && !BOOLEAN_OPTIONS.has(key))
      throw Object.assign(new Error(`Unknown option: --${key}`), {
        code: "unknown_option",
        details: { option: `--${key}` },
      });
    if (Object.hasOwn(result, key))
      throw Object.assign(new Error(`Duplicate option: --${key}`), {
        code: "duplicate_option",
        details: { option: `--${key}` },
      });
    if (BOOLEAN_OPTIONS.has(key)) result[key] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--"))
        throw Object.assign(new Error(`Missing value for --${key}`), {
          code: "invalid_arguments",
        });
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw Object.assign(
      new Error(
        `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
      ),
      { code: "invalid_arguments" },
    );
}

function respond(options, value) {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`Release Candidate built\n\nSummary:\n`);
    process.stdout.write(`- Candidate: ${value.candidate}\n`);
    process.stdout.write(`- Profile: ${value.profile}\n`);
    process.stdout.write(`- Packages: ${value.packageCount}\n`);
    process.stdout.write(`- Package set SHA-256: ${value.packageSetHash}\n`);
    process.stdout.write(`- Publication authorized: no\n\nNext:\n`);
    process.stdout.write(`- ${value.nextActions[0].command}\n\n`);
    process.stdout.write(`Reply using template:\n`);
    process.stdout.write(`- ${value.replyTemplate.path}\n`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function failureNextActions(error) {
  if (error.code === "tidas_executable_missing")
    return [
      {
        kind: "configure_dependency",
        description: "Configure the tidas executable and rerun the command.",
        command: "export TIDAS_BIN=/absolute/path/to/tidas",
      },
    ];
  if (
    error.code === "materialized_dataset_hash_mismatch" ||
    String(error.code).includes("hash_mismatch")
  )
    return [
      {
        kind: "return_to_materialization",
        description:
          "Inspect the frozen materialization evidence and regenerate it if the source bytes intentionally changed.",
        command:
          "node workflows/result-materialization/cli.mjs materialize --help",
      },
    ];
  return [
    {
      kind: "inspect_usage",
      description: "Inspect supported inputs and retry with corrected options.",
      command: "node workflows/release/cli.mjs package build --help",
    },
  ];
}

main().catch((error) => {
  const command = process.argv.slice(2, 4).join(" ") || COMMAND;
  const payload = {
    ok: false,
    command,
    outcome: "command_failed",
    completeness: "not_completed",
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
    nextActions: failureNextActions(error),
    replyTemplate: replyTemplateFor(command, {
      ok: false,
      errorCode: error.code,
    }),
  };
  if (process.argv.includes("--json"))
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  else {
    process.stderr.write(`Release command failed\n\nSummary:\n`);
    process.stderr.write(`- Command: ${payload.command}\n`);
    process.stderr.write(`- Error: ${payload.error.code}\n`);
    process.stderr.write(`- Reason: ${payload.error.message}\n\nNext:\n`);
    process.stderr.write(`- ${payload.nextActions[0].command}\n\n`);
    process.stderr.write(`Reply using template:\n`);
    process.stderr.write(`- ${payload.replyTemplate.path}\n`);
  }
  process.exitCode = 1;
});
