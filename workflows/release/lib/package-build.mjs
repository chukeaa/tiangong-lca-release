import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";
import { readNdjson } from "./records.mjs";

export const PACKAGE_PROFILE =
  "standalone-lifecyclemodel-result-full-closure.v1";

const DISTRIBUTION_PACKAGES = [
  ["unit-process-full-closure.v1.tidas.zip", "UnitProcessDatabase", "tidas"],
  ["unit-process-full-closure.v1.ilcd.zip", "UnitProcessDatabase", "ilcd"],
  [
    "standalone-lifecyclemodel-result-full-closure.v1.tidas.zip",
    "ResultDatabase",
    "tidas",
  ],
  [
    "standalone-lifecyclemodel-result-full-closure.v1.ilcd.zip",
    "ResultDatabase",
    "ilcd",
  ],
];

export async function buildPackageCandidate({
  materializationDir,
  intakeDir,
  outDir,
  releaseVersion,
  tidasBin = process.env.TIDAS_BIN ?? "tidas",
  runTool = runTidas,
  verifyTool = verifyBuiltPackages,
}) {
  validateReleaseVersion(releaseVersion);
  const materializationRoot = path.resolve(materializationDir);
  const intakeRoot = path.resolve(intakeDir);
  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  await assertTargetAbsent(target);
  const workspace = await mkdtemp(`${target}.work-`);
  const candidateStaging = await mkdtemp(`${target}.tmp-`);
  try {
    const manifest = await readJson(
      path.join(materializationRoot, "materialization-manifest.json"),
      "materialization_manifest_missing",
    );
    const materializedIndex = await readJson(
      path.join(materializationRoot, "canonical-dataset-index.json"),
      "canonical_index_missing",
    );
    const intake = await readJson(
      path.join(intakeRoot, "intake-manifest.json"),
      "intake_manifest_missing",
    );
    validateInputs(manifest, materializedIndex, intake);
    const canonicalRoot = path.join(workspace, "canonical");
    await mkdir(canonicalRoot, { recursive: true });
    const entries = await assembleCanonicalCollection({
      materializationRoot,
      materializedIndex,
      intakeRoot,
      intake,
      canonicalRoot,
    });
    const assembledIndex = buildIndex(entries);
    const indexPath = path.join(workspace, "canonical-dataset-index.json");
    await writeFile(indexPath, canonicalJson(assembledIndex), { flag: "wx" });
    const plan = {
      schemaVersion: "tiangong.release.package-plan.v1",
      releaseVersion,
      profile: PACKAGE_PROFILE,
      materialization: {
        manifestSha256: hashJson(manifest),
        canonicalDatasetIndexSha256: hashJson(materializedIndex),
      },
      intake: {
        manifestSha256: hashJson(intake),
        calculationId: intake.source.calculationId,
        bundleContentHash: intake.source.bundleContentHash,
      },
      canonicalInput: {
        datasetCount: assembledIndex.datasetCount,
        byteSize: assembledIndex.byteSize,
        artifactSetHash: assembledIndex.artifactSetHash,
      },
      packager: { adapter: "tidas-tools.release-build-packages.v1" },
    };
    await writeFile(
      path.join(candidateStaging, "package-plan.json"),
      canonicalJson(plan),
      { flag: "wx" },
    );
    await copyFile(
      indexPath,
      path.join(candidateStaging, "canonical-dataset-index.json"),
    );
    const packagesDir = path.join(candidateStaging, "packages");
    const toolResult = await runTool({
      tidasBin,
      canonicalRoot,
      indexPath,
      packagesDir,
    });
    await applyDistributionNames(packagesDir, releaseVersion);
    const packageVerification = await verifyTool({
      tidasBin,
      packagesDir,
      workspace,
      releaseVersion,
    });
    await writeFile(
      path.join(candidateStaging, "tidas-release-report.json"),
      canonicalJson(toolResult),
      { flag: "wx" },
    );
    await writeFile(
      path.join(candidateStaging, "package-verification-report.json"),
      canonicalJson(packageVerification),
      { flag: "wx" },
    );
    const packages = await packageArtifacts(packagesDir);
    if (
      packages.length !== 4 ||
      packages.some((item) => !item.path.endsWith(".zip"))
    )
      fail(
        "package_artifacts_invalid",
        `Expected exactly four ZIP packages, received ${packages.length}`,
      );
    const candidate = {
      schemaVersion: "tiangong.release.release-candidate.v1",
      status: "local_candidate",
      publicationAuthorized: false,
      releaseVersion,
      profile: PACKAGE_PROFILE,
      packagePlanSha256: hashJson(plan),
      canonicalDatasetIndexSha256: hashJson(assembledIndex),
      packages,
      packageSetHash: hashJson(
        packages.map(({ path: itemPath, sha256, byteSize }) => ({
          path: itemPath,
          sha256,
          byteSize,
        })),
      ),
      validation: {
        delegatedTo: "tidas-tools",
        outcome: "passed",
        reportPath: "tidas-release-report.json",
        archiveReadbackReportPath: "package-verification-report.json",
      },
    };
    await writeFile(
      path.join(candidateStaging, "release-candidate.json"),
      canonicalJson(candidate),
      { flag: "wx" },
    );
    await rename(candidateStaging, target);
    return { path: target, plan, candidate };
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      fail("output_exists", `Refusing to overwrite existing output: ${target}`);
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(candidateStaging, { recursive: true, force: true });
  }
}

