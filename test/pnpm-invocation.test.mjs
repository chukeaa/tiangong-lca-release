import assert from "node:assert/strict";
import test from "node:test";
import { resolvePnpmInvocation } from "./pnpm-invocation.mjs";

const exists = () => true;

test("pnpm invocation supports Corepack JavaScript and pnpm/setup executables without a shell", () => {
  assert.deepEqual(
    resolvePnpmInvocation("/tooling/pnpm.cjs", {
      execPath: "/runtime/node",
      fileExists: exists,
      platform: "linux",
    }),
    { command: "/runtime/node", prefixArgs: ["/tooling/pnpm.cjs"] },
  );
  assert.deepEqual(
    resolvePnpmInvocation("/home/runner/setup-pnpm/pnpm", {
      execPath: "/runtime/node",
      fileExists: exists,
      platform: "linux",
    }),
    { command: "/home/runner/setup-pnpm/pnpm", prefixArgs: [] },
  );
  assert.deepEqual(
    resolvePnpmInvocation("pnpm", {
      execPath: "/runtime/node",
      fileExists: (candidate) =>
        candidate === "/home/runner/setup-pnpm/pnpm",
      platform: "linux",
      pnpmHome: "/home/runner/setup-pnpm",
    }),
    { command: "/home/runner/setup-pnpm/pnpm", prefixArgs: [] },
  );
  assert.deepEqual(
    resolvePnpmInvocation("C:\\setup-pnpm\\pnpm.exe", {
      execPath: "C:\\node\\node.exe",
      fileExists: exists,
      platform: "win32",
    }),
    { command: "C:\\setup-pnpm\\pnpm.exe", prefixArgs: [] },
  );
  assert.deepEqual(
    resolvePnpmInvocation("pnpm", {
      execPath: "C:\\node\\node.exe",
      fileExists: (candidate) =>
        candidate === "C:\\setup-pnpm\\pnpm.exe",
      platform: "win32",
      pnpmHome: "C:\\setup-pnpm",
    }),
    { command: "C:\\setup-pnpm\\pnpm.exe", prefixArgs: [] },
  );
});

test("pnpm invocation rejects missing, nonexistent, and command-shell shims", () => {
  assert.throws(
    () => resolvePnpmInvocation(undefined, { fileExists: exists }),
    /npm_execpath is missing/,
  );
  assert.throws(
    () =>
      resolvePnpmInvocation("/missing/pnpm", {
        fileExists: () => false,
        platform: "linux",
      }),
    /npm_execpath is not a readable file/,
  );
  assert.throws(
    () =>
      resolvePnpmInvocation("C:\\setup-pnpm\\pnpm.cmd", {
        fileExists: exists,
        platform: "win32",
      }),
    /does not identify a supported pnpm entry/,
  );
});
