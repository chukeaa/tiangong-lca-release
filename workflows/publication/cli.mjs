#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicationApproval } from "./lib/approval.mjs";
import { executePublication } from "./lib/execution.mjs";
import { inspectPublicationTarget } from "./lib/inspection.mjs";
import { materializePublicationPayload } from "./lib/payload.mjs";
import { preparePublicationPlan } from "./lib/plan.mjs";
import { verifyPublicationReadback } from "./lib/readback.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const COMMAND = `node ${shellQuote(CLI_PATH)}`;
const VALUE_OPTIONS = new Set([
  "candidate",
  "component",
  "target",
  "include",
  "exclude",
  "plan-dir",
  "payload-dir",
  "inspection-dir",
  "approval-dir",
  "execution-dir",
  "published-state-code",
  "confirm",
  "approved-by",
  "expires-at",
  "reason",
  "out-dir",
]);
const REPEATABLE_OPTIONS = new Set(["include", "exclude"]);
const BOOLEAN_OPTIONS = new Set(["json", "help"]);

const HELP = `release-publication <command> [options]

Complete Candidate-bound Publication workflow. Remote reads and writes always use an actor-scoped session; service-role secrets are not accepted.

Commands:
  plan prepare          Resolve dependency-safe scope into an unapproved Draft Plan
  payload materialize  Extract only the resolved TIDAS datasets from the Candidate
  target inspect        Compare exact UUID + Version + content against the platform
  approval create       Approve the exact executable-plan SHA-256
  publish execute       Recheck the target, create missing rows, and publish exact rows
  readback verify       Independently re-read every approved row and emit a receipt

Core options:
  --candidate <path>              Release Candidate v2 directory
  --plan-dir <path>               Publication Draft Plan directory
  --payload-dir <path>            Materialized Publication payload directory
  --inspection-dir <path>         Target inspection directory
  --approval-dir <path>           Publication approval directory
  --execution-dir <path>          Publication execution directory
  --out-dir <path>                New output directory (execution reuses it for resume)
  --published-state-code <int>    Semantic published-state mapping (default: 100)
  --json                          Emit one bounded JSON object

plan prepare:
  --candidate <path> --component <unit-process|result|both> --target <stable-id>
  [--include <datasetType:uuid@version>] [--exclude <identity>] --out-dir <path>

payload materialize:
  --candidate <path> --plan-dir <path> --out-dir <path>

target inspect:
  --plan-dir <path> --payload-dir <path> [--published-state-code 100] --out-dir <path>

approval create:
  --inspection-dir <path> --confirm <executable-plan-sha256>
  --approved-by <stable-actor-id> [--expires-at <ISO-8601>] [--reason <text>] --out-dir <path>

publish execute:
  --approval-dir <path> --payload-dir <path> --out-dir <path>

readback verify:
  --execution-dir <path> --payload-dir <path> --out-dir <path>

Required remote environment:
  TIANGONG_LCA_API_BASE_URL
  TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
  TIANGONG_LCA_ACCESS_TOKEN or TIANGONG_LCA_API_KEY
`;

async function main() {
  const [command, actionName, ...tokens] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const commandName = `${command} ${actionName ?? ""}`.trim();
  const handlers = {
    "plan prepare": planPrepare,
    "payload materialize": payloadMaterialize,
    "target inspect": targetInspect,
    "approval create": approvalCreate,
    "publish execute": publishExecute,
    "readback verify": readbackVerify,
  };
  if (!handlers[commandName])
    throw coded("unknown_command", `Unknown command: ${commandName}`);
  const options = parseArgs(tokens);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const payload = await handlers[commandName](options);
  payload.replyTemplate = replyTemplateFor(commandName, { ok: true });
  respond(options, payload);
}

