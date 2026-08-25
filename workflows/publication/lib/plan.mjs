import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, hashJson, sha256Bytes } from "./common.mjs";

const COMPONENTS = new Set(["unit-process", "result", "both"]);
const TARGET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[0-9a-f]{64}$/u;

export async function preparePublicationPlan({
  candidateDir,
  outDir,
  component,
  targetId,
  include = [],
  exclude = [],
}) {
  if (!COMPONENTS.has(component))
    fail(
      "publication_component_invalid",
      `Unsupported Publication component: ${component}`,
    );
  const normalizedTargetId = String(targetId ?? "").trim();
  if (!TARGET_ID.test(normalizedTargetId))
    fail(
      "publication_target_invalid",
      "Publication target ID must be a stable identifier, not a URL or credential",
    );
  const candidateRoot = path.resolve(candidateDir);
  const target = path.resolve(outDir);
  await assertTargetAbsent(target);
  const evidence = await loadCandidateEvidence(candidateRoot);
  if (!Array.isArray(evidence.catalog.datasets))
    fail(
      "candidate_publication_catalog_invalid",
      "Candidate Publication catalog is structurally invalid",
    );
  const catalogByKey = new Map(
    evidence.catalog.datasets.map((dataset) => [dataset.key, dataset]),
  );
  if (catalogByKey.size !== evidence.catalog.datasets.length)
    fail(
      "publication_catalog_identity_duplicate",
      "Publication catalog contains duplicate dataset identities",
    );
  validateCatalog(evidence.catalog, catalogByKey, evidence.index);

  const requestedInclude = uniqueSorted(include);
  const requestedExclude = uniqueSorted(exclude);
  for (const key of [...requestedInclude, ...requestedExclude])
    if (!catalogByKey.has(key))
      fail(
        "publication_scope_identity_unknown",
        `Publication scope names a dataset outside this Candidate: ${key}`,
        { key },
      );
  const overlap = requestedInclude.filter((key) =>
    requestedExclude.includes(key),
  );
  if (overlap.length)
    fail(
      "publication_scope_conflict",
      "The same dataset cannot be both included and excluded",
      { identities: overlap },
    );

  const componentRoots = rootsForComponent(evidence.catalog, component);
  const componentSet = datasetsForComponent(evidence.catalog, component);
  if (!componentRoots.length)
    fail(
      "publication_component_unavailable",
      `Candidate does not contain an available ${component} Publication component`,
      { component },
    );
  const requestedRoots = requestedInclude.length
    ? requestedInclude
    : componentRoots;
  for (const key of requestedRoots)
    if (!componentSet.has(key))
      fail(
        "publication_scope_component_mismatch",
        `Selected dataset is outside the ${component} component: ${key}`,
        { key, component },
      );

  const selectedBeforePruning = reachable(catalogByKey, requestedRoots);
  const exclusionOutsideSelection = requestedExclude.filter(
    (key) => !selectedBeforePruning.has(key),
  );
  if (exclusionOutsideSelection.length)
    fail(
      "publication_exclusion_outside_selection",
      "Excluded datasets must belong to the requested Publication closure",
      { identities: exclusionOutsideSelection },
    );

  const reverse = reverseEdges(catalogByKey, selectedBeforePruning);
  const prunedReasons = new Map();
  const queue = [];
  for (const key of requestedExclude) {
    prunedReasons.set(key, {
      code: "explicitly_excluded",
      causedBy: null,
    });
    queue.push(key);
  }
  while (queue.length) {
    const removed = queue.shift();
    for (const dependent of reverse.get(removed) ?? []) {
      if (prunedReasons.has(dependent)) continue;
      prunedReasons.set(dependent, {
        code: "required_dependency_excluded",
        causedBy: removed,
      });
      queue.push(dependent);
    }
  }

  const survivingRoots = requestedRoots.filter(
    (key) => !prunedReasons.has(key),
  );
  const effective = reachable(catalogByKey, survivingRoots, prunedReasons);
  for (const key of selectedBeforePruning)
    if (!effective.has(key) && !prunedReasons.has(key))
      prunedReasons.set(key, {
        code: "not_reachable_after_pruning",
        causedBy: null,
      });
  if (!effective.size)
    fail(
      "publication_scope_empty",
      "Publication scope is empty after dependency-closed pruning",
      { requestedRoots, requestedExclude },
    );
  assertReferenceComplete(catalogByKey, effective);

  const request = {
    schemaVersion: "tiangong.release.publication-scope-request.v1",
    candidate: {
      releaseCandidateSha256: evidence.releaseCandidateSha256,
      packageSetHash: evidence.candidate.packageSetHash,
    },
    component,
    include: requestedInclude,
    exclude: requestedExclude,
    targetId: normalizedTargetId,
  };
  const effectiveDatasets = projectDatasets(catalogByKey, effective);
  const selectedBefore = projectDatasets(catalogByKey, selectedBeforePruning);
  const additions = selectedBefore.filter(
    ({ key }) => !requestedRoots.includes(key),
  );
  const pruned = [...prunedReasons]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, reason]) => ({
      ...projectDataset(catalogByKey.get(key)),
      reason,
    }));
  const resolution = {
    schemaVersion: "tiangong.release.publication-scope-resolution.v1",
    scopeRequestSha256: hashJson(request),
    candidatePublicationCatalogSha256:
      evidence.candidate.publicationCatalog.sha256,
    requestedRootCount: requestedRoots.length,
    selectedBeforePruningCount: selectedBefore.length,
    effectiveDatasetCount: effectiveDatasets.length,
    effectiveSetHash: hashJson(
      effectiveDatasets.map(({ key, sha256 }) => ({ key, sha256 })),
    ),
    requestedRoots,
    dependencyAdditions: additions,
    prunedDatasets: pruned,
    effectiveDatasets,
    referenceComplete: true,
  };
  const plan = {
    schemaVersion: "tiangong.release.publication-draft-plan.v1",
    status: "prepared_unapproved",
    publicationAuthorized: false,
    candidate: {
      releaseCandidateSha256: evidence.releaseCandidateSha256,
      releaseVersion: evidence.candidate.releaseVersion,
      packagePlanSha256: evidence.candidate.packagePlanSha256,
      canonicalDatasetIndexSha256:
        evidence.candidate.canonicalDatasetIndexSha256,
      publicationCatalogSha256: evidence.candidate.publicationCatalog.sha256,
      packageSetHash: evidence.candidate.packageSetHash,
    },
    scope: {
      requestSha256: hashJson(request),
      resolutionSha256: hashJson(resolution),
      component,
      effectiveDatasetCount: resolution.effectiveDatasetCount,
      effectiveSetHash: resolution.effectiveSetHash,
    },
    target: {
      id: request.targetId,
      inspectionStatus: "pending",
      fingerprint: null,
      publishedState: { semantic: "published", code: null },
    },
    execution: {
      status: "requires_target_inspection_and_approval",
    },
  };

  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    await writeFile(
      path.join(staging, "publication-scope-request.json"),
      canonicalJson(request),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "publication-scope-resolution.json"),
      canonicalJson(resolution),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "publication-draft-plan.json"),
      canonicalJson(plan),
      { flag: "wx" },
    );
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    path: target,
    request,
    resolution,
    plan,
    publicationDraftPlanSha256: hashJson(plan),
  };
}

