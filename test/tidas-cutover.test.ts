import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { localToolEnvironment } from "../src/tools/external.js";
import { runTidasReleaseAction, tidasExecutable } from "../src/tools/tidas.js";

test("the active adapter ignores legacy executable and Python environment paths", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/native/bin",
    TIANGONG_TIDAS_EXECUTABLE: "/native/bin/tidas",
    TIANGONG_TIDAS_TOOLS_EXECUTABLE: "/legacy/tidas-release-tool",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  assert.equal(tidasExecutable(source), "/native/bin/tidas");
  assert.deepEqual(localToolEnvironment(source), { PATH: "/native/bin" });
});

test("a clean PATH with only the native tidas fixture completes without Python fallback", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-clean-"));
  const bin = path.join(root, "bin");
  const input = path.join(root, "canonical");
  mkdirSync(bin);
  mkdirSync(input);
  symlinkSync(process.execPath, path.join(bin, "node"));
  const executable = path.join(bin, "tidas");
  copyFileSync(
    fileURLToPath(new URL("./fixtures/fake-tidas.mjs", import.meta.url)),
    executable,
  );
  chmodSync(executable, 0o755);

  const names = [
    "PATH",
    "TIANGONG_TIDAS_EXECUTABLE",
    "TIANGONG_TIDAS_TOOLS_EXECUTABLE",
    "PYTHONUTF8",
    "PYTHONIOENCODING",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PATH = bin;
    delete process.env.TIANGONG_TIDAS_EXECUTABLE;
    process.env.TIANGONG_TIDAS_TOOLS_EXECUTABLE = "/missing/tidas-release-tool";
    process.env.PYTHONUTF8 = "1";
    process.env.PYTHONIOENCODING = "utf-8";
    const result = await runTidasReleaseAction({
      action: "validate-tidas",
      args: ["--input-dir", input],
      cwd: root,
    });
    assert.equal(result.failed, false);
    assert.equal(result.version, "0.1.0-fixture");
    assert.equal(
      (result.report as Record<string, any>).schema_version,
      "tidas.operation-report.v1",
    );
    assert.equal(result.release?.schema_version, "tidas.release-report.v1");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the adapter preserves every stable nonzero Rust exit class", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-exits-"));
  const input = path.join(root, "canonical");
  mkdirSync(input);
  const fixture = fileURLToPath(
    new URL("./fixtures/fake-tidas.mjs", import.meta.url),
  );
  const previousExecutable = process.env.TIANGONG_TIDAS_EXECUTABLE;
  const cases = [
    ["data-issues", 2, "completed-with-issues"],
    ["usage", 64, "failed"],
    ["unavailable", 69, "failed"],
    ["internal", 70, "failed"],
    ["io", 74, "failed"],
    ["cancelled", 130, "cancelled"],
  ] as const;
  try {
    for (const [exitClass, exitCode, status] of cases) {
      const executable = path.join(root, `tidas-exit-${exitClass}`);
      copyFileSync(fixture, executable);
      chmodSync(executable, 0o755);
      process.env.TIANGONG_TIDAS_EXECUTABLE = executable;
      const result = await runTidasReleaseAction({
        action: "validate-tidas",
        args: ["--input-dir", input],
        cwd: root,
      });
      assert.equal(result.failed, true, exitClass);
      assert.equal(result.exitCode, exitCode, exitClass);
      assert.equal(result.code, `release_${exitClass.replace("-", "_")}`);
      const report = result.report as Record<string, any>;
      assert.equal(report.status, status, exitClass);
      assert.equal(report.exit_class, exitClass, exitClass);
    }
  } finally {
    if (previousExecutable === undefined) {
      delete process.env.TIANGONG_TIDAS_EXECUTABLE;
    } else {
      process.env.TIANGONG_TIDAS_EXECUTABLE = previousExecutable;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
