import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  HASH_PATTERN,
  fail,
  hashJson,
  sha256Bytes,
  sha256File,
} from "./common.mjs";
import { containedPath, readJson } from "./io.mjs";

const execFileAsync = promisify(execFile);
const CANDIDATE_VERSIONS = new Set([
  "tiangong.release.release-candidate.v1",
  "tiangong.release.release-candidate.v2",
]);

export async function loadCandidate(
  candidateDir,
  { verifyArchive = true } = {},
) {
  const root = path.resolve(candidateDir);
  const { value: candidate } = await readJson(
    path.join(root, "release-candidate.json"),
    "release_candidate_missing",
  );
  if (
    !CANDIDATE_VERSIONS.has(candidate.schemaVersion) ||
    candidate.status !== "local_candidate" ||
    candidate.publicationAuthorized !== false ||
    candidate.validation?.outcome !== "passed" ||
    candidate.validation?.delegatedTo !== "tidas-tools"
  )
    fail(
      "release_candidate_unsupported",
      "Dataset Transformation requires a validated, unapproved Release Candidate v1 or v2",
    );
  const { value: index } = await readJson(
    path.join(root, "canonical-dataset-index.json"),
    "candidate_dataset_index_missing",
  );
  if (hashJson(index) !== candidate.canonicalDatasetIndexSha256)
    fail(
      "candidate_dataset_index_hash_mismatch",
      "Candidate canonical dataset index has drifted",
    );
  if (
    index.schemaVersion !== "tiangong.release.canonical-dataset-index.v1" ||
    !Array.isArray(index.datasets) ||
    index.datasetCount !== index.datasets.length
  )
    fail(
      "candidate_dataset_index_invalid",
      "Candidate canonical dataset index is structurally invalid",
    );
  const packageSetHash = hashJson(
    (candidate.packages ?? []).map(({ path: itemPath, sha256, byteSize }) => ({
      path: itemPath,
      sha256,
      byteSize,
    })),
  );
  if (packageSetHash !== candidate.packageSetHash)
    fail(
      "candidate_package_set_hash_mismatch",
      "Candidate package-set binding has drifted",
    );
  const unitPackage = (candidate.packages ?? []).find(({ path: itemPath }) =>
    itemPath.endsWith("-UnitProcessDatabase.tidas.zip"),
  );
  if (!unitPackage || !HASH_PATTERN.test(unitPackage.sha256 ?? ""))
    fail(
      "candidate_unit_process_package_missing",
      "Candidate does not bind one Unit Process TIDAS package",
    );
  const archive = containedPath(root, unitPackage.path);
  const info = await stat(archive).catch(() => null);
  if (!info || info.size !== unitPackage.byteSize)
    fail(
      "candidate_package_size_mismatch",
      `Candidate package size has drifted: ${unitPackage.path}`,
    );
  if (verifyArchive && (await sha256File(archive)) !== unitPackage.sha256)
    fail(
      "candidate_package_hash_mismatch",
      `Candidate package bytes have drifted: ${unitPackage.path}`,
    );
  const byKey = new Map();
  for (const entry of index.datasets) {
    const key = datasetKey(entry);
    if (byKey.has(key))
      fail(
        "candidate_dataset_identity_duplicate",
        `Candidate index contains duplicate identity: ${key}`,
      );
    byKey.set(key, entry);
  }
  return {
    root,
    candidate,
    candidateSha256: hashJson(candidate),
    index,
    indexSha256: hashJson(index),
    byKey,
    unitPackage,
    archive,
  };
}

export async function loadProcessInputs(candidateEvidence, keys) {
  if (!Array.isArray(keys) || keys.length < 2)
    fail(
      "transformation_input_count_invalid",
      "Weighted Process aggregation requires at least two inputs",
    );
  if (new Set(keys).size !== keys.length)
    fail("transformation_input_duplicate", "Process inputs must be unique");
  const inputs = [];
  for (const key of keys) {
    const entry = candidateEvidence.byKey.get(key);
    if (!entry)
      fail(
        "transformation_input_unknown",
        `Transformation input is outside the Candidate: ${key}`,
      );
    if (entry.datasetType !== "process" || entry.role !== "unit_process")
      fail(
        "transformation_input_role_unsupported",
        `DSL v0 supports only Candidate Unit Process inputs: ${key}`,
      );
    if (
      typeof entry.path !== "string" ||
      !entry.path.startsWith("processes/") ||
      path.isAbsolute(entry.path) ||
      entry.path.split("/").includes("..")
    )
      fail(
        "transformation_input_path_invalid",
        `Candidate Process path is not contained in the Process category: ${key}`,
      );
    const bytes = await extractMember(candidateEvidence.archive, entry.path);
    if (sha256Bytes(bytes) !== entry.sha256)
      fail(
        "transformation_input_hash_mismatch",
        `Candidate Process bytes differ from the index: ${key}`,
      );
    let document;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(
        "transformation_input_json_invalid",
        `Candidate Process is not JSON: ${key}`,
      );
    }
    if (hashJson(document) !== entry.canonicalContentHash)
      fail(
        "transformation_input_content_hash_mismatch",
        `Candidate Process canonical content differs from the index: ${key}`,
      );
    inputs.push({ key, entry, bytes, document });
  }
  return inputs;
}

export function datasetKey(entry) {
  return `${entry.datasetType}:${entry.uuid}@${entry.version}`;
}

async function extractMember(archive, member) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", archive, member], {
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout;
  } catch (error) {
    fail(
      "candidate_archive_member_read_failed",
      `Cannot read Candidate archive member: ${member}`,
      { cause: error.code ?? null },
    );
  }
}
