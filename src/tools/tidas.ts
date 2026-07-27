import type { JsonValue } from "../contracts/json.js";
import {
  ExternalCommandError,
  localToolEnvironment,
  runJsonCommand,
  runTextCommand,
} from "./external.js";

export const TIDAS_OPERATION_REPORT_SCHEMA = "tidas.operation-report.v1";
export const TIDAS_RELEASE_REPORT_SCHEMA = "tidas.release-report.v1";
export const MINIMUM_TIDAS_VERSION = "0.1.0";

type JsonRecord = Record<string, any>;

export type TidasReleaseInvocation = {
  report: JsonValue;
  release: JsonRecord | null;
  failed: boolean;
  code?: string;
  exitCode: number | null;
  version: string;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function versionTuple(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) throw new Error(`tidas_version_invalid:${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(value: string, minimum: string): boolean {
  const observed = versionTuple(value);
  const required = versionTuple(minimum);
  for (let index = 0; index < observed.length; index += 1) {
    if (observed[index]! > required[index]!) return true;
    if (observed[index]! < required[index]!) return false;
  }
  return true;
}

export function tidasExecutable(
  source: NodeJS.ProcessEnv = process.env,
): string {
  return source.TIANGONG_TIDAS_EXECUTABLE?.trim() || "tidas";
}

const versionCache = new Map<string, Promise<string>>();

async function resolveTidasVersion(input: {
  executable: string;
  cwd: string;
}): Promise<string> {
  let pending = versionCache.get(input.executable);
  if (!pending) {
    pending = runTextCommand({
      executable: input.executable,
      args: ["--version"],
      cwd: input.cwd,
      env: localToolEnvironment(),
    }).then((result) => {
      const firstLine = (result.stdout || result.stderr)
        .split(/\r?\n/u)[0]
        ?.trim();
      const match = /^tidas\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/u.exec(
        firstLine ?? "",
      );
      if (!match) {
        throw new Error(`tidas_version_invalid:${firstLine ?? "empty"}`);
      }
      const version = match[1]!;
      if (!versionAtLeast(version, MINIMUM_TIDAS_VERSION)) {
        throw new Error(
          `tidas_version_unsupported:${version}:minimum=${MINIMUM_TIDAS_VERSION}`,
        );
      }
      return version;
    });
    versionCache.set(input.executable, pending);
  }
  return pending;
}

function assertOperationReport(input: {
  value: JsonValue;
  action: string;
  successfulExit: boolean;
}): { report: JsonRecord; release: JsonRecord | null } {
  const report = record(input.value);
  const summary = record(report?.summary);
  const release = record(summary?.release);
  const statuses = new Set([
    "succeeded",
    "completed-with-issues",
    "failed",
    "cancelled",
  ]);
  const exitClasses = new Set([
    "success",
    "data-issues",
    "usage",
    "unavailable",
    "internal",
    "io",
    "cancelled",
  ]);
  if (
    report?.schema_version !== TIDAS_OPERATION_REPORT_SCHEMA ||
    report.command !== "release" ||
    !statuses.has(String(report.status)) ||
    !exitClasses.has(String(report.exit_class)) ||
    !Array.isArray(report.diagnostics) ||
    !Array.isArray(report.artifacts) ||
    !Array.isArray(report.next_actions)
  ) {
    throw new Error("tidas_operation_report_invalid");
  }
  if (
    release &&
    (release.schema_version !== TIDAS_RELEASE_REPORT_SCHEMA ||
      release.action !== input.action ||
      typeof release.ok !== "boolean")
  ) {
    throw new Error("tidas_release_report_invalid");
  }
  if (
    input.successfulExit &&
    (report.status !== "succeeded" ||
      report.exit_class !== "success" ||
      !release ||
      release.ok !== true)
  ) {
    throw new Error("tidas_success_report_invalid");
  }
  return { report, release };
}

export async function runTidasReleaseAction(input: {
  action: string;
  args: string[];
  cwd: string;
}): Promise<TidasReleaseInvocation> {
  const executable = tidasExecutable();
  const version = await resolveTidasVersion({ executable, cwd: input.cwd });
  const args = [
    "release",
    input.action,
    ...input.args,
    "--format",
    "json",
    "--progress",
    "never",
  ];
  try {
    const value = await runJsonCommand({
      executable,
      args,
      cwd: input.cwd,
      env: localToolEnvironment(),
    });
    const parsed = assertOperationReport({
      value,
      action: input.action,
      successfulExit: true,
    });
    return {
      report: parsed.report as JsonValue,
      release: parsed.release,
      failed: false,
      exitCode: 0,
      version,
    };
  } catch (error) {
    if (error instanceof ExternalCommandError && error.result) {
      const parsed = assertOperationReport({
        value: error.result,
        action: input.action,
        successfulExit: false,
      });
      return {
        report: parsed.report as JsonValue,
        release: parsed.release,
        failed: true,
        code: error.code,
        exitCode: error.exitCode,
        version,
      };
    }
    throw error;
  }
}