async function planPrepare(options) {
  requireOptions(options, ["candidate", "component", "target", "out-dir"]);
  const result = await preparePublicationPlan({
    candidateDir: path.resolve(options.candidate),
    outDir: path.resolve(options["out-dir"]),
    component: options.component,
    targetId: options.target,
    include: options.include ?? [],
    exclude: options.exclude ?? [],
  });
  return success("plan prepare", "publication_draft_plan_prepared", {
    completeness: "scope_resolved_payload_pending",
    candidate: path.resolve(options.candidate),
    component: result.request.component,
    targetId: result.request.targetId,
    requestedRootCount: result.resolution.requestedRootCount,
    dependencyAdditionCount: result.resolution.dependencyAdditions.length,
    prunedDatasetCount: result.resolution.prunedDatasets.length,
    effectiveDatasetCount: result.resolution.effectiveDatasetCount,
    effectiveSetHash: result.resolution.effectiveSetHash,
    publicationDraftPlanSha256: result.publicationDraftPlanSha256,
    publicationAuthorized: false,
    artifacts: {
      scopeRequest: path.join(result.path, "publication-scope-request.json"),
      scopeResolution: path.join(
        result.path,
        "publication-scope-resolution.json",
      ),
      publicationDraftPlan: path.join(
        result.path,
        "publication-draft-plan.json",
      ),
    },
    nextActions: [
      nextAction("materialize_payload", [
        "payload",
        "materialize",
        "--candidate",
        path.resolve(options.candidate),
        "--plan-dir",
        result.path,
        "--out-dir",
        `${result.path}-payload`,
        "--json",
      ]),
    ],
  });
}

