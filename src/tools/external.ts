import { spawn } from "node:child_process";
import type { JsonValue } from "../contracts/json.js";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class ExternalCommandError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly result: JsonValue | null;

  constructor(input: {
    code: string;
    message: string;
    exitCode?: number | null;
    result?: JsonValue | null;
  }) {
    super(input.message);
    this.name = "ExternalCommandError";
    this.code = input.code;
    this.exitCode = input.exitCode ?? null;
    this.result = input.result ?? null;
  }
}

export async function runJsonCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<JsonValue & { status?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      reject(
        new ExternalCommandError({
          code: "external_command_spawn_failed",
          message: `${input.executable}: ${error.message}`,
        }),
      );
    });
    child.on("close", (exitCode) => {
      if (overflow) {
        reject(
          new ExternalCommandError({
            code: "external_command_output_too_large",
            message: `${input.executable} exceeded ${MAX_CAPTURE_BYTES} captured bytes.`,
            exitCode,
          }),
        );
        return;
      }
      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();
      const parseResult = (text: string) => {
        if (!text) return null;
        try {
          return JSON.parse(text) as JsonValue & { status?: string };
        } catch {
          return null;
        }
      };
      let result = parseResult(stdoutText);
      if (exitCode !== 0) {
        result ??= parseResult(stderrText);
        const record = (result ?? {}) as Record<string, any>;
        const code = String(
          record.error?.code ?? record.code ?? "external_command_failed",
        );
        const message = String(
          (record.error?.message ?? record.message ?? stderrText) ||
            `${input.executable} failed.`,
        );
        reject(new ExternalCommandError({ code, message, exitCode, result }));
        return;
      }
      if (!result) {
        reject(
          new ExternalCommandError({
            code: "external_command_json_invalid",
            message: `${input.executable} returned non-JSON stdout.`,
            exitCode,
          }),
        );
        return;
      }
      if (result.status === "failed") {
        const record = result as Record<string, any>;
        const code = String(record.error?.code ?? "external_command_failed");
        const message = String(
          (record.error?.message ?? stderrText) ||
            `${input.executable} failed.`,
        );
        reject(new ExternalCommandError({ code, message, exitCode, result }));
        return;
      }
      resolve(result);
    });
  });
}

export async function runTextCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      reject(
        new ExternalCommandError({
          code: "external_command_spawn_failed",
          message: `${input.executable}: ${error.message}`,
        }),
      );
    });
    child.on("close", (exitCode) => {
      if (overflow) {
        reject(
          new ExternalCommandError({
            code: "external_command_output_too_large",
            message: `${input.executable} exceeded ${MAX_CAPTURE_BYTES} captured bytes.`,
            exitCode,
          }),
        );
        return;
      }
      const result = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (result.exitCode !== 0) {
        reject(
          new ExternalCommandError({
            code: "external_command_failed",
            message:
              result.stderr ||
              `${input.executable} exited with ${result.exitCode}.`,
            exitCode,
          }),
        );
        return;
      }
      resolve(result);
    });
  });
}

export function localToolEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function tidasToolsExecutable(): string {
  return (
    process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE?.trim() || "tidas-release-tool"
  );
}

export function tiangongCliExecutable(): string {
  return process.env.TIANGONG_LCA_CLI_EXECUTABLE?.trim() || "tiangong-lca";
}
