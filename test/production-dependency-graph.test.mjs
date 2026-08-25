import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGE_DIRECTORIES = [
  ".",
  "workflows/calculation",
  "workflows/result-materialization",
  "workflows/release-candidate",
  "workflows/publication",
];
const RETIRED_PRODUCTION_PACKAGES = new Set([
  "typescript",
  "ts-to-zod",
  "@typescript/vfs",
]);

test("the installed production graph uses SDK 0.2.0 without retired compiler/codegen", () => {
  const installed = [];
  for (const directory of PACKAGE_DIRECTORIES) {
    const result = spawnSync(
      "pnpm",
      ["list", "--prod", "--depth", "Infinity", "--json"],
      {
        cwd: path.join(REPOSITORY_ROOT, directory),
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const root of JSON.parse(result.stdout))
      collectDependencies(root, installed);
  }

  const retired = installed
    .filter((dependency) => RETIRED_PRODUCTION_PACKAGES.has(dependency.name))
    .map(({ name, version }) => `${name}@${version}`)
    .sort();
  const sdkVersions = [
    ...new Set(
      installed
        .filter(({ name }) => name === "@tiangong-lca/tidas-sdk")
        .map(({ version }) => version),
    ),
  ].sort();

  assert.deepEqual(sdkVersions, ["0.2.0"]);
  assert.deepEqual(retired, []);
});

function collectDependencies(node, collected) {
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    const item = { name, version: dependency.version ?? "unknown" };
    collected.push(item);
    collectDependencies(dependency, collected);
  }
}
