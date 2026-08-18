#!/usr/bin/env node

import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  createResultSetApi,
  ResultSetApiError,
} from "./adapters/result-set-api.mjs";
import { isUuid, ResultSetContractError } from "./contracts/result-set.mjs";
import {
  createResultSetOperations,
  ResultSetOperationError,
} from "./result-set-operations.mjs";
import { createResultSetContextStore } from "./runtime/result-set-context.mjs";
import { createCalculationTaskApi } from "./adapters/calculation-task-api.mjs";
import {
  DEFAULT_CALCULATION_PROFILE,
  defaultMethodSelections,
} from "./contracts/default-profile.mjs";
import { replyTemplateFor } from "./reply-template-registry.mjs";

const CLI_SCHEMA = "tiangong.calculation-cli-result.v1";
const COMMAND = "npm --prefix workflows/calculation run --silent cli --";
const REPOSITORY_ENV = fileURLToPath(new URL("../../.env", import.meta.url));
const REPOSITORY_CONTEXT = fileURLToPath(
  new URL("../../.release", import.meta.url),
);

const HELP = `Calculation Workflow CLI

Manage the ResultSet entry point owned by workflows/calculation. This is not a
repository-wide tiangong-release command.

Usage:
  ${COMMAND} result-set list [--limit 20] [--format human|json]
  ${COMMAND} result-set get --result-set-id <uuid> [--format human|json]
  ${COMMAND} result-set create --name <name> --confirm-create [--format human|json]
  ${COMMAND} closure start --coverage-mode <global_eligible|subset> --method <uuid>@<version> --idempotency-token <token> --confirm-start
  ${COMMAND} calculation start --name <name> --closure-check-id <uuid> --requested-scope-hash <hash> --policy-fingerprint <hash> --coverage-mode <mode> --method <uuid>@<version> --idempotency-key <key> --confirm-start
  ${COMMAND} worker logs --job-id <uuid> [--environment <name>] [--since <journal-time>]

Behavior:
  list    Returns a bounded recent list; the remote contract has no cursor.
  get     Reads one exact ResultSet by UUID and records a local recovery reference.
  create  Creates a remote ResultSet only with --confirm-create and records its ID.

Examples:
  ${COMMAND} result-set list --limit 20 --format json
  ${COMMAND} result-set get --result-set-id 123e4567-e89b-42d3-a456-426614174000
  ${COMMAND} result-set create --name "Steel baseline" --confirm-create
`;

const EXIT_CODES = {
  invalid_request: 2,
  confirmation_required: 3,
  auth_required: 4,
  result_set_not_found: 5,
  not_data_product_manager: 6,
  remote_outcome_unknown: 7,
  invalid_result_set_reference: 8,
  capability_unavailable: 9,
  local_context_write_failed: 10,
};

function parseFlags(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new ResultSetOperationError(
        "invalid_request",
        `Unexpected argument: ${token}`,
      );
    }
    const key = token.slice(2);
    if (key === "confirm-create" || key === "confirm-start") {
      values[key === "confirm-create" ? "confirmCreate" : "confirmStart"] =
        true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ResultSetOperationError(
        "invalid_request",
        `--${key} requires a value`,
      );
    }
    index += 1;
    if (key === "format") values.format = value;
    else if (key === "limit") values.limit = Number(value);
    else if (key === "result-set-id") values.resultSetId = value;
    else if (key === "name") values.name = value;
    else if (key === "job-id") values.jobId = value;
    else if (key === "closure-check-id") values.closureCheckId = value;
    else if (key === "coverage-mode") values.coverageMode = value;
    else if (key === "idempotency-token") values.idempotencyToken = value;
    else if (key === "idempotency-key") values.idempotencyKey = value;
    else if (key === "requested-scope-hash") values.requestedScopeHash = value;
    else if (key === "policy-fingerprint") values.policyFingerprint = value;
    else if (key === "environment") values.environment = value;
    else if (key === "since") values.since = value;
    else if (key === "method" || key === "process")
      (values[`${key}s`] ??= []).push(value);
    else
      throw new ResultSetOperationError(
        "invalid_request",
        `Unknown option: --${key}`,
      );
  }
  if (values.format && !["human", "json"].includes(values.format)) {
    throw new ResultSetOperationError(
      "invalid_request",
      "--format must be human or json",
    );
  }
  return values;
}

function selection(value, flag) {
  const split = value.lastIndexOf("@");
  const id = value.slice(0, split);
  const version = value.slice(split + 1);
  if (split < 1 || !isUuid(id) || !/^\d{2}\.\d{2}\.\d{3}$/.test(version))
    throw new ResultSetOperationError(
      "invalid_request",
      `${flag} must be <uuid>@<00.00.000>`,
    );
  return { id, version };
}

function workspaceLogsCommand(jobId, { environment, since } = {}) {
  const parts = [
    "python -m workspace_ops.cli worker job",
    jobId,
    "--all-configs",
    "--kind all",
  ];
  if (environment) parts.push("--environment", JSON.stringify(environment));
  if (since) parts.push("--since", JSON.stringify(since));
  parts.push("--execute");
  return parts.join(" ");
}

