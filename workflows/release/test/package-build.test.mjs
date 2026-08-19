import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import {
  buildPackageCandidate,
  PACKAGE_PROFILE,
} from "../lib/package-build.mjs";
import {
  REPLY_TEMPLATE_COMMANDS,
  replyTemplateFor,
} from "../reply-template-registry.mjs";

const CALCULATION_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";
const UNIT_ID = "44444444-4444-4444-8444-444444444444";
const FLOW_ID = "55555555-5555-4555-8555-555555555555";
const VERSION = "01.00.000";
const REPOSITORY_ROOT = new URL("../../../", import.meta.url).pathname;

test("package build assembles local closure and delegates four-package build", async () => {
  const fixture = await createFixture();
  let observed;
  const result = await buildPackageCandidate({
    materializationDir: fixture.materialization,
    intakeDir: fixture.intake,
    outDir: fixture.output,
    runTool: async (request) => {
      observed = request;
      const index = JSON.parse(await readFile(request.indexPath, "utf8"));
      assert.equal(index.datasetCount, 4);
      assert.deepEqual(index.datasets.map((item) => item.path).sort(), [
        `flows/${FLOW_ID}_${VERSION}.json`,
        `lifecyclemodels/${MODEL_ID}_${VERSION}.json`,
        `processes/${RESULT_ID}_${VERSION}.json`,
        `processes/${UNIT_ID}_${VERSION}.json`,
      ]);
      await mkdir(request.packagesDir, { recursive: true });
      for (const name of [
        "unit-tidas.zip",
        "unit-eilcd.zip",
        "result-tidas.zip",
        "result-eilcd.zip",
      ])
        await writeFile(
          path.join(request.packagesDir, name),
          `fixture:${name}`,
        );
      return { ok: true, release: { outcome: "built", packageCount: 4 } };
    },
  });
  assert.equal(observed.tidasBin, "tidas");
  assert.equal(result.candidate.profile, PACKAGE_PROFILE);
  assert.equal(result.candidate.publicationAuthorized, false);
  assert.equal(result.candidate.packages.length, 4);
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(fixture.output, "release-candidate.json"),
        "utf8",
      ),
    ).validation.outcome,
    "passed",
  );
});

test("package build fails before tidas-tools when materialized bytes drift", async () => {
  const fixture = await createFixture();
  await writeFile(
    path.join(
      fixture.materialization,
      "canonical-datasets",
      "processes",
      `${RESULT_ID}_${VERSION}.json`,
    ),
    "{}\n",
  );
  let invoked = false;
  await assert.rejects(
    buildPackageCandidate({
      materializationDir: fixture.materialization,
      intakeDir: fixture.intake,
      outDir: fixture.output,
      runTool: async () => {
        invoked = true;
      },
    }),
    (error) => error.code === "materialized_dataset_hash_mismatch",
  );
  assert.equal(invoked, false);
});

test("CLI exposes one bounded local package build route", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /package build/);
  assert.match(help.stdout, /does not authorize/);
  assert.match(help.stdout, /Example:/);
  assert.match(help.stdout, /replyTemplate/);
  const unsupported = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--materialization",
      "/tmp/materialization",
      "--intake",
      "/tmp/intake",
      "--profile",
      "result-process-only.v1",
      "--out-dir",
      "/tmp/candidate",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(unsupported.status, 1);
  const unsupportedPayload = JSON.parse(unsupported.stderr);
  assert.equal(unsupportedPayload.error.code, "unsupported_package_profile");
  assert.equal(unsupportedPayload.command, "package build");
  assert.equal(unsupportedPayload.outcome, "command_failed");
  assert.equal(unsupportedPayload.completeness, "not_completed");
  assert.equal(unsupportedPayload.nextActions[0].kind, "inspect_usage");
  assert.equal(unsupportedPayload.replyTemplate.id, "release-command-failed");
});

test("CLI rejects unknown and duplicate options with actionable output", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  for (const [tokens, code] of [
    [["--unknown", "value", "--json"], "unknown_option"],
    [
      ["--profile", PACKAGE_PROFILE, "--profile", PACKAGE_PROFILE, "--json"],
      "duplicate_option",
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [cli.pathname, "package", "build", ...tokens],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.error.code, code);
    assert.equal(payload.nextActions[0].kind, "inspect_usage");
  }
});

test("CLI renders human failures separately from JSON mode", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [cli.pathname, "package", "build", "--unknown", "value"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Release command failed/);
  assert.match(result.stderr, /Summary:/);
  assert.match(result.stderr, /Next:/);
  assert.match(result.stderr, /Reply using template:/);
  assert.doesNotMatch(result.stderr, /^\{/);
});

