import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

export const DATA_PLANE_ENV_KEYS = Object.freeze([
  "CONN",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
]);

export class EnvironmentBootstrapError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "EnvironmentBootstrapError";
    this.code = code;
    this.details = details;
  }
}

export async function syncDataPlaneEnvironment({ source, target }) {
  if (path.resolve(source) === path.resolve(target))
    throw new EnvironmentBootstrapError(
      "invalid_request",
      "Workspace and Release environment files must be different paths",
    );
  let sourceText;
  try {
    sourceText = await readFile(source, "utf8");
  } catch (error) {
    throw new EnvironmentBootstrapError(
      "workspace_env_unavailable",
      "Workspace environment file could not be read",
      { source, cause: error instanceof Error ? error.code : "unknown" },
    );
  }
  const sourceValues = parseEnv(sourceText);
  let targetText = "";
  try {
    targetText = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const targetValues = parseEnv(targetText);
  const copiedKeys = [];
  const preservedKeys = [];
  const missingSourceKeys = [];
  const additions = [];
  for (const key of DATA_PLANE_ENV_KEYS) {
    if (targetValues[key]?.trim()) {
      preservedKeys.push(key);
      continue;
    }
    if (!sourceValues[key]?.trim()) {
      missingSourceKeys.push(key);
      continue;
    }
    additions.push(`${key}=${sourceValues[key]}`);
    copiedKeys.push(key);
  }
  if (additions.length) {
    const prefix = targetText && !targetText.endsWith("\n") ? "\n" : "";
    const heading = targetText.includes("# Release data-plane environment")
      ? ""
      : "# Release data-plane environment (copied from workspace; local and ignored)\n";
    const next = `${targetText}${prefix}${heading}${additions.join("\n")}\n`;
    const temporary = `${target}.tmp-${process.pid}`;
    await writeFile(temporary, next, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  }
  return {
    source,
    target,
    copiedKeys,
    preservedKeys,
    missingSourceKeys,
    valuesExposed: false,
  };
}
