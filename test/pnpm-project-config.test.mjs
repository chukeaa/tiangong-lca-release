import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PNPM_INVOCATION = resolvePnpmInvocation(process.env.npm_execpath);

test("pnpm reads the repository policy from project configuration", () => {
  const result = spawnSync(
    PNPM_INVOCATION.command,
    [
      ...PNPM_INVOCATION.prefixArgs,
      "config",
      "list",
      "--location=project",
      "--json",
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      shell: false,
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const effectiveConfig = JSON.parse(result.stdout);
  assert.equal(effectiveConfig.engineStrict, true);
  assert.equal(effectiveConfig.strictPeerDependencies, true);
  assert.equal(effectiveConfig.sharedWorkspaceLockfile, true);
  assert.equal(effectiveConfig.savePrefix, "");
  assert.equal(effectiveConfig.pmOnFail, "error");
});