test("every Release CLI outcome maps to an existing bounded reply template", async () => {
  assert.deepEqual(REPLY_TEMPLATE_COMMANDS, ["package build"]);
  for (const template of [
    replyTemplateFor("package build", { ok: true }),
    replyTemplateFor("package build", {
      ok: false,
      errorCode: "materialized_dataset_hash_mismatch",
    }),
    replyTemplateFor("package build", {
      ok: false,
      errorCode: "unsupported_package_profile",
    }),
  ]) {
    assert.ok(template.id);
    assert.ok(template.requiredFacts.length > 0);
    await access(path.resolve(REPOSITORY_ROOT, template.path));
  }
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-package-"));
  const materialization = path.join(root, "materialization");
  const intake = path.join(root, "intake");
  const output = path.join(root, "candidate");
  await mkdir(path.join(materialization, "canonical-datasets", "processes"), {
    recursive: true,
  });
  await mkdir(
    path.join(materialization, "canonical-datasets", "lifecyclemodels"),
    { recursive: true },
  );
  await mkdir(path.join(intake, "calculation-bundle", "source"), {
    recursive: true,
  });
  const resultDocument = { processDataSet: { id: RESULT_ID } };
  const modelDocument = { lifeCycleModelDataSet: { id: MODEL_ID } };
  const generated = [
    await generatedEntry(
      materialization,
      "process",
      "result_process",
      RESULT_ID,
      `canonical-datasets/processes/${RESULT_ID}_${VERSION}.json`,
      resultDocument,
    ),
    await generatedEntry(
      materialization,
      "lifecyclemodel",
      "lifecycle_model",
      MODEL_ID,
      `canonical-datasets/lifecyclemodels/${MODEL_ID}_${VERSION}.json`,
      modelDocument,
    ),
  ];
  const materializedIndex = buildIndex(generated);
  await writeFile(
    path.join(materialization, "canonical-dataset-index.json"),
    canonicalJson(materializedIndex),
  );
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    sourceRecord("flow", "support", FLOW_ID, { flowDataSet: { id: FLOW_ID } }),
  ];
  const sourceBytes = gzipSync(
    sourceRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  await writeFile(
    path.join(intake, "calculation-bundle", "source", "closure.ndjson.gz"),
    sourceBytes,
  );
  const intakeManifest = {
    schemaVersion: "tiangong.release.materialization-intake.v1",
    source: {
      adapter: "worker-calculation-bundle.v2",
      calculationId: CALCULATION_ID,
      bundleContentHash: "a".repeat(64),
      manifestSha256: "b".repeat(64),
    },
    artifacts: [
      {
        kind: "source_closure",
        path: "source/closure.ndjson.gz",
        sha256: sha256Bytes(sourceBytes),
        recordCount: sourceRecords.length,
      },
    ],
    verification: { manifest: "verified", artifacts: "verified" },
  };
  await writeFile(
    path.join(intake, "intake-manifest.json"),
    canonicalJson(intakeManifest),
  );
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    completeness: "complete-for-selected-roots",
    inputs: {
      calculationId: CALCULATION_ID,
      bundleContentHash: "a".repeat(64),
      intakeManifestSha256: hashJson(intakeManifest),
      canonicalDatasetIndexSha256: hashJson(materializedIndex),
    },
    profiles: { result: "lci-lcia-result.v2", model: "resolved-one-hop.v1" },
    datasets: generated,
    validation: {},
  };
  await writeFile(
    path.join(materialization, "materialization-manifest.json"),
    canonicalJson(manifest),
  );
  return { root, materialization, intake, output };
}

async function generatedEntry(
  root,
  datasetType,
  role,
  uuid,
  relativePath,
  document,
) {
  const content = canonicalJson(document);
  await writeFile(path.join(root, relativePath), content);
  return {
    datasetType,
    role,
    uuid,
    version: VERSION,
    path: relativePath,
    sha256: sha256Bytes(Buffer.from(content)),
    byteSize: Buffer.byteLength(content),
    canonicalContentHash: hashJson(document),
  };
}

function sourceRecord(datasetType, role, uuid, document) {
  return {
    schemaVersion: "tiangong.source-closure.dataset.v1",
    datasetType,
    role,
    uuid,
    version: VERSION,
    path: `${category(datasetType)}/${uuid}_${VERSION}.json`,
    sha256: hashJson(document),
    document,
  };
}

function category(datasetType) {
  return datasetType === "process" ? "processes" : `${datasetType}s`;
}

function buildIndex(datasets) {
  const ordered = [...datasets].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: ordered.length,
    byteSize: ordered.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: hashJson(
      ordered.map(({ datasetType, uuid, version, path: itemPath, sha256 }) => ({
        datasetType,
        uuid,
        version,
        path: itemPath,
        sha256,
      })),
    ),
    datasets: ordered,
  };
}
