import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";
import { requireFreshFlowCache } from "./flow-cache.mjs";
import { readNdjson } from "./records.mjs";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^\d{2}\.\d{2}\.\d{3}$/;
const DEFAULT_LIMIT = 100_000;

export async function prepareReleaseIntake({
  materializationDir,
  sourceIntakeDir,
  outDir,
  flowCacheDir,
  env = process.env,
  cacheLoader = requireFreshFlowCache,
  dependencyLimit = DEFAULT_LIMIT,
}) {
  const materializationRoot = path.resolve(materializationDir);
  const sourceIntakeRoot = path.resolve(sourceIntakeDir);
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    const materializationManifest = await readJson(
      path.join(materializationRoot, "materialization-manifest.json"),
      "materialization_manifest_missing",
    );
    const materializedIndex = await readJson(
      path.join(materializationRoot, "canonical-dataset-index.json"),
      "canonical_index_missing",
    );
    const sourceIntake = await readJson(
      path.join(sourceIntakeRoot, "intake-manifest.json"),
      "intake_manifest_missing",
    );
    validateUpstream(materializationManifest, materializedIndex, sourceIntake);

    const scan = await scanMethodFlowReferences(sourceIntakeRoot, sourceIntake);
    const missing = scan.references.filter(
      (reference) => !scan.sourceIdentities.has(identityKey(reference)),
    );
    if (missing.length > dependencyLimit)
      fail(
        "release_intake_dependency_limit_exceeded",
        `LCIA Method Flow expansion requires ${missing.length} datasets; limit is ${dependencyLimit}`,
        { required: missing.length, limit: dependencyLimit },
      );

    const records = [];
    let elementaryFlowCacheRecordCount = 0;
    let elementaryFlowCacheManifestSha256 = null;
    if (missing.length) {
      const cache = await cacheLoader({ cacheDir: flowCacheDir, env });
      elementaryFlowCacheRecordCount = cache.manifest.artifact.recordCount;
      elementaryFlowCacheManifestSha256 = hashJson(cache.manifest);
      const wanted = new Map(
        missing.map((entry) => [identityKey(entry), entry]),
      );
      for await (const record of readNdjson(cache.artifact)) {
        if (wanted.delete(identityKey(record)))
          records.push(
            flowRecord(record.uuid, record.version, record.document),
          );
      }
      if (wanted.size) {
        const unresolved = [...wanted.values()].sort((left, right) =>
          identityKey(left).localeCompare(identityKey(right)),
        )[0];
        fail(
          "release_intake_exact_flow_missing",
          `Exact published Elementary Flow dependency is unavailable in the fresh cache: ${unresolved.uuid}@${unresolved.version}`,
          unresolved,
        );
      }
    }
    records.sort((left, right) =>
      identityKey(left).localeCompare(identityKey(right)),
    );
    const artifactText =
      records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length ? "\n" : "");
    const artifactPath = "dependencies/lcia-method-flows.ndjson";
    await mkdir(path.join(staging, "dependencies"), { recursive: true });
    await writeFile(path.join(staging, artifactPath), artifactText, {
      flag: "wx",
    });

    const report = {
      schemaVersion: "tiangong.release.dependency-expansion-report.v1",
      policy: "lcia-method-characterisation-flow-exact.v1",
      lciaMethodCount: scan.methodCount,
      referenceOccurrenceCount: scan.occurrenceCount,
      uniqueReferenceCount: scan.references.length,
      alreadyPresentCount: scan.references.length - missing.length,
      addedExactFlowCount: records.length,
      elementaryFlowCacheRecordCount,
      elementaryFlowCacheManifestSha256,
      outcome: "complete",
    };
    await writeFile(
      path.join(staging, "dependency-expansion-report.json"),
      canonicalJson(report),
      { flag: "wx" },
    );
    const manifest = {
      schemaVersion: "tiangong.release.intake.v1",
      profile: "standalone-lifecyclemodel-result-full-closure.v1",
      source: {
        materializationManifestSha256: hashJson(materializationManifest),
        materializedDatasetIndexSha256: hashJson(materializedIndex),
        sourceIntakeManifestSha256: hashJson(sourceIntake),
        calculationId: sourceIntake.source.calculationId,
        bundleContentHash: sourceIntake.source.bundleContentHash,
      },
      dependencyExpansion: {
        policy: report.policy,
        reportSha256: hashJson(report),
        artifact: {
          path: artifactPath,
          sha256: sha256Bytes(Buffer.from(artifactText)),
          recordCount: records.length,
        },
      },
      verification: { upstream: "verified", dependencies: "verified" },
    };
    await writeFile(
      path.join(staging, "release-intake-manifest.json"),
      canonicalJson(manifest),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "runtime-locators.json"),
      canonicalJson({
        materializationDir: materializationRoot,
        sourceIntakeDir: sourceIntakeRoot,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await mkdir(path.dirname(target), { recursive: true });
    await rename(staging, target);
    return { path: target, manifest, report };
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      fail(
        "release_intake_exists",
        `Refusing to overwrite existing Release Intake: ${target}`,
      );
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function loadReleaseIntake(releaseIntakeDir) {
  const root = path.resolve(releaseIntakeDir);
  const manifest = await readJson(
    path.join(root, "release-intake-manifest.json"),
    "release_intake_manifest_missing",
  );
  const locators = await readJson(
    path.join(root, "runtime-locators.json"),
    "release_intake_locators_missing",
  );
  if (manifest.schemaVersion !== "tiangong.release.intake.v1")
    fail(
      "release_intake_manifest_invalid",
      "Expected tiangong.release.intake.v1",
    );
  const artifact = manifest.dependencyExpansion?.artifact;
  const artifactFile = resolveContained(root, artifact?.path);
  const bytes = await readFile(artifactFile);
  if (sha256Bytes(bytes) !== artifact.sha256)
    fail(
      "release_intake_dependency_hash_mismatch",
      `Hash drift: ${artifact.path}`,
    );
  let recordCount = 0;
  for await (const record of readNdjson(artifactFile)) {
    recordCount += 1;
    if (
      record.datasetType !== "flow" ||
      !UUID.test(record.uuid ?? "") ||
      !VERSION.test(record.version ?? "") ||
      hashJson(record.document) !== record.sha256
    )
      fail(
        "release_intake_dependency_record_invalid",
        `Invalid frozen dependency record at line ${recordCount}`,
      );
  }
  if (recordCount !== artifact.recordCount)
    fail(
      "release_intake_dependency_record_count_mismatch",
      `Dependency record count drift: expected ${artifact.recordCount}, observed ${recordCount}`,
    );
  const report = await readJson(
    path.join(root, "dependency-expansion-report.json"),
    "release_intake_dependency_report_missing",
  );
  if (hashJson(report) !== manifest.dependencyExpansion.reportSha256)
    fail(
      "release_intake_dependency_report_hash_mismatch",
      "Dependency expansion report no longer matches the Release Intake manifest",
    );
  return {
    root,
    manifest,
    locators,
    report,
    dependencyArtifact: artifactFile,
  };
}

async function scanMethodFlowReferences(sourceIntakeRoot, intake) {
  const sourceIdentities = new Set();
  const references = new Map();
  let methodCount = 0;
  let occurrenceCount = 0;
  const artifacts = intake.artifacts.filter(
    ({ kind }) => kind === "source_closure",
  );
  if (!artifacts.length)
    fail(
      "source_closure_missing",
      "Materialization Intake contains no source_closure artifact",
    );
  for (const artifact of artifacts) {
    const file = resolveContained(
      path.join(sourceIntakeRoot, "calculation-bundle"),
      artifact.path,
    );
    const bytes = await readFile(file);
    if (sha256Bytes(bytes) !== artifact.sha256)
      fail(
        "source_closure_artifact_hash_mismatch",
        `Hash drift: ${artifact.path}`,
      );
    let recordCount = 0;
    for await (const record of readNdjson(file)) {
      recordCount += 1;
      if (hashJson(record.document) !== record.sha256)
        fail(
          "source_document_hash_mismatch",
          `Source closure content hash mismatch: ${record.path}`,
        );
      sourceIdentities.add(identityKey(record));
      if (record.datasetType !== "lciamethod") continue;
      methodCount += 1;
      const root = record.document?.LCIAMethodDataSet?.characterisationFactors;
      walk(root, (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const reference = value.referenceToFlowDataSet;
        if (!reference || typeof reference !== "object") return;
        occurrenceCount += 1;
        const uuid = String(reference["@refObjectId"] ?? "").toLowerCase();
        const version = String(reference["@version"] ?? "");
        if (!UUID.test(uuid) || !VERSION.test(version))
          fail(
            "release_intake_flow_reference_invalid",
            "LCIA Method contains a Flow reference without an exact UUID/version",
            { method: `${record.uuid}@${record.version}`, uuid, version },
          );
        references.set(`flow:${uuid}:${version}`, {
          datasetType: "flow",
          uuid,
          version,
        });
      });
    }
    if (recordCount !== artifact.recordCount)
      fail(
        "source_closure_record_count_mismatch",
        `Record count drift: ${artifact.path}`,
      );
  }
  return {
    sourceIdentities,
    references: [...references.values()].sort((a, b) =>
      identityKey(a).localeCompare(identityKey(b)),
    ),
    methodCount,
    occurrenceCount,
  };
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) for (const child of value) walk(child, visit);
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) walk(child, visit);
}

