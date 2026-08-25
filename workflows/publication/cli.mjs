#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePublicationPlan } from "./lib/plan.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const COMMAND = `node ${shellQuote(CLI_PATH)}`;
const VALUE_OPTIONS = new Set([
  "candidate",
  "component",
  "target",
  "include",
  "exclude",
  "out-dir",
]);
const REPEATABLE_OPTIONS = new Set(["include", "exclude"]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);

const HELP = `release-publication <command> [options]

Publication workflow-local CLI. It prepares an immutable, unauthorized local Publish Plan; it performs no remote mutation.

Commands:
  plan prepare       Resolve one dependency-closed Publication scope from an immutable Candidate

plan prepare options:
  --candidate <path>      Release Candidate v2 directory
  --component <value>     unit-process, result, or both
  --target <id>           Stable target identifier; no credential or URL
  --include <identity>    Optional exact root identity; repeatable; replaces component default roots
  --exclude <identity>    Optional exact identity to prune with all reverse dependents; repeatable
  --out-dir <path>        New immutable Publication planning directory

Identity format:
  <datasetType>:<uuid>@<version>

Common:
  --json                  Emit one bounded JSON object
  --help                  Show this help

Examples:
  release-publication plan prepare --candidate .release/candidates/<candidate> \\
    --component both --target tiangong-lca-platform \\
    --out-dir .release/publication/plans/<plan> --json

  release-publication plan prepare --candidate .release/candidates/<candidate> \\
    --component result --target tiangong-lca-platform \\
    --include lifecyclemodel:<uuid>@01.00.000 \\
    --exclude process:<uuid>@01.00.000 \\
    --out-dir .release/publication/plans/<plan> --json

The result binds exact Candidate evidence, requested scope, dependency additions, recursive pruning, and the final reference-complete set.
It does not inspect remote target state, authorize publication, map a state code, write data, or perform independent readback.
`;

async function main() {
  const [command, action, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (command !== "plan" || action !== "prepare")
    throw coded(
      "unknown_command",
      `Unknown command: ${[command, action].filter(Boolean).join(" ")}`,
    );
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  requireOptions(options, ["candidate", "component", "target", "out-dir"]);
  const result = await preparePublicationPlan({
    candidateDir: path.resolve(options.candidate),
    outDir: path.resolve(options["out-dir"]),
    component: options.component,
    targetId: options.target,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  });
  const resolutionPath = path.join(
    result.path,
    "publication-scope-resolution.json",
  );
  const planPath = path.join(result.path, "publish-plan.json");
  const payload = {
    ok: true,
    command: "plan prepare",
    outcome: "publish_plan_prepared",
    completeness: "local_plan_complete_remote_contract_pending",
    candidate: path.resolve(options.candidate),
    component: result.request.component,
    targetId: result.request.targetId,
    requestedRootCount: result.resolution.requestedRootCount,
    dependencyAdditionCount: result.resolution.dependencyAdditions.length,
    prunedDatasetCount: result.resolution.prunedDatasets.length,
    effectiveDatasetCount: result.resolution.effectiveDatasetCount,
    effectiveSetHash: result.resolution.effectiveSetHash,
    publishPlanSha256: result.publishPlanSha256,
    publicationAuthorized: false,
    remoteExecutionAvailable: false,
    artifacts: {
      scopeRequest: path.join(result.path, "publication-scope-request.json"),
      scopeResolution: resolutionPath,
      publishPlan: planPath,
    },
    nextActions: [
      {
        kind: "inspect_scope_resolution",
        command: `jq . ${shellQuote(resolutionPath)}`,
        argv: ["jq", ".", resolutionPath],
      },
      {
        kind: "inspect_publish_plan",
        command: `jq . ${shellQuote(planPath)}`,
        argv: ["jq", ".", planPath],
      },
    ],
    replyTemplate: replyTemplateFor("plan prepare", { ok: true }),
  };
  respond(options, payload);
}

function parseArgs(tokens) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--"))
      throw coded(
        "invalid_arguments",
        `Unexpected positional argument: ${token}`,
      );
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      if (result[name] !== undefined)
        throw coded("duplicate_argument", `Duplicate option: --${name}`);
      result[name] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(name))
      throw coded("unknown_argument", `Unknown option: --${name}`);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw coded("invalid_arguments", `Missing value for --${name}`);
    index += 1;
    if (REPEATABLE_OPTIONS.has(name)) {
      result[name] = [...(result[name] ?? []), value];
      continue;
    }
    if (result[name] !== undefined)
      throw coded("duplicate_argument", `Duplicate option: --${name}`);
    result[name] = value;
  }
  return result;
}

function requireOptions(options, names) {
  const missing = names.filter((name) => !options[name]);
  if (missing.length)
    throw coded(
      "invalid_arguments",
      `Missing required options: ${missing.map((name) => `--${name}`).join(", ")}`,
    );
}

function respond(options, payload) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write("Publish Plan prepared\n\nSummary:\n");
  process.stdout.write(`- Component: ${payload.component}\n`);
  process.stdout.write(`- Requested roots: ${payload.requestedRootCount}\n`);
  process.stdout.write(
    `- Dependency additions: ${payload.dependencyAdditionCount}\n`,
  );
  process.stdout.write(`- Pruned datasets: ${payload.prunedDatasetCount}\n`);
  process.stdout.write(
    `- Effective datasets: ${payload.effectiveDatasetCount}\n`,
  );
  process.stdout.write(`- Publication authorized: no\n`);
  process.stdout.write(`- Remote execution available: no\n\nNext:\n`);
  for (const action of payload.nextActions)
    process.stdout.write(`- ${action.command}\n`);
  process.stdout.write(
    `\nReply using template:\n- ${payload.replyTemplate.path}\n`,
  );
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

main().catch((error) => {
  const payload = {
    ok: false,
    command: process.argv.slice(2, 4).join(" ") || "publication",
    outcome: "publication_command_failed",
    completeness: "failed",
    error: {
      code: error.code ?? "publication_command_failed",
      message: error.message,
      details: error.details ?? {},
    },
    nextActions: [
      {
        kind: "inspect_publication_help",
        command: `${COMMAND} --help`,
        argv: ["node", CLI_PATH, "--help"],
      },
    ],
    replyTemplate: replyTemplateFor("plan prepare", { ok: false }),
  };
  if (process.argv.includes("--json"))
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  else
    process.stderr.write(
      `${payload.error.code}: ${payload.error.message}\n\nNext:\n- ${payload.nextActions[0].command}\n\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
  process.exitCode = 1;
});
