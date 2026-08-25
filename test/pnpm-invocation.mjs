import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePnpmInvocation(
  value,
  {
    execPath = process.execPath,
    fileExists = existsSync,
    platform = process.platform,
  } = {},
) {
  const entry = value?.trim();
  if (!entry) {
    throw new Error(
      "pnpm execution contract is unavailable: npm_execpath is missing",
    );
  }
  if (!fileExists(entry)) {
    throw new Error(
      "pnpm execution contract is unavailable: npm_execpath is not a readable file",
    );
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const basename = pathApi.basename(entry).toLowerCase();
  if (["pnpm.cjs", "pnpm.js", "pnpm.mjs"].includes(basename)) {
    return { command: execPath, prefixArgs: [entry] };
  }
  if (
    (platform === "win32" && basename === "pnpm.exe") ||
    (platform !== "win32" && basename === "pnpm")
  ) {
    return { command: entry, prefixArgs: [] };
  }
  throw new Error(
    `pnpm execution contract is unavailable: npm_execpath does not identify a supported pnpm entry (${basename || "unknown"})`,
  );
}
