import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeReleaseCli } from "../src/cli.js";
import { createCalculationBundleFixture } from "./support/bundle-fixture.js";

test("CLI exposes stable JSON init, status, next, and error output", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "tiangong-release-cli-"));
  try {
    const fixture = createCalculationBundleFixture(root);
    const input = path.join(root, "request.json");
    const runDirectory = path.join(root, "run");
    writeFileSync(
      input,
      `${JSON.stringify(fixture.request, null, 2)}\n`,
      "utf8",
    );

    const initialized = await executeReleaseCli([
      "init",
      "--input",
      input,
      "--out-dir",
      runDirectory,
      "--json",
    ]);
    assert.equal(initialized.exitCode, 0);
    const initBody = JSON.parse(initialized.stdout) as Record<string, unknown>;
    assert.equal(initBody.schemaVersion, "tiangong.release-status.v1");
    assert.equal(initBody.nextStage, "resolve-calculation-bundle");

    const next = await executeReleaseCli([
      "next",
      "--run-dir",
      runDirectory,
      "--json",
    ]);
    assert.equal(next.exitCode, 0);
    assert.match(next.stdout, /tiangong\.release-next\.v1/);

    const unknown = await executeReleaseCli(["surprise"]);
    assert.equal(unknown.exitCode, 1);
    assert.equal(unknown.stdout, "");
    assert.match(unknown.stderr, /unknown_command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