function success(command, result) {
  const nextActions = [];
  if (command === "result-set.list") {
    nextActions.push(`${COMMAND} result-set get --result-set-id <uuid>`);
  } else {
    nextActions.push(
      "Continue Calculation with the exact resultSetId after scope and LCIA methods are confirmed",
    );
  }
  const output = {
    schemaVersion: CLI_SCHEMA,
    ok: true,
    command,
    ...result,
    nextActions,
  };
  return { ...output, replyTemplate: replyTemplateFor(command, { ok: true }) };
}

function failure(command, error) {
  const code = error?.code ?? "capability_unavailable";
  const nextActions =
    code === "confirmation_required"
      ? [
          `Repeat the create command with --confirm-create after reviewing the exact name`,
        ]
      : code === "remote_outcome_unknown"
        ? [`${COMMAND} result-set list --format json`]
        : [];
  const output = {
    schemaVersion: CLI_SCHEMA,
    ok: false,
    command,
    error: {
      code,
      message:
        error instanceof Error ? error.message : "Unknown ResultSet failure",
      ...(error?.details === undefined ? {} : { details: error.details }),
    },
    nextActions,
  };
  return {
    ...output,
    replyTemplate: replyTemplateFor(command, { ok: false, errorCode: code }),
  };
}

function humanSuccess(result) {
  const lines = [];
  if (result.command === "result-set.list") {
    lines.push(`ResultSets (${result.data.items.length})`, "", "Summary:");
    for (const item of result.data.items) {
      lines.push(
        `- ${item.name} | ${item.id} | ${item.createdAt ?? "unknown"}`,
      );
    }
    lines.push(
      `- Completeness: bounded to ${result.completeness.limit}; more items ${result.completeness.mayHaveMore ? "may exist" : "are not indicated"}`,
    );
  } else {
    lines.push(
      result.command === "result-set.create"
        ? "ResultSet created"
        : "ResultSet found",
      "",
      "Summary:",
      `- ${result.data.name} | ${result.data.id} | ${result.data.createdAt ?? "unknown"}`,
      `- Recovery reference: ${result.contextPath}`,
    );
  }
  for (const warning of result.warnings ?? [])
    lines.push(`- Warning: ${warning.message}`);
  lines.push("", "Next:");
  for (const action of result.nextActions) lines.push(`- ${action}`);
  lines.push(`- Reply using template: ${result.replyTemplate.path}`);
  return `${lines.join("\n")}\n`;
}