async function loadCandidateEvidence(candidateRoot) {
  const candidate = await readJson(
    path.join(candidateRoot, "release-candidate.json"),
    "release_candidate_missing",
  );
  if (
    candidate.schemaVersion !== "tiangong.release.release-candidate.v2" ||
    candidate.status !== "local_candidate" ||
    candidate.publicationAuthorized !== false ||
    candidate.profile !== "standalone-lifecyclemodel-result-full-closure.v1" ||
    candidate.validation?.outcome !== "passed" ||
    candidate.validation?.delegatedTo !== "tidas-tools" ||
    candidate.publicationCatalog?.path !== "publication-catalog.json"
  )
    fail(
      "release_candidate_publication_contract_unsupported",
      "Publication planning requires an unapproved Release Candidate v2 with a bound Publication catalog",
    );
  validateCandidatePackages(candidate);
  const packagePlan = await readJson(
    path.join(candidateRoot, "package-plan.json"),
    "candidate_package_plan_missing",
  );
  if (hashJson(packagePlan) !== candidate.packagePlanSha256)
    fail(
      "candidate_package_plan_hash_mismatch",
      "Candidate Package Plan hash has drifted",
    );
  const index = await readJson(
    path.join(candidateRoot, "canonical-dataset-index.json"),
    "candidate_dataset_index_missing",
  );
  if (hashJson(index) !== candidate.canonicalDatasetIndexSha256)
    fail(
      "candidate_dataset_index_hash_mismatch",
      "Candidate dataset index hash has drifted",
    );
  const catalog = await readJson(
    path.join(candidateRoot, candidate.publicationCatalog?.path ?? ""),
    "candidate_publication_catalog_missing",
  );
  if (
    hashJson(catalog) !== candidate.publicationCatalog?.sha256 ||
    catalog.canonicalDatasetIndexSha256 !==
      candidate.canonicalDatasetIndexSha256
  )
    fail(
      "candidate_publication_catalog_hash_mismatch",
      "Candidate Publication catalog no longer matches the frozen Candidate",
    );
  for (const artifact of candidate.packages ?? []) {
    const file = resolveContained(candidateRoot, artifact.path);
    const info = await stat(file);
    const bytes = await readFile(file);
    if (
      info.size !== artifact.byteSize ||
      sha256Bytes(bytes) !== artifact.sha256
    )
      fail(
        "candidate_package_hash_mismatch",
        `Candidate package bytes have drifted: ${artifact.path}`,
      );
  }
  return {
    candidate,
    catalog,
    index,
    releaseCandidateSha256: hashJson(candidate),
  };
}

