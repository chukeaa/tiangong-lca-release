#!/usr/bin/env node
import path from "node:path";
import { createIntake } from "./lib/intake.mjs";
import {
  cancelMaterializationJob,
  getMaterializationJob,
  readMaterializationJobLogs,
  startMaterializationJob,
} from "./lib/background-job.mjs";
import { materialize } from "./lib/materialize.mjs";

const HELP = `release-result-materialization <command> [options]

Commands:
  intake              Verify a local Calculation Bundle v2 ZIP/directory and freeze an intake
  materialize         Generate the requested Result Process or LifecycleModel delivery
  materialize start   Start the same Materialization engine as an observable nohup job
  job get             Read bounded local status for one exact background job
  job logs            Read the last 1-500 lines from one exact background job log
  job cancel          Request SIGTERM cancellation for one exact running job

intake options:
  --bundle <path>      Local calculation-evidence-bundle.zip or extracted directory
  --out-dir <path>     New immutable intake directory

materialize options:
  --intake <path>      Verified intake directory
  --processes <list>   Comma-separated UUID@version selectors
  --all                Select every eligible Process in the Calculation Bundle
  --output-type <type> result-process or lifecycle-model
  --result-process-layer <layer> Result Process content: lci or lci-lcia
  --out-dir <path>     New immutable materialization directory
  --first-generation   Confirm that no previous Release Manifest exists
  --previous-manifest <path>  Previous materialization/release manifest
  --artifact-root <path>  Local job workspace root; defaults to repository .release
  --concurrency <count>   Bounded render/write workers; defaults to 2, maximum 16

job options:
  --job-id <uuid>      Exact local Materialization job identity
  --tail <count>       Log lines to return; defaults to 100, maximum 500
  --artifact-root <path>  Same optional local workspace root used by start

Common:
  --json               Emit one bounded JSON result on stdout
  --help               Show this help
`;

const ACTION_HELP = {
  intake: `release-result-materialization intake --bundle <path> --out-dir <path> [--json]\n\nVerify a local Calculation Bundle and freeze an immutable intake.\n`,
  materialize: `release-result-materialization materialize --intake <path> (--processes <UUID@version,...> | --all) --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> --out-dir <path> (--first-generation | --previous-manifest <path>) [--concurrency <1-16>] [--json]\n\nRun Result Materialization in the foreground. LifecycleModel output includes the exact Result Processes it references.\n`,
  "materialize start": `release-result-materialization materialize start --intake <path> (--processes <UUID@version,...> | --all) --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> --out-dir <path> (--first-generation | --previous-manifest <path>) [--artifact-root <path>] [--concurrency <1-16>] [--json]\n\nStart the same deterministic engine as an observable local nohup job.\n`,
  "job get": `release-result-materialization job get --job-id <uuid> [--artifact-root <path>] [--json]\n\nRead bounded status, progress, resources, throughput, and ETA for one job.\n`,
  "job logs": `release-result-materialization job logs --job-id <uuid> [--tail <1-500>] [--artifact-root <path>] [--json]\n\nRead a bounded tail of one job's structured local log.\n`,
  "job cancel": `release-result-materialization job cancel --job-id <uuid> [--artifact-root <path>] [--json]\n\nRequest cancellation after verifying the exact runner identity.\n`,
};

