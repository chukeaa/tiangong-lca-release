import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { canonicalJson, hashJson, sha256Bytes } from "../lib/common.mjs";
import { inspectFlowCache } from "../lib/flow-cache.mjs";
import {
  buildPackageCandidate,
  PACKAGE_PROFILE,
  verifyBuiltPackages,
} from "../lib/package-build.mjs";
import { prepareReleaseIntake } from "../lib/release-intake.mjs";
import {
  REPLY_TEMPLATE_COMMANDS,
  replyTemplateFor,
} from "../reply-template-registry.mjs";

const CALCULATION_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";
const UNIT_ID = "44444444-4444-4444-8444-444444444444";
const FLOW_ID = "55555555-5555-4555-8555-555555555555";
const METHOD_ID = "66666666-6666-4666-8666-666666666666";
const VERSION = "01.00.000";
const REPOSITORY_ROOT = new URL("../../../", import.meta.url).pathname;
const RELEASE_VERSION = "2026.08.0";

test("shared Elementary Flow cache distinguishes fresh and stale watermarks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-flow-cache-"));
  const artifactText = `${JSON.stringify({ datasetType: "flow", uuid: FLOW_ID, version: VERSION, document: {} })}\n`;
  await writeFile(path.join(root, "elementary-flows.ndjson"), artifactText);
  await writeFile(
    path.join(root, "cache-manifest.json"),
    canonicalJson({
      schemaVersion: "tiangong.release.elementary-flow-cache.v1",
      databaseWatermark: {
        publishedCount: 1,
        maxModifiedAt: "2026-08-19 00:00:00+00",
      },
      artifact: {
        path: "elementary-flows.ndjson",
        sha256: sha256Bytes(Buffer.from(artifactText)),
        recordCount: 1,
      },
      createdAt: "2026-08-19T00:00:00.000Z",
    }),
  );
  const poolFactory = (maxModifiedAt) => () => ({
    async query() {
      return {
        rows: [{ published_count: "1", max_modified_at: maxModifiedAt }],
      };
    },
    async end() {},
  });
  assert.equal(
    (
      await inspectFlowCache({
        cacheDir: root,
        poolFactory: poolFactory("2026-08-19 00:00:00+00"),
      })
    ).status,
    "fresh",
  );
  assert.equal(
    (
      await inspectFlowCache({
        cacheDir: root,
        poolFactory: poolFactory("2026-08-19 00:00:01+00"),
      })
    ).status,
    "stale",
  );
});

test("package build assembles local closure and delegates four-package build", async () => {
  const fixture = await createFixture();
  let observed;
  const result = await buildPackageCandidate({
    releaseIntakeDir: fixture.releaseIntake,
    outDir: fixture.output,
    releaseVersion: RELEASE_VERSION,
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
        "unit-process-full-closure.v1.tidas.zip",
        "unit-process-full-closure.v1.ilcd.zip",
        "standalone-lifecyclemodel-result-full-closure.v1.tidas.zip",
        "standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip",
      ])
        await writeFile(
          path.join(request.packagesDir, name),
          `fixture:${name}`,
        );
      return { ok: true, release: { outcome: "built", packageCount: 4 } };
    },
    verifyTool: async ({ packagesDir, releaseVersion }) => {
      assert.equal(releaseVersion, RELEASE_VERSION);
      assert.deepEqual((await readdir(packagesDir)).sort(), [
        `TiangongLCA-${RELEASE_VERSION}-ResultDatabase.ilcd.zip`,
        `TiangongLCA-${RELEASE_VERSION}-ResultDatabase.tidas.zip`,
        `TiangongLCA-${RELEASE_VERSION}-UnitProcessDatabase.ilcd.zip`,
        `TiangongLCA-${RELEASE_VERSION}-UnitProcessDatabase.tidas.zip`,
      ]);
      return {
        schemaVersion: "tiangong.release.package-verification.v1",
        releaseVersion,
        outcome: "passed",
        packages: [],
      };
    },
  });
  assert.equal(observed.tidasBin, "tidas");
  assert.equal(result.candidate.profile, PACKAGE_PROFILE);
  assert.equal(result.candidate.releaseVersion, RELEASE_VERSION);
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
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(fixture.output, "package-verification-report.json"),
        "utf8",
      ),
    ).outcome,
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
      releaseIntakeDir: fixture.releaseIntake,
      outDir: fixture.output,
      releaseVersion: RELEASE_VERSION,
      runTool: async () => {
        invoked = true;
      },
    }),
    (error) => error.code === "materialized_dataset_hash_mismatch",
  );
  assert.equal(invoked, false);
});