async function payloadMaterialize(options) {
  requireOptions(options, ["candidate", "plan-dir", "out-dir"]);
  const result = await materializePublicationPayload({
    candidateDir: path.resolve(options.candidate),
    planDir: path.resolve(options["plan-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("payload materialize", "publication_payload_materialized", {
    completeness: "payload_complete_target_inspection_pending",
    datasetCount: result.manifest.datasetCount,
    datasetSetHash: result.manifest.datasetSetHash,
    payloadManifestSha256: result.manifestSha256,
    artifacts: {
      payloadManifest: path.join(
        result.path,
        "publication-payload-manifest.json",
      ),
      payloadDirectory: path.join(result.path, "datasets"),
    },
    nextActions: [
      nextAction("inspect_target", [
        "target",
        "inspect",
        "--plan-dir",
        path.resolve(options["plan-dir"]),
        "--payload-dir",
        result.path,
        "--out-dir",
        `${result.path}-inspection`,
        "--json",
      ]),
    ],
  });
}

async function targetInspect(options) {
  requireOptions(options, ["plan-dir", "payload-dir", "out-dir"]);
  const result = await inspectPublicationTarget({
    planDir: path.resolve(options["plan-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
    publishedStateCode: integerOption(options, "published-state-code", 100),
  });
  return success("target inspect", "publication_target_inspected", {
    completeness: "executable_plan_ready_for_approval",
    datasetCount: result.snapshot.datasetCount,
    targetFingerprint: result.snapshot.fingerprint,
    publishedState: result.snapshot.publishedState,
    executablePlanSha256: result.executablePlanSha256,
    publicationAuthorized: false,
    artifacts: {
      targetSnapshot: path.join(
        result.path,
        "publication-target-snapshot.json",
      ),
      executablePlan: path.join(
        result.path,
        "publication-executable-plan.json",
      ),
    },
    nextActions: [
      nextAction("approve_exact_plan", [
        "approval",
        "create",
        "--inspection-dir",
        result.path,
        "--confirm",
        result.executablePlanSha256,
        "--approved-by",
        "<actor-id>",
        "--out-dir",
        `${result.path}-approval`,
        "--json",
      ]),
    ],
  });
}

async function approvalCreate(options) {
  requireOptions(options, [
    "inspection-dir",
    "confirm",
    "approved-by",
    "out-dir",
  ]);
  const result = await createPublicationApproval({
    inspectionDir: path.resolve(options["inspection-dir"]),
    outDir: path.resolve(options["out-dir"]),
    confirmPlanSha256: options.confirm,
    approvedBy: options["approved-by"],
    expiresAt: options["expires-at"],
    reason: options.reason ?? null,
  });
  return success("approval create", "publication_approved", {
    completeness: "approved_execution_pending",
    executablePlanSha256: result.executablePlanSha256,
    approvalSha256: result.approvalSha256,
    approvedBy: result.approval.approvedBy,
    expiresAt: result.approval.expiresAt,
    publicationAuthorized: true,
    artifacts: {
      approval: path.join(result.path, "publication-approval.json"),
    },
    nextActions: [
      nextAction("execute_publication", [
        "publish",
        "execute",
        "--approval-dir",
        result.path,
        "--payload-dir",
        "<payload-dir>",
        "--out-dir",
        `${result.path}-execution`,
        "--json",
      ]),
    ],
  });
}

async function publishExecute(options) {
  requireOptions(options, ["approval-dir", "payload-dir", "out-dir"]);
  const result = await executePublication({
    approvalDir: path.resolve(options["approval-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("publish execute", "publication_executed", {
    completeness: "remote_mutation_complete_independent_readback_pending",
    datasetCount: result.receipt.datasetCount,
    completedKeys: result.receipt.completedKeys,
    executionReceiptSha256: result.receiptSha256,
    reused: result.reused,
    artifacts: {
      executionReceipt: path.join(
        result.path,
        "publication-execution-receipt.json",
      ),
      executionEvents: path.join(result.path, "events"),
    },
    nextActions: [
      nextAction("verify_independent_readback", [
        "readback",
        "verify",
        "--execution-dir",
        result.path,
        "--payload-dir",
        path.resolve(options["payload-dir"]),
        "--out-dir",
        `${result.path}-readback`,
        "--json",
      ]),
    ],
  });
}

async function readbackVerify(options) {
  requireOptions(options, ["execution-dir", "payload-dir", "out-dir"]);
  const result = await verifyPublicationReadback({
    executionDir: path.resolve(options["execution-dir"]),
    payloadDir: path.resolve(options["payload-dir"]),
    outDir: path.resolve(options["out-dir"]),
  });
  return success("readback verify", "publication_readback_verified", {
    completeness: "publication_complete",
    datasetCount: result.receipt.datasetCount,
    verifiedSetHash: result.receipt.verifiedSetHash,
    readbackReceiptSha256: result.receiptSha256,
    artifacts: {
      readbackReceipt: path.join(
        result.path,
        "publication-readback-receipt.json",
      ),
    },
    nextActions: [],
  });
}

function success(command, outcome, body) {
  return { ok: true, command, outcome, ...body };
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
    if (REPEATABLE_OPTIONS.has(name))
      result[name] = [...(result[name] ?? []), value];
    else {
      if (result[name] !== undefined)
        throw coded("duplicate_argument", `Duplicate option: --${name}`);
      result[name] = value;
    }
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

function integerOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < 0)
    throw coded(
      "invalid_arguments",
      `--${name} must be a non-negative integer`,
    );
  return value;
}

function nextAction(kind, args) {
  const argv = ["node", CLI_PATH, ...args];
  return { kind, command: argv.map(shellQuote).join(" "), argv };
}

function respond(options, payload) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${payload.outcome}\n`);
  for (const [name, value] of Object.entries(payload))
    if (
      ![
        "ok",
        "command",
        "outcome",
        "artifacts",
        "nextActions",
        "replyTemplate",
      ].includes(name)
    )
      process.stdout.write(`- ${name}: ${JSON.stringify(value)}\n`);
  if (payload.nextActions?.length) {
    process.stdout.write("\nNext:\n");
    for (const next of payload.nextActions)
      process.stdout.write(`- ${next.command}\n`);
  }
  if (payload.replyTemplate)
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
  const commandName = process.argv.slice(2, 4).join(" ") || "publication";
  const payload = {
    ok: false,
    command: commandName,
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
    replyTemplate: replyTemplateFor(commandName, { ok: false }),
  };
  if (process.argv.includes("--json"))
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  else
    process.stderr.write(
      `${payload.error.code}: ${payload.error.message}\n\nNext:\n- ${payload.nextActions[0].command}\n\nReply using template:\n- ${payload.replyTemplate.path}\n`,
    );
  process.exitCode = 1;
});