function flowRecord(uuid, version, document) {
  const normalized = uuid.toLowerCase();
  return {
    schemaVersion: "tiangong.source-closure.dataset.v1",
    datasetType: "flow",
    role: "support",
    uuid: normalized,
    version,
    path: `flows/${normalized}_${version}.json`,
    sha256: hashJson(document),
    document,
  };
}

function identityKey(value) {
  return `${value.datasetType}:${String(value.uuid).toLowerCase()}:${value.version}`;
}

function validateUpstream(manifest, index, intake) {
  if (
    manifest.schemaVersion !== "tiangong.release.materialization-manifest.v1" ||
    index.schemaVersion !== "tiangong.release.canonical-dataset-index.v1" ||
    intake.schemaVersion !== "tiangong.release.materialization-intake.v1"
  )
    fail(
      "release_intake_upstream_invalid",
      "Release Intake requires verified Materialization and source intake manifests",
    );
  if (
    manifest.inputs.intakeManifestSha256 !== hashJson(intake) ||
    manifest.inputs.canonicalDatasetIndexSha256 !== hashJson(index)
  )
    fail(
      "release_intake_upstream_mismatch",
      "Materialization does not bind the supplied source intake and canonical index",
    );
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      fail(code, `Required file is missing: ${file}`);
    throw error;
  }
}

function resolveContained(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    fail("unsafe_release_intake_path", `Unsafe path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`))
    fail("unsafe_release_intake_path", `Unsafe path: ${relative}`);
  return resolved;
}