test("Release Intake expands exact LCIA Method Flow dependencies without mutating source intake", async () => {
  const fixture = await createFixture();
  const method = sourceRecord("lciamethod", "support", METHOD_ID, {
    LCIAMethodDataSet: {
      characterisationFactors: {
        factor: [
          {
            referenceToFlowDataSet: {
              "@type": "flow data set",
              "@refObjectId": FLOW_ID,
              "@version": VERSION,
            },
          },
        ],
      },
    },
  });
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    method,
  ];
  const sourceBytes = gzipSync(
    `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const sourcePath = path.join(
    fixture.intake,
    "calculation-bundle",
    "source",
    "closure.ndjson.gz",
  );
  await writeFile(sourcePath, sourceBytes);
  const intakeManifestPath = path.join(fixture.intake, "intake-manifest.json");
  const intakeManifest = JSON.parse(await readFile(intakeManifestPath, "utf8"));
  intakeManifest.artifacts[0].sha256 = sha256Bytes(sourceBytes);
  intakeManifest.artifacts[0].recordCount = sourceRecords.length;
  await writeFile(intakeManifestPath, canonicalJson(intakeManifest));
  const materializationManifestPath = path.join(
    fixture.materialization,
    "materialization-manifest.json",
  );
  const materializationManifest = JSON.parse(
    await readFile(materializationManifestPath, "utf8"),
  );
  materializationManifest.inputs.intakeManifestSha256 =
    hashJson(intakeManifest);
  await writeFile(
    materializationManifestPath,
    canonicalJson(materializationManifest),
  );
  const target = path.join(
    fixture.root,
    "new-release-intakes",
    "release-intake-expanded",
  );
  const cacheArtifact = path.join(fixture.root, "elementary-flows.ndjson");
  await writeFile(
    cacheArtifact,
    `${JSON.stringify(sourceRecord("flow", "support", FLOW_ID, { flowDataSet: { id: FLOW_ID } }))}\n`,
  );
  const result = await prepareReleaseIntake({
    materializationDir: fixture.materialization,
    sourceIntakeDir: fixture.intake,
    outDir: target,
    cacheLoader: async () => ({
      artifact: cacheArtifact,
      manifest: { artifact: { recordCount: 93_996 } },
    }),
  });
  assert.equal(result.report.addedExactFlowCount, 1);
  assert.equal(result.report.uniqueReferenceCount, 1);
  const dependencyText = await readFile(
    path.join(target, "dependencies", "lcia-method-flows.ndjson"),
    "utf8",
  );
  assert.match(dependencyText, new RegExp(FLOW_ID, "u"));
  assert.equal(
    JSON.parse(await readFile(intakeManifestPath, "utf8")).artifacts[0]
      .recordCount,
    2,
  );
});

test("Release Intake fails closed when an exact LCIA Method Flow is unavailable", async () => {
  const fixture = await createFixture();
  await configureMissingMethodFlow(fixture);
  await assert.rejects(
    prepareReleaseIntake({
      materializationDir: fixture.materialization,
      sourceIntakeDir: fixture.intake,
      outDir: path.join(fixture.root, "release-intake-missing-flow"),
      cacheLoader: async () => {
        const artifact = path.join(fixture.root, "empty-cache.ndjson");
        await writeFile(artifact, "");
        return { artifact, manifest: { artifact: { recordCount: 0 } } };
      },
    }),
    (error) =>
      error.code === "release_intake_exact_flow_missing" &&
      error.details.uuid === FLOW_ID &&
      error.details.version === VERSION,
  );
});

test("release version is filename-safe before any input is read", async () => {
  await assert.rejects(
    buildPackageCandidate({
      releaseIntakeDir: "/missing/release-intake",
      outDir: "/missing/output",
      releaseVersion: "../latest",
    }),
    (error) => error.code === "release_version_invalid",
  );
});

test("final distribution ZIPs are independently extracted and validated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-readback-"));
  const packagesDir = path.join(root, "packages");
  await mkdir(packagesDir);
  for (const product of ["UnitProcessDatabase", "ResultDatabase"])
    for (const format of ["tidas", "ilcd"])
      await writeFile(
        path.join(
          packagesDir,
          `TiangongLCA-${RELEASE_VERSION}-${product}.${format}.zip`,
        ),
        `${product}:${format}`,
      );
  const calls = [];
  const report = await verifyBuiltPackages({
    tidasBin: "/tools/tidas",
    packagesDir,
    workspace: root,
    releaseVersion: RELEASE_VERSION,
    spawnCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "unzip" && args[0] === "-Z1")
        return { code: 0, stdout: "data/example.json\n", stderr: "" };
      if (command === "unzip") return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, summary: { release: {} } }),
        stderr: "",
      };
    },
  });
  assert.equal(report.outcome, "passed");
  assert.equal(report.packages.length, 4);
  assert.equal(calls.filter(([command]) => command === "unzip").length, 8);
  assert.deepEqual(
    calls
      .filter(([command]) => command === "/tools/tidas")
      .map(([, , action]) => action)
      .sort(),
    ["validate-ilcd", "validate-ilcd", "validate-tidas", "validate-tidas"],
  );
});

test("CLI exposes one bounded local package build route", () => {
  const cli = new URL("../cli.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [cli.pathname, "--help"], {
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /package build/);
  assert.match(help.stdout, /does not authorize/);
  assert.match(help.stdout, /Examples:/);
  assert.match(help.stdout, /replyTemplate/);
  const unsupported = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      "/tmp/release-intake",
      "--profile",
      "result-process-only.v1",
      "--release-version",
      RELEASE_VERSION,
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

  const confirmation = spawnSync(
    process.execPath,
    [
      cli.pathname,
      "package",
      "build",
      "--release-intake",
      "/tmp/release-intake",
      "--profile",
      PACKAGE_PROFILE,
      "--out-dir",
      "/tmp/candidate",
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(confirmation.status, 0);
  const confirmationPayload = JSON.parse(confirmation.stdout);
  assert.equal(
    confirmationPayload.outcome,
    "release_version_confirmation_required",
  );
  assert.equal(confirmationPayload.completeness, "awaiting_user_confirmation");
  assert.match(confirmationPayload.recommendedVersion, /^\d{4}\.\d{2}\.0$/u);
  assert.equal(confirmationPayload.fileNames.length, 4);
  assert.equal(
    confirmationPayload.replyTemplate.id,
    "release-version-confirmation-required",
  );
  assert.ok(
    confirmationPayload.nextActions[0].argv.includes("--release-version"),
  );
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
  assert.deepEqual(REPLY_TEMPLATE_COMMANDS, [
    "cache status",
    "cache refresh",
    "intake prepare",
    "package build",
  ]);
  for (const template of [
    replyTemplateFor("intake prepare", { ok: true }),
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
  const releaseIntake = path.join(root, "release-intake");
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
  await prepareReleaseIntake({
    materializationDir: materialization,
    sourceIntakeDir: intake,
    outDir: releaseIntake,
  });
  return { root, materialization, intake, releaseIntake, output };
}

async function configureMissingMethodFlow(fixture) {
  const sourceRecords = [
    sourceRecord("process", "unit_process", UNIT_ID, {
      processDataSet: { id: UNIT_ID },
    }),
    sourceRecord("lciamethod", "support", METHOD_ID, {
      LCIAMethodDataSet: {
        characterisationFactors: {
          factor: [
            {
              referenceToFlowDataSet: {
                "@type": "flow data set",
                "@refObjectId": FLOW_ID,
                "@version": VERSION,
              },
            },
          ],
        },
      },
    }),
  ];
  const sourceBytes = gzipSync(
    `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await writeFile(
    path.join(
      fixture.intake,
      "calculation-bundle",
      "source",
      "closure.ndjson.gz",
    ),
    sourceBytes,
  );
  const intakePath = path.join(fixture.intake, "intake-manifest.json");
  const intake = JSON.parse(await readFile(intakePath, "utf8"));
  intake.artifacts[0].sha256 = sha256Bytes(sourceBytes);
  intake.artifacts[0].recordCount = sourceRecords.length;
  await writeFile(intakePath, canonicalJson(intake));
  const manifestPath = path.join(
    fixture.materialization,
    "materialization-manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.inputs.intakeManifestSha256 = hashJson(intake);
  await writeFile(manifestPath, canonicalJson(manifest));
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