async function main() {
  const [command, ...initialTokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const tokens = [...initialTokens];
  const subcommand =
    tokens[0] && !tokens[0].startsWith("--") ? tokens.shift() : null;
  if (tokens.includes("--help") || tokens.includes("-h")) {
    const route = subcommand ? `${command} ${subcommand}` : command;
    process.stdout.write(ACTION_HELP[route] ?? HELP);
    return;
  }
  const options = parseArgs(tokens);
  if (command === "intake") {
    requireOptions(options, ["bundle", "out-dir"]);
    const result = await createIntake({
      bundle: options.bundle,
      outDir: options["out-dir"],
    });
    respond(options, {
      ok: true,
      command,
      outcome: "verified",
      intake: result.path,
      calculationId: result.intake.source.calculationId,
      bundleContentHash: result.intake.source.bundleContentHash,
      nextAction: {
        command: `node cli.mjs materialize start --intake ${quote(result.path)} --processes <UUID@VERSION,...> --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> --out-dir <MATERIALIZATION_DIR> --first-generation --json`,
        description:
          "Choose scope, final dataset type, and the Result Process content layer, then start an observable background run. Omit 'start' for a foreground run. LifecycleModel itself does not contain LCI/LCIA results.",
      },
    });
    return;
  }
  if (command === "materialize" && subcommand === "start") {
    requireMaterializationOptions(options);
    const result = await startMaterializationJob({
      artifactRoot: options["artifact-root"],
      request: materializationRequestFromOptions(options),
    });
    respond(options, {
      ...result,
      command: "materialize start",
      outcome: "started",
      nextAction: {
        description: result.nextActions.join("; "),
      },
    });
    return;
  }
  if (command === "materialize" && subcommand === null) {
    requireMaterializationOptions(options);
    const request = materializationRequestFromOptions(options);
    const result = await materialize(request);
    respond(options, {
      ok: true,
      command,
      outcome: "materialized",
      output: result.path,
      completeness: result.manifest.completeness,
      outputType: result.request.outputType,
      resultProcessLayer: result.request.resultProcessLayer,
      ...result.summary,
      manifest: `${result.path}/materialization-manifest.json`,
      nextAction: {
        description:
          "Hand materialization-manifest.json and canonical datasets to Release Workflow.",
      },
    });
    return;
  }
  if (command === "job" && subcommand === "get") {
    requireOptions(options, ["job-id"]);
    const result = await getMaterializationJob({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
    });
    respond(options, {
      ...result,
      command: "job get",
      outcome: result.state,
      nextAction: { description: result.nextActions.join("; ") },
    });
    return;
  }
  if (command === "job" && subcommand === "logs") {
    requireOptions(options, ["job-id"]);
    const result = await readMaterializationJobLogs({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
      tail:
        options.tail === undefined ? 100 : parseInteger(options.tail, "tail"),
    });
    respond(options, {
      ...result,
      command: "job logs",
      outcome: "read",
      nextAction: {
        description: `node cli.mjs job get --job-id ${result.jobId} --artifact-root ${quote(result.artifactRoot)} --json`,
      },
    });
    return;
  }
  if (command === "job" && subcommand === "cancel") {
    requireOptions(options, ["job-id"]);
    const result = await cancelMaterializationJob({
      artifactRoot: options["artifact-root"],
      jobId: options["job-id"],
    });
    respond(options, {
      ...result,
      command: "job cancel",
      outcome: result.state,
      nextAction: {
        description: `node cli.mjs job get --job-id ${result.jobId} --artifact-root ${quote(result.artifactRoot)} --json`,
      },
    });
    return;
  }
  if (command === "materialize" || command === "job") {
    throw Object.assign(
      new Error(`Unknown ${command} action: ${subcommand ?? "<none>"}`),
      { code: "unknown_command" },
    );
  }
  throw Object.assign(new Error(`Unknown command: ${command}`), {
    code: "unknown_command",
  });
}

function requireMaterializationOptions(options) {
  requireOptions(options, [
    "intake",
    "out-dir",
    "output-type",
    "result-process-layer",
  ]);
  requireSelection(options);
  if (
    Boolean(options["first-generation"]) ===
    Boolean(options["previous-manifest"])
  ) {
    throw Object.assign(
      new Error(
        "Choose exactly one of --first-generation or --previous-manifest <path>",
      ),
      { code: "version_history_choice_required" },
    );
  }
}

function materializationRequestFromOptions(options) {
  return {
    intakeDir: path.resolve(options.intake),
    outDir: path.resolve(options["out-dir"]),
    processUuids: options.all ? undefined : splitSelectors(options.processes),
    outputType: options["output-type"],
    resultProcessLayer: options["result-process-layer"],
    firstGeneration: Boolean(options["first-generation"]),
    previousManifestPath: options["previous-manifest"]
      ? path.resolve(options["previous-manifest"])
      : undefined,
    concurrency:
      options.concurrency === undefined
        ? 2
        : parseBoundedInteger(options.concurrency, "concurrency", 1, 16),
  };
}

function parseInteger(value, name) {
  if (!/^[0-9]+$/.test(String(value))) {
    throw Object.assign(new Error(`--${name} must be an integer`), {
      code: "invalid_arguments",
    });
  }
  return Number.parseInt(value, 10);
}

function parseBoundedInteger(value, name, minimum, maximum) {
  const parsed = parseInteger(value, name);
  if (parsed < minimum || parsed > maximum) {
    throw Object.assign(
      new Error(`--${name} must be an integer from ${minimum} to ${maximum}`),
      { code: "invalid_arguments" },
    );
  }
  return parsed;
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw Object.assign(new Error(`Unexpected argument: ${token}`), {
        code: "invalid_arguments",
      });
    }
    const key = token.slice(2);
    if (["json", "first-generation", "all", "help"].includes(key))
      result[key] = true;
    else {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        throw Object.assign(new Error(`Missing value for --${key}`), {
          code: "invalid_arguments",
        });
      }
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function requireSelection(options) {
  if (Boolean(options.all) === Boolean(options.processes)) {
    throw Object.assign(
      new Error(
        "Choose exactly one of --all or --processes <UUID@version,...>",
      ),
      { code: "selection_required" },
    );
  }
}

function splitSelectors(value) {
  const result = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!result.length) {
    throw Object.assign(
      new Error("--processes must contain at least one UUID@version selector"),
      { code: "selection_required" },
    );
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length) {
    throw Object.assign(
      new Error(
        `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
      ),
      { code: "invalid_arguments" },
    );
  }
}

function respond(options, value) {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else {
    process.stdout.write(`✅ ${value.outcome}\n`);
    if (value.intake) process.stdout.write(`Intake: ${value.intake}\n`);
    if (value.output) process.stdout.write(`Output: ${value.output}\n`);
    if (value.jobId) process.stdout.write(`Job: ${value.jobId}\n`);
    if (value.logPath) process.stdout.write(`Log: ${value.logPath}\n`);
    if (value.lines) process.stdout.write(`${value.lines.join("\n")}\n`);
    process.stdout.write(`Next: ${value.nextAction.description}\n`);
  }
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: {
      code: error.code ?? "unexpected_error",
      message: error.message,
      details: error.details ?? {},
    },
  };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});