function validateReleaseVersion(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/.test(value) ||
    value.includes("..")
  )
    fail(
      "release_version_invalid",
      "--release-version must be 1-64 filename-safe characters and may not contain '..'",
    );
}

async function applyDistributionNames(packagesDir, releaseVersion) {
  for (const [source, product, format] of DISTRIBUTION_PACKAGES) {
    await rename(
      path.join(packagesDir, source),
      path.join(
        packagesDir,
        `TiangongLCA-${releaseVersion}-${product}.${format}.zip`,
      ),
    );
  }
}

export async function verifyBuiltPackages({
  tidasBin,
  packagesDir,
  workspace,
  releaseVersion,
  spawnCommand = spawnBounded,
}) {
  const packages = [];
  for (const [, product, format] of DISTRIBUTION_PACKAGES) {
    const fileName = `TiangongLCA-${releaseVersion}-${product}.${format}.zip`;
    const archive = path.join(packagesDir, fileName);
    const archiveBytes = await readFile(archive);
    const listing = await spawnCommand("unzip", ["-Z1", archive]);
    if (listing.code !== 0)
      fail(
        "package_archive_invalid",
        `Cannot read ZIP member catalog: ${fileName}`,
      );
    const members = listing.stdout.split(/\r?\n/u).filter(Boolean);
    if (
      members.length === 0 ||
      members.some(
        (member) =>
          member.startsWith("/") || member.split(/[\\/]/u).includes(".."),
      )
    )
      fail(
        "package_archive_invalid",
        `ZIP contains no members or unsafe paths: ${fileName}`,
      );
    const extracted = path.join(workspace, "readback", fileName);
    await mkdir(extracted, { recursive: true });
    const extraction = await spawnCommand("unzip", [
      "-qq",
      archive,
      "-d",
      extracted,
    ]);
    if (extraction.code !== 0)
      fail("package_archive_invalid", `Cannot extract ZIP: ${fileName}`);
    const action = format === "tidas" ? "validate-tidas" : "validate-ilcd";
    const validation = await spawnCommand(tidasBin, [
      "release",
      action,
      "--input-dir",
      extracted,
      "--format",
      "json",
    ]);
    if (validation.code !== 0)
      fail(
        `${format}_package_validation_failed`,
        `${format.toUpperCase()} validation failed after ZIP readback: ${fileName}`,
        { stderr: validation.stderr.slice(-4000) },
      );
    let report;
    try {
      report = JSON.parse(validation.stdout);
    } catch {
      fail(
        "tidas_output_invalid",
        `Validator returned invalid JSON for ${fileName}`,
      );
    }
    packages.push({
      fileName,
      product,
      format,
      memberCount: members.length,
      byteSize: archiveBytes.length,
      sha256: sha256Bytes(archiveBytes),
      outcome: "passed",
      validation: report,
    });
  }
  return {
    schemaVersion: "tiangong.release.package-verification.v1",
    releaseVersion,
    outcome: "passed",
    packages,
  };
}