function validateCandidatePackages(candidate) {
  if (!Array.isArray(candidate.packages) || candidate.packages.length !== 4)
    fail(
      "release_candidate_packages_invalid",
      "Release Candidate v2 must bind exactly four distribution packages",
    );
  const paths = new Set();
  for (const artifact of candidate.packages) {
    if (
      typeof artifact?.path !== "string" ||
      !artifact.path.startsWith("packages/") ||
      !artifact.path.endsWith(".zip") ||
      artifact.mediaType !== "application/zip" ||
      !Number.isInteger(artifact.byteSize) ||
      artifact.byteSize < 1 ||
      !HASH.test(artifact.sha256 ?? "") ||
      paths.has(artifact.path)
    )
      fail(
        "release_candidate_packages_invalid",
        "Release Candidate package bindings are malformed or duplicated",
      );
    paths.add(artifact.path);
  }
  const packageSetHash = hashJson(
    candidate.packages.map(({ path: itemPath, sha256, byteSize }) => ({
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
}

function validateCatalog(catalog, catalogByKey, index) {
  if (
    catalog.schemaVersion !==
      "tiangong.release.candidate-publication-catalog.v1" ||
    !Array.isArray(catalog.datasets) ||
    catalog.datasetCount !== catalogByKey.size ||
    !Array.isArray(index.datasets) ||
    catalog.datasetCount !== index.datasets.length
  )
    fail(
      "candidate_publication_catalog_invalid",
      "Candidate Publication catalog is structurally invalid",
    );
  const indexByKey = new Map(
    index.datasets.map((dataset) => [datasetIdentityKey(dataset), dataset]),
  );
  if (indexByKey.size !== index.datasets.length)
    fail(
      "candidate_dataset_index_identity_duplicate",
      "Candidate dataset index contains duplicate identities",
    );
  for (const dataset of catalogByKey.values()) {
    const indexed = indexByKey.get(dataset.key);
    if (
      dataset.key !== datasetIdentityKey(dataset) ||
      !indexed ||
      dataset.role !== indexed.role ||
      dataset.path !== indexed.path ||
      dataset.sha256 !== indexed.sha256 ||
      dataset.canonicalContentHash !== indexed.canonicalContentHash ||
      !Array.isArray(dataset.references) ||
      !Array.isArray(dataset.components) ||
      new Set(dataset.components).size !== dataset.components.length ||
      dataset.components.some(
        (component) => !["unit_process", "result"].includes(component),
      )
    )
      fail(
        "candidate_publication_catalog_index_mismatch",
        `Publication catalog dataset does not match the canonical index: ${dataset.key}`,
      );
    for (const reference of dataset.references)
      if (
        reference?.role !== "closure_dependency" ||
        typeof reference.location !== "string" ||
        !catalogByKey.has(reference.target)
      )
        fail(
          "candidate_publication_reference_missing",
          `Publication catalog reference target is missing: ${dataset.key} -> ${reference.target}`,
        );
  }
  for (const name of ["unitProcess", "result"])
    validateCatalogComponent(name, catalog.components?.[name], catalogByKey);
  const expectedSetHash = hashJson(
    catalog.datasets.map(({ key, sha256, references }) => ({
      key,
      sha256,
      references,
    })),
  );
  if (expectedSetHash !== catalog.catalogSetHash)
    fail(
      "candidate_publication_catalog_set_hash_mismatch",
      "Publication catalog dataset-set binding has drifted",
    );
}

function validateCatalogComponent(name, component, catalogByKey) {
  if (
    !component ||
    !Array.isArray(component.roots) ||
    !Array.isArray(component.datasets) ||
    component.available !== component.roots.length > 0 ||
    new Set(component.roots).size !== component.roots.length ||
    new Set(component.datasets).size !== component.datasets.length
  )
    fail(
      "candidate_publication_component_invalid",
      `Publication catalog ${name} component is structurally invalid`,
    );
  const expectedRootRoles =
    name === "unitProcess"
      ? new Set(["unit_process"])
      : new Set(["result_process", "lifecycle_model"]);
  for (const key of component.roots) {
    const root = catalogByKey.get(key);
    if (!root || !expectedRootRoles.has(root.role))
      fail(
        "candidate_publication_component_root_invalid",
        `Publication catalog ${name} component has an invalid root: ${key}`,
      );
  }
  const expected = [...reachable(catalogByKey, component.roots)].sort();
  if (!sameList(expected, [...component.datasets].sort()))
    fail(
      "candidate_publication_component_closure_mismatch",
      `Publication catalog ${name} component does not match its dependency closure`,
    );
  const marker = name === "unitProcess" ? "unit_process" : "result";
  for (const dataset of catalogByKey.values()) {
    const marked = dataset.components.includes(marker);
    if (marked !== expected.includes(dataset.key))
      fail(
        "candidate_publication_component_membership_mismatch",
        `Publication catalog component membership has drifted: ${dataset.key}`,
      );
  }
}

function rootsForComponent(catalog, component) {
  return uniqueSorted([
    ...(component !== "result" ? catalog.components.unitProcess.roots : []),
    ...(component !== "unit-process" ? catalog.components.result.roots : []),
  ]);
}

function datasetsForComponent(catalog, component) {
  return new Set([
    ...(component !== "result" ? catalog.components.unitProcess.datasets : []),
    ...(component !== "unit-process" ? catalog.components.result.datasets : []),
  ]);
}

function reachable(catalogByKey, roots, excluded = new Map()) {
  const found = new Set();
  const queue = [...roots];
  while (queue.length) {
    const key = queue.pop();
    if (found.has(key) || excluded.has(key)) continue;
    const dataset = catalogByKey.get(key);
    if (!dataset)
      fail(
        "candidate_publication_reference_missing",
        `Publication scope references a missing dataset: ${key}`,
      );
    found.add(key);
    for (const reference of dataset.references ?? [])
      if (!found.has(reference.target)) queue.push(reference.target);
  }
  return found;
}

function reverseEdges(catalogByKey, selected) {
  const reverse = new Map();
  for (const key of selected) {
    for (const reference of catalogByKey.get(key).references ?? []) {
      if (!selected.has(reference.target)) continue;
      const dependents = reverse.get(reference.target) ?? [];
      dependents.push(key);
      reverse.set(reference.target, dependents.sort());
    }
  }
  return reverse;
}

function assertReferenceComplete(catalogByKey, effective) {
  const conflicts = [];
  for (const key of effective)
    for (const reference of catalogByKey.get(key).references ?? [])
      if (!effective.has(reference.target))
        conflicts.push({ from: key, ...reference });
  if (conflicts.length)
    fail(
      "publication_scope_reference_incomplete",
      "Effective Publication scope contains unresolved required references",
      { conflicts },
    );
}

function projectDatasets(catalogByKey, keys) {
  return [...keys].sort().map((key) => projectDataset(catalogByKey.get(key)));
}

function projectDataset(dataset) {
  return {
    key: dataset.key,
    datasetType: dataset.datasetType,
    role: dataset.role,
    uuid: dataset.uuid,
    version: dataset.version,
    path: dataset.path,
    sha256: dataset.sha256,
    canonicalContentHash: dataset.canonicalContentHash,
  };
}

function uniqueSorted(values) {
  return [
    ...new Set(values.map((value) => String(value).trim()).filter(Boolean)),
  ].sort();
}

function datasetIdentityKey(dataset) {
  return `${dataset?.datasetType}:${String(dataset?.uuid ?? "").toLowerCase()}@${dataset?.version}`;
}

function sameList(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function readJson(file, code) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(code, `Unable to read required Publication artifact: ${file}`, {
      cause: error.message,
    });
  }
}

async function assertTargetAbsent(target) {
  try {
    await access(target);
    fail(
      "publication_output_exists",
      `Refusing to overwrite output: ${target}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function resolveContained(root, relativePath) {
  const target = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(prefix))
    fail(
      "publication_artifact_path_escape",
      `Candidate artifact escapes Candidate root: ${relativePath}`,
    );
  return target;
}
