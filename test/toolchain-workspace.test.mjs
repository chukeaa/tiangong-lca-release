import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKSPACE_PACKAGES = [
  "workflows/calculation",
  "workflows/result-materialization",
  "workflows/release-candidate",
  "workflows/publication",
];
const PACKAGE_MANIFESTS = [".", ...WORKSPACE_PACKAGES];

test("the repository pins one exact Node and pnpm toolchain", () => {
  const rootManifest = readJson("package.json");
  assert.equal(rootManifest.packageManager, "pnpm@11.23.0");
  assert.equal(readText(".node-version").trim(), "24.19.0");

  for (const directory of PACKAGE_MANIFESTS) {
    const relativePath = path.join(directory, "package.json");
    const manifest = readJson(relativePath);
    assert.equal(
      manifest.engines?.node,
      "24.19.0",
      `${relativePath} must reject every other Node release`,
    );
  }
});

test("the five install trees are one pnpm workspace with one lockfile", () => {
  const workspace = readText("pnpm-workspace.yaml");
  for (const packagePath of WORKSPACE_PACKAGES) {
    assert.match(workspace, new RegExp(escapeRegex(packagePath)));
  }

  const packageLocks = findFiles(REPOSITORY_ROOT, "package-lock.json");
  const pnpmLocks = findFiles(REPOSITORY_ROOT, "pnpm-lock.yaml");
  assert.deepEqual(packageLocks, []);
  assert.deepEqual(pnpmLocks, [path.join(REPOSITORY_ROOT, "pnpm-lock.yaml")]);
});

test("active package commands and automation are pnpm-only", () => {
  for (const directory of PACKAGE_MANIFESTS) {
    const relativePath = path.join(directory, "package.json");
    const scripts = JSON.stringify(readJson(relativePath).scripts ?? {});
    assert.doesNotMatch(scripts, /(^|[\s"'])npm(?=\s|$)/m, relativePath);
  }

  for (const relativePath of [
    "AGENTS.md",
    "workflows/result-materialization/AGENTS.md",
    "workflows/result-materialization/README.md",
    "workflows/release-candidate/README.md",
    "workflows/publication/README.md",
  ]) {
    assert.doesNotMatch(
      readText(relativePath),
      /(^|\s)npm(?:\s+(?:ci|install|run)|\s+--prefix)/m,
      relativePath,
    );
  }

  const ci = readText(".github/workflows/ci.yml");
  assert.match(ci, /node-version:\s*["']24\.19\.0["']/);
  assert.match(
    ci,
    /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6/,
  );
  assert.match(
    ci,
    /pnpm\/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa # v4/,
  );
  assert.match(
    ci,
    /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6/,
  );
  assert.match(ci, /version:\s*11\.23\.0/);
  assert.match(ci, /cache:\s*pnpm/);
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.match(ci, /pnpm run prepush:gate/);
  assert.doesNotMatch(ci, /(^|\s)npm(?:\s|$)/m);
});

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readText(relativePath) {
  return readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

function findFiles(directory, basename) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", ".release", "node_modules"].includes(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(absolutePath, basename));
    else if (entry.name === basename) matches.push(absolutePath);
  }
  return matches.sort();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