async function assembleCanonicalCollection({
  materializationRoot,
  materializedIndex,
  intakeRoot,
  intake,
  canonicalRoot,
}) {
  const entries = [];
  const identities = new Map();
  const paths = new Set();
  for (const dataset of materializedIndex.datasets) {
    const sourcePath = resolveContained(materializationRoot, dataset.path);
    const relativePath = stripCanonicalPrefix(dataset.path);
    const destination = resolveContained(canonicalRoot, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(sourcePath);
    if (sha256Bytes(bytes) !== dataset.sha256)
      fail("materialized_dataset_hash_mismatch", `Hash drift: ${dataset.path}`);
    await writeFile(destination, bytes, { flag: "wx" });
    addEntry(entries, identities, paths, {
      ...dataset,
      path: relativePath,
      byteSize: bytes.length,
    });
  }
  const sourceArtifacts = intake.artifacts
    .filter((artifact) => artifact.kind === "source_closure")
    .map((artifact) => ({
      ...artifact,
      resolvedPath: resolveContained(
        path.join(intakeRoot, "calculation-bundle"),
        artifact.path,
      ),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!sourceArtifacts.length)
    fail(
      "source_closure_missing",
      "Intake contains no source_closure artifact",
    );
  for (const artifact of sourceArtifacts) {
    const artifactBytes = await readFile(artifact.resolvedPath);
    if (sha256Bytes(artifactBytes) !== artifact.sha256)
      fail(
        "source_closure_artifact_hash_mismatch",
        `Hash drift: ${artifact.path}`,
      );
    let recordCount = 0;
    for await (const record of readNdjson(artifact.resolvedPath)) {
      recordCount += 1;
      const relativePath = safeRelative(record.path);
      const contentHash = hashJson(record.document);
      if (contentHash !== record.sha256)
        fail(
          "source_document_hash_mismatch",
          `Source closure content hash mismatch: ${relativePath}`,
        );
      const content = canonicalJson(record.document);
      const entry = {
        datasetType: record.datasetType,
        role: record.role ?? "support",
        uuid: String(record.uuid).toLowerCase(),
        version: record.version,
        path: relativePath,
        sha256: sha256Bytes(Buffer.from(content)),
        byteSize: Buffer.byteLength(content),
        canonicalContentHash: contentHash,
      };
      const key = identityKey(entry);
      const existing = identities.get(key);
      if (existing) {
        if (existing.canonicalContentHash !== entry.canonicalContentHash)
          fail(
            "canonical_identity_collision",
            `Conflicting dataset identity: ${key}`,
          );
        continue;
      }
      const destination = resolveContained(canonicalRoot, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
      addEntry(entries, identities, paths, entry);
    }
    if (recordCount !== artifact.recordCount)
      fail(
        "source_closure_record_count_mismatch",
        `Record count drift: ${artifact.path}`,
      );
  }
  return entries;
}

function addEntry(entries, identities, paths, entry) {
  const key = identityKey(entry);
  if (identities.has(key))
    fail("canonical_identity_duplicate", `Duplicate dataset identity: ${key}`);
  if (paths.has(entry.path))
    fail("canonical_path_duplicate", `Duplicate canonical path: ${entry.path}`);
  identities.set(key, entry);
  paths.add(entry.path);
  entries.push(entry);
}

function buildIndex(entries) {
  const datasets = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  return {
    schemaVersion: "tiangong.release.canonical-dataset-index.v1",
    datasetCount: datasets.length,
    byteSize: datasets.reduce((total, entry) => total + entry.byteSize, 0),
    artifactSetHash: hashJson(
      datasets.map(
        ({ datasetType, uuid, version, path: itemPath, sha256 }) => ({
          datasetType,
          uuid,
          version,
          path: itemPath,
          sha256,
        }),
      ),
    ),
    datasets,
  };
}

function validateInputs(manifest, index, intake) {
  if (manifest.schemaVersion !== "tiangong.release.materialization-manifest.v1")
    fail(
      "materialization_manifest_invalid",
      "Expected materialization-manifest.v1",
    );
  if (index.schemaVersion !== "tiangong.release.canonical-dataset-index.v1")
    fail("canonical_index_invalid", "Expected canonical-dataset-index.v1");
  if (intake.schemaVersion !== "tiangong.release.materialization-intake.v1")
    fail("intake_manifest_invalid", "Expected materialization-intake.v1");
  if (manifest.profiles?.model === null)
    fail(
      "package_profile_unsupported",
      "The first Release package route requires LifecycleModel materialization",
    );
  if (
    manifest.inputs.calculationId !== intake.source.calculationId ||
    manifest.inputs.bundleContentHash !== intake.source.bundleContentHash ||
    manifest.inputs.intakeManifestSha256 !== hashJson(intake)
  ) {
    fail(
      "materialization_intake_mismatch",
      "Materialization and intake identities/hashes do not match",
    );
  }
  if (
    manifest.inputs.canonicalDatasetIndexSha256 !== hashJson(index) ||
    index.datasetCount !== index.datasets.length
  ) {
    fail(
      "canonical_index_mismatch",
      "Materialization canonical index is not frozen by its manifest",
    );
  }
}

async function runTidas({ tidasBin, canonicalRoot, indexPath, packagesDir }) {
  await mkdir(path.dirname(packagesDir), { recursive: true });
  const args = [
    "release",
    "build-packages",
    "--tidas-dir",
    canonicalRoot,
    "--dataset-index",
    indexPath,
    "--output-dir",
    packagesDir,
    "--format",
    "json",
  ];
  const result = await spawnBounded(tidasBin, args);
  if (result.code !== 0) {
    fail(
      "tidas_package_build_failed",
      `tidas-tools exited with code ${result.code}`,
      {
        stderr: result.stderr.slice(-4000),
      },
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail("tidas_output_invalid", "tidas-tools did not return one JSON result");
  }
}

function spawnBounded(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
    child.once("error", (error) => {
      if (error.code === "ENOENT")
        reject(
          Object.assign(
            new Error(
              command === "unzip"
                ? "Required archive reader not found: unzip"
                : `tidas executable not found: ${command}; install tidas or pass --tidas-bin`,
            ),
            {
              code:
                command === "unzip"
                  ? "archive_reader_missing"
                  : "tidas_executable_missing",
            },
          ),
        );
      else reject(error);
    });
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function packageArtifacts(root) {
  const files = await walkFiles(root);
  const result = [];
  for (const file of files) {
    const bytes = await readFile(file);
    result.push({
      path: path.relative(path.dirname(root), file).split(path.sep).join("/"),
      mediaType: file.endsWith(".zip")
        ? "application/zip"
        : "application/octet-stream",
      byteSize: bytes.length,
      sha256: sha256Bytes(bytes),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function walkFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walkFiles(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      fail(code, `Required file does not exist: ${file}`);
    throw error;
  }
}

async function assertTargetAbsent(target) {
  try {
    await stat(target);
    fail("output_exists", `Refusing to overwrite existing output: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function stripCanonicalPrefix(value) {
  const relative = safeRelative(value);
  const prefix = "canonical-datasets/";
  if (!relative.startsWith(prefix))
    fail(
      "canonical_index_path_invalid",
      `Expected ${prefix} path: ${relative}`,
    );
  return safeRelative(relative.slice(prefix.length));
}

function resolveContained(root, relative) {
  const safe = safeRelative(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, safe);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`))
    fail("unsafe_path", `Path escapes root: ${relative}`);
  return resolved;
}

function safeRelative(value) {
  const text = String(value ?? "");
  if (
    !text ||
    text.includes("\\") ||
    path.isAbsolute(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("unsafe_path", `Unsafe relative path: ${text}`);
  }
  return text;
}

function identityKey(entry) {
  return `${entry.datasetType}:${entry.uuid.toLowerCase()}:${entry.version}`;
}
