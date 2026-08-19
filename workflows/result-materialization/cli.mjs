#!/usr/bin/env node
import { createIntake } from "./lib/intake.mjs";
import { materialize } from "./lib/materialize.mjs";

const HELP = `release-result-materialization <command> [options]

Commands:
  intake              Verify a local Calculation Bundle v2 ZIP/directory and freeze an intake
  materialize         Generate the requested Result Process or LifecycleModel delivery

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
        command: `node cli.mjs materialize --intake ${quote(result.path)} --processes <UUID@VERSION,...> --output-type <result-process|lifecycle-model> --result-process-layer <lci|lci-lcia> --out-dir <MATERIALIZATION_DIR> --first-generation --json`,
        description:
          "Choose scope, final dataset type, and the Result Process content layer, then materialize the complete local delivery. LifecycleModel itself does not contain LCI/LCIA results.",
      },
    });
    return;
  }
  if (command === "materialize") {
    requireOptions(options, [
      "intake",
      "out-dir",
      "output-type",
      "result-process-layer",
    ]);
    requireSelection(options);
    const result = await materialize({
      intakeDir: options.intake,
      outDir: options["out-dir"],
      processUuids: options.all ? undefined : splitSelectors(options.processes),
      outputType: options["output-type"],
      resultProcessLayer: options["result-process-layer"],
      firstGeneration: Boolean(options["first-generation"]),
      previousManifestPath: options["previous-manifest"],
    });
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
    if (["json", "first-generation", "all"].includes(key)) result[key] = true;
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
