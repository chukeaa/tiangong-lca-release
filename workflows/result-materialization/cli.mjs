#!/usr/bin/env node
import { createIntake } from "./lib/intake.mjs";
import { materializeResults } from "./lib/materialize-results.mjs";
import { materializeModels } from "./lib/materialize-models.mjs";

const HELP = `release-result-materialization <command> [options]

Commands:
  intake              Verify a local Calculation Bundle v2 ZIP/directory and freeze an intake
  materialize-results Generate the selected R(P) set and freeze result-catalog.json
  materialize-models  Generate resolved one-hop M(P) from a frozen Result Catalog

intake options:
  --bundle <path>      Local calculation-evidence-bundle.zip or extracted directory
  --out-dir <path>     New immutable intake directory

materialize-results options:
  --intake <path>      Verified intake directory
  --processes <list>   Comma-separated Model root Process UUIDs
  --all                Select every Process in the Calculation Bundle as a Model root
  --out-dir <path>     New output directory
  --first-generation   Confirm that no previous Release Manifest exists
  --previous-manifest <path>  Previous materialization/release manifest

materialize-models options:
  --intake <path>      Same verified intake used for the Result Catalog
  --result-catalog <path>  Frozen result-catalog.json
  --processes <list>   Optional subset of the Catalog's selected Model roots
  --all-selected       Generate every selected Model root from the Catalog
  --out-dir <path>     New output directory
  --first-generation   Confirm that no previous Release Manifest exists
  --previous-manifest <path>  Previous materialization/release manifest

Common:
  --json               Emit one bounded JSON result on stdout
  --help               Show this help
`;

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
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
        command: `node cli.mjs materialize-results --intake ${quote(result.path)} --all --out-dir <RESULT_OUTPUT_DIR> --first-generation --json`,
        description:
          "Generate the required local Result Process set and freeze Result Catalog.",
      },
    });
    return;
  }
  if (command === "materialize-results") {
    requireOptions(options, ["intake", "out-dir"]);
    requireSelection(options, "all");
    const result = await materializeResults({
      intakeDir: options.intake,
      outDir: options["out-dir"],
      processUuids: options.all ? undefined : splitUuids(options.processes),
      firstGeneration: Boolean(options["first-generation"]),
      previousManifestPath: options["previous-manifest"],
    });
    respond(options, {
      ok: true,
      command,
      outcome: "materialized",
      output: result.path,
      completeness: result.catalog.completeness,
      rootCount: result.catalog.selection.length,
      resultCount: result.catalog.datasets.length,
      catalog: `${result.path}/result-catalog.json`,
      nextAction: {
        command: `node cli.mjs materialize-models --intake ${quote(options.intake)} --result-catalog ${quote(`${result.path}/result-catalog.json`)} --all-selected --out-dir <MODEL_OUTPUT_DIR> ${options["previous-manifest"] ? `--previous-manifest ${quote(options["previous-manifest"])}` : "--first-generation"} --json`,
        description:
          "Generate resolved one-hop LifecycleModels from the frozen Result Catalog.",
      },
    });
    return;
  }
  if (command === "materialize-models") {
    requireOptions(options, ["intake", "result-catalog", "out-dir"]);
    requireSelection(options, "all-selected");
    const result = await materializeModels({
      intakeDir: options.intake,
      resultCatalogPath: options["result-catalog"],
      outDir: options["out-dir"],
      processUuids: options["all-selected"]
        ? undefined
        : splitUuids(options.processes),
      firstGeneration: Boolean(options["first-generation"]),
      previousManifestPath: options["previous-manifest"],
    });
    respond(options, {
      ok: true,
      command,
      outcome: "materialized",
      output: result.path,
      completeness: result.catalog.completeness,
      modelCount: result.catalog.datasets.length,
      manifest: `${result.path}/materialization-manifest.json`,
      nextAction: {
        description:
          "Hand materialization-manifest.json and canonical datasets to Release Workflow.",
      },
    });
    return;
  }
  throw Object.assign(new Error(`Unknown command: ${command}`), {
    code: "unknown_command",
  });
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
    if (["json", "first-generation", "all", "all-selected"].includes(key))
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

function requireSelection(options, allFlag) {
  if (Boolean(options[allFlag]) === Boolean(options.processes)) {
    throw Object.assign(
      new Error(`Choose exactly one of --${allFlag} or --processes <uuid,...>`),
      { code: "selection_required" },
    );
  }
}

function splitUuids(value) {
  const result = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!result.length) {
    throw Object.assign(
      new Error("--processes must contain at least one UUID"),
      {
        code: "selection_required",
      },
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
