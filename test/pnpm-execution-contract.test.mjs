import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const GRAPH_AUDIT = fileURLToPath(
  new URL("./production-dependency-graph.test.mjs", import.meta.url),
);

test("the graph audit executes the resolved pnpm entry without a shell", () => {
  const source = readFileSync(GRAPH_AUDIT, "utf8");
  assert.match(source, /process\.env\.npm_execpath/);
  assert.match(source, /resolvePnpmInvocation\(process\.env\.npm_execpath\)/);
  assert.match(source, /spawnSync\(\s*PNPM_INVOCATION\.command,/s);
  assert.match(source, /\.\.\.PNPM_INVOCATION\.prefixArgs/);
  assert.match(source, /shell:\s*false/);
  assert.doesNotMatch(source, /spawnSync\(\s*["'`]pnpm(?:\.cmd)?["'`]/s);
});

test("the graph audit fails closed outside a pnpm-run contract", () => {
  const environment = { ...process.env };
  delete environment.npm_execpath;
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", GRAPH_AUDIT], {
    encoding: "utf8",
    env: environment,
    shell: false,
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /pnpm execution contract is unavailable: npm_execpath is missing/,
  );
});