function humanFailure(result) {
  const lines = [
    `ResultSet command failed: ${result.error.code}`,
    "",
    result.error.message,
  ];
  if (result.nextActions.length) {
    lines.push("", "Next:");
    for (const action of result.nextActions) lines.push(`- ${action}`);
  }
  lines.push("", `Reply template: ${result.replyTemplate.path}`);
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
    fetchImpl = globalThis.fetch,
    contextRoot = REPOSITORY_CONTEXT,
  } = {},
) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout.write(HELP);
    return 0;
  }

  let command = "result-set.unknown";
  let format = "human";
  try {
    const [family, action, ...rest] = argv;
    if (family === "worker" && action === "logs") {
      command = "worker.logs";
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!isUuid(flags.jobId))
        throw new ResultSetOperationError(
          "invalid_request",
          "--job-id must be an exact UUID",
        );
      const instruction = workspaceLogsCommand(flags.jobId, flags);
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: {
          jobId: flags.jobId,
          executionOwner: "lca-workspace/workspace_ops",
          workingDirectory: "lca-workspace root",
          instruction,
        },
        completeness: { status: "delegated", remoteLogsRead: false },
        nextActions: [instruction],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `Worker log access\n\nRun from the lca-workspace root:\n${instruction}\n\nReply template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (["closure", "calculation"].includes(family) && action === "start") {
      command = `${family}.start`;
      const flags = parseFlags(rest);
      format = flags.format ?? "human";
      if (!flags.confirmStart)
        throw new ResultSetOperationError(
          "confirmation_required",
          `Starting ${family} requires --confirm-start`,
        );
      const defaultedInputs = [];
      const coverageMode =
        flags.coverageMode ?? DEFAULT_CALCULATION_PROFILE.coverageMode;
      if (!flags.coverageMode) defaultedInputs.push("coverageMode");
      if (!["global_eligible", "subset"].includes(coverageMode))
        throw new ResultSetOperationError(
          "invalid_request",
          "--coverage-mode must be global_eligible or subset",
        );
      const processes = (flags.processes ?? []).map((value) =>
        selection(value, "--process"),
      );
      const lciaMethods = flags.methods?.length
        ? flags.methods.map((value) => selection(value, "--method"))
        : defaultMethodSelections();
      if (!flags.methods?.length) defaultedInputs.push("lciaMethods");
      if ((coverageMode === "subset") !== processes.length > 0)
        throw new ResultSetOperationError(
          "invalid_request",
          "subset requires --process; global_eligible forbids it",
        );
      const taskApi = createCalculationTaskApi({ env, fetchImpl });
      let task;
      if (family === "closure") {
        if (flags.resultSetId && !isUuid(flags.resultSetId))
          throw new ResultSetOperationError(
            "invalid_request",
            "--result-set-id must be an exact UUID",
          );
        if (!flags.idempotencyToken)
          throw new ResultSetOperationError(
            "invalid_request",
            "--idempotency-token is required",
          );
        task = await taskApi.createClosure({
          resultSetId: flags.resultSetId,
          requestedScope: {
            coverageMode,
            ...(processes.length ? { processes } : {}),
            lciaMethods,
          },
          idempotencyToken: flags.idempotencyToken,
        });
      } else {
        for (const [key, label] of [
          ["name", "--name"],
          ["closureCheckId", "--closure-check-id"],
          ["requestedScopeHash", "--requested-scope-hash"],
          ["policyFingerprint", "--policy-fingerprint"],
          ["idempotencyKey", "--idempotency-key"],
        ])
          if (!flags[key])
            throw new ResultSetOperationError(
              "invalid_request",
              `${label} is required`,
            );
        if (!isUuid(flags.closureCheckId))
          throw new ResultSetOperationError(
            "invalid_request",
            "--closure-check-id must be an exact UUID",
          );
        task = await taskApi.createCalculation({
          ...flags,
          coverageMode,
          processes,
          lciaMethods,
        });
      }
      const logs = workspaceLogsCommand(task.jobId);
      const result = {
        schemaVersion: CLI_SCHEMA,
        ok: true,
        command,
        data: {
          ...task,
          effectiveInput: { coverageMode, lciaMethods, defaultedInputs },
        },
        completeness: { status: "submitted", terminalStateObserved: false },
        nextActions: [logs],
      };
      result.replyTemplate = replyTemplateFor(command, { ok: true });
      stdout.write(
        format === "json"
          ? `${JSON.stringify(result)}\n`
          : `${family === "closure" ? "Closure Check" : "Calculation"} submitted\n\nSummary:\n- Job: ${task.jobId}\n- Resource: ${task.resourceId ?? "pending"}\n- Identity: ${task.identityCompleteness}\n- Status: ${task.status}\n\nNext (run from lca-workspace root):\n- ${logs}\n- Reply using template: ${result.replyTemplate.path}\n`,
      );
      return 0;
    }
    if (
      family !== "result-set" ||
      !["list", "get", "create"].includes(action)
    ) {
      throw new ResultSetOperationError(
        "invalid_request",
        "Expected result-set followed by list, get, or create; use --help for examples",
      );
    }
    command = `result-set.${action}`;
    const flags = parseFlags(rest);
    format = flags.format ?? "human";

    if (
      action === "list" &&
      flags.limit !== undefined &&
      !Number.isInteger(flags.limit)
    ) {
      throw new ResultSetOperationError(
        "invalid_request",
        "--limit must be an integer from 1 to 200",
      );
    }
    if (action === "get" && !isUuid(flags.resultSetId)) {
      throw new ResultSetOperationError(
        "invalid_request",
        "--result-set-id must be an exact UUID; names are not resolved implicitly",
      );
    }
    if (action === "create" && !flags.name?.trim()) {
      throw new ResultSetOperationError(
        "invalid_request",
        "--name is required",
      );
    }
    if (action === "create" && !flags.confirmCreate) {
      throw new ResultSetOperationError(
        "confirmation_required",
        "Creating a remote ResultSet requires --confirm-create after the exact name is reviewed",
        { name: flags.name.trim() },
      );
    }

    const api = createResultSetApi({ env, fetchImpl });
    const operations = createResultSetOperations({
      api,
      contextStore: createResultSetContextStore({ root: contextRoot }),
    });

    const operationResult =
      action === "list"
        ? await operations.list({ limit: flags.limit ?? 20 })
        : action === "get"
          ? await operations.get({ resultSetId: flags.resultSetId })
          : await operations.create({
              name: flags.name,
              confirmed: flags.confirmCreate,
            });
    const result = success(command, operationResult);
    stdout.write(
      format === "json" ? `${JSON.stringify(result)}\n` : humanSuccess(result),
    );
    return 0;
  } catch (error) {
    let normalized = error;
    if (
      !(error instanceof ResultSetOperationError) &&
      !(error instanceof ResultSetApiError) &&
      !(error instanceof ResultSetContractError) &&
      error?.name !== "ActorSessionError"
    ) {
      normalized = new ResultSetOperationError(
        "local_context_write_failed",
        "The ResultSet operation completed but its local recovery reference could not be written",
        { cause: error instanceof Error ? error.name : "unknown" },
      );
    }
    const result = failure(command, normalized);
    const rendered =
      format === "json" ? `${JSON.stringify(result)}\n` : humanFailure(result);
    (format === "json" ? stdout : stderr).write(rendered);
    return EXIT_CODES[result.error.code] ?? 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (existsSync(REPOSITORY_ENV)) loadEnvFile(REPOSITORY_ENV);
  process.exitCode = await runCli(process.argv.slice(2));
}
