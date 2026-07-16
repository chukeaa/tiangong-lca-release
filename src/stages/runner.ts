import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalize, canonicalSha256 } from "../canonical/jcs.js";
import {
  assertCalculationBundleManifest,
  calculateBundleContentHash,
} from "../bundle/manifest.js";
import type { CalculationBundleManifest } from "../bundle/types.js";
import {
  bundleDirectoryForManifest,
  loadBundleProcessRecords,
  loadLciRecords,
  loadLciaRecords,
  loadTechnosphereRecords,
  verifyBundleArtifacts,
  verifyGraphEvidenceRecords,
} from "../bundle/verify.js";
import type { JsonValue } from "../contracts/json.js";
import {
  generatedModelUuid,
  generatedResultProcessUuid,
  processIdentityDocument,
  resultIdentityDocument,
} from "../identity/identity.js";
import {
  readJsonFile,
  relativeContainedPath,
  sha256File,
  writeJsonAtomic,
  writeTextAtomic,
} from "../io/files.js";
import {
  readDatasetDescriptors,
  readDerivedIdentities,
  readGeneratedDrafts,
  writeDatasetDescriptors,
  writeGeneratedDrafts,
} from "../materialization/io.js";
import {
  materializeResultDrafts,
  projectModelDrafts,
} from "../materialization/tidas.js";
import {
  buildCanonicalTidasTree,
  canonicalIndexDocument,
} from "../materialization/finalize.js";
import type { GeneratedDatasetDraft } from "../materialization/types.js";
import { loadFrozenSourceClosure } from "../source/closure.js";
import {
  datasetHashes,
  resolveGeneratedVersionSet,
  type PreviousReleaseDataset,
} from "../versioning/descriptors.js";
import { validateCanonicalTidasTree } from "../validation/tidas.js";
import { numericParityReport } from "../validation/numeric.js";
import {
  approvalStage,
  publishStage,
  readbackVerifyStage,
} from "../publication/remote-stages.js";
import {
  ExternalCommandError,
  runJsonCommand,
  tidasToolsExecutable,
} from "../tools/external.js";
import {
  formatDatasetVersion,
  parseDatasetVersion,
} from "../versioning/dataset-version.js";
import { assertStageId, STAGE_IDS, type StageId } from "./catalog.js";
import type {
  ReleaseRunRecord,
  StageArtifact,
  StageRecord,
  StageStatus,
} from "./types.js";
import { releaseWorkspaceLayout } from "../workspace/layout.js";
import {
  readReleaseRun,
  type ReleaseRequest,
  writeReleaseRun,
} from "../workspace/run-store.js";

type StageResult = {
  summary: string;
  inputHashes?: Record<string, string>;
  outputHashes?: Record<string, string>;
  artifacts?: StageArtifact[];
  warnings?: StageRecord["warnings"];
  blockers?: StageRecord["blockers"];
  decisions?: string[];
  nextCommands?: string[];
  status?: "passed" | "blocked";
};

type BundleLock = {
  schemaVersion: "tiangong.release.calculation-bundle-lock.v1";
  manifestPath: string;
  manifestSha256: string;
  bundleContentHash: string;
  artifactCount: number;
};

function stageIndex(stageId: StageId): number {
  return STAGE_IDS.indexOf(stageId);
}

function nextCommand(runDirectory: string, stageId: StageId): string[] {
  const index = stageIndex(stageId);
  const next = STAGE_IDS[index + 1];
  return next
    ? [
        `tiangong-release run-stage --run-dir ${path.resolve(runDirectory)} --stage ${next}`,
      ]
    : [];
}

function assertPredecessors(run: ReleaseRunRecord, stageId: StageId): void {
  const index = stageIndex(stageId);
  const incomplete = run.stages
    .slice(0, index)
    .find((stage) => stage.status !== "passed" && stage.status !== "skipped");
  if (incomplete) {
    throw new Error(
      `stage_predecessor_incomplete:${incomplete.stageId}:${incomplete.status}`,
    );
  }
}

function assertNoCompletedSuccessors(
  run: ReleaseRunRecord,
  stageId: StageId,
): void {
  const completed = run.stages
    .slice(stageIndex(stageId) + 1)
    .find((stage) => stage.status === "passed" || stage.status === "skipped");
  if (completed) {
    throw new Error(`stage_successor_already_completed:${completed.stageId}`);
  }
}

function readRequest(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): ReleaseRequest {
  return readJsonFile<ReleaseRequest>(layout.request);
}

function resolveWorkspaceReference(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  value: string,
) {
  return path.isAbsolute(value) ? value : path.resolve(layout.root, value);
}

async function writeStageJsonArtifact(
  filePath: string,
  value: JsonValue,
  mediaType = "application/json",
): Promise<StageArtifact> {
  writeJsonAtomic(filePath, value);
  return { path: filePath, sha256: await sha256File(filePath), mediaType };
}

async function resolveCalculationBundleStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const request = readRequest(layout);
  const manifestPath = resolveWorkspaceReference(
    layout,
    request.calculationBundle.manifestPath,
  );
  const manifest = assertCalculationBundleManifest(
    readJsonFile<unknown>(manifestPath),
  );
  const calculatedBundleHash = calculateBundleContentHash(manifest);
  if (
    manifest.bundleContentHash !== calculatedBundleHash ||
    request.calculationBundle.bundleContentHash !== calculatedBundleHash
  ) {
    throw new Error("calculation_bundle_content_hash_mismatch");
  }
  if (
    request.scope.coverageMode !== manifest.scope.coverageMode ||
    request.scope.selectionManifestHash !== manifest.scope.selectionManifestHash
  ) {
    throw new Error("calculation_bundle_scope_mismatch");
  }
  const manifestSha256 = await sha256File(manifestPath);
  const artifactVerifications = await verifyBundleArtifacts(
    manifest,
    bundleDirectoryForManifest(manifestPath),
  );
  const lock: BundleLock = {
    schemaVersion: "tiangong.release.calculation-bundle-lock.v1",
    manifestPath,
    manifestSha256,
    bundleContentHash: calculatedBundleHash,
    artifactCount: artifactVerifications.length,
  };
  const lockPath = path.join(layout.outputs, "calculation-bundle-lock.json");
  const artifact = await writeStageJsonArtifact(
    lockPath,
    lock as unknown as JsonValue,
  );
  return {
    summary: `Calculation Bundle ${manifest.calculationId} and ${artifactVerifications.length} artifacts were hash-verified.`,
    inputHashes: { request: request.calculationBundle.bundleContentHash },
    outputHashes: {
      bundle: calculatedBundleHash,
      manifest: manifestSha256,
      lock: artifact.sha256,
    },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "resolve-calculation-bundle"),
  };
}

function readBundleFromLock(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): {
  lock: BundleLock;
  manifest: CalculationBundleManifest;
} {
  const lock = readJsonFile<BundleLock>(
    path.join(layout.outputs, "calculation-bundle-lock.json"),
  );
  return {
    lock,
    manifest: assertCalculationBundleManifest(
      readJsonFile<unknown>(lock.manifestPath),
    ),
  };
}

async function verifyGraphEvidenceStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const { lock, manifest } = readBundleFromLock(layout);
  const bundleDirectory = bundleDirectoryForManifest(lock.manifestPath);
  const processes = await loadBundleProcessRecords(manifest, bundleDirectory);
  const graphCounts = await verifyGraphEvidenceRecords(
    manifest,
    bundleDirectory,
  );
  const report = {
    schemaVersion: "tiangong.release.graph-evidence-report.v1",
    status: "passed",
    processCount: processes.length,
    graphCounts,
    quantitativeReferenceCount: processes.length,
  };
  const artifact = await writeStageJsonArtifact(
    path.join(layout.reports, "graph-evidence-report.json"),
    report as unknown as JsonValue,
  );
  return {
    summary: `${processes.length} process identities and direct graph evidence passed the v1 gate.`,
    inputHashes: { bundle: lock.bundleContentHash },
    outputHashes: { report: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "verify-graph-evidence"),
  };
}

async function deriveIdentitiesStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const { lock, manifest } = readBundleFromLock(layout);
  const processes = await loadBundleProcessRecords(
    manifest,
    bundleDirectoryForManifest(lock.manifestPath),
  );
  const identities = processes.map((processRecord) => {
    const processIdentity = processIdentityDocument({
      rootProcessUuid: processRecord.rootProcess.id,
      referenceFlowUuid: processRecord.quantitativeReference.flow.id,
    });
    const modelUuid = generatedModelUuid(processIdentity);
    const resultIdentity = resultIdentityDocument({
      lifecycleModelUuid: modelUuid,
    });
    const resultProcessUuid = generatedResultProcessUuid(resultIdentity);
    return {
      schemaVersion: "tiangong.release.derived-identity.v1",
      processIndex: processRecord.processIndex,
      rootProcess: processRecord.rootProcess,
      processIdentity,
      modelUuid,
      resultIdentity,
      resultProcessUuid,
    };
  });
  const lines = identities.map((identity) =>
    canonicalize(identity as unknown as JsonValue),
  );
  writeTextAtomic(layout.identities, `${lines.join("\n")}\n`);
  const sha256 = await sha256File(layout.identities);
  return {
    summary: `Derived stable Model and Result lineages for ${identities.length} processes.`,
    inputHashes: { bundle: lock.bundleContentHash },
    outputHashes: { identities: sha256 },
    artifacts: [
      { path: layout.identities, sha256, mediaType: "application/x-ndjson" },
    ],
    nextCommands: nextCommand(layout.root, "derive-identities"),
  };
}

async function loadPreviousReleaseStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const request = readRequest(layout);
  const sourcePath = request.previousReleaseManifestPath
    ? resolveWorkspaceReference(layout, request.previousReleaseManifestPath)
    : null;
  let output: JsonValue;
  if (sourcePath) {
    output = JSON.parse(readFileSync(sourcePath, "utf8")) as JsonValue;
  } else {
    output = {
      schemaVersion: "tiangong.release.previous-manifest.v1",
      status: "none",
      datasets: [],
      releases: [],
    };
  }
  const artifact = await writeStageJsonArtifact(
    layout.previousManifest,
    output,
  );
  return {
    summary: sourcePath
      ? "Previous published Release Manifest was frozen for version planning."
      : "No previous Release Manifest was supplied; all generated lineages start at 01.00.000.",
    inputHashes: sourcePath ? { source: await sha256File(sourcePath) } : {},
    outputHashes: { previousManifest: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "load-previous-release"),
  };
}

async function frozenSourceClosure(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
) {
  const request = readRequest(layout);
  return loadFrozenSourceClosure({
    directory: resolveWorkspaceReference(
      layout,
      request.sourceClosure.directory,
    ),
    manifestHash: request.sourceClosure.manifestHash,
  });
}

async function projectModelDraftsStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const { lock, manifest } = readBundleFromLock(layout);
  const bundleDirectory = bundleDirectoryForManifest(lock.manifestPath);
  const [processes, edges, sourceClosure] = await Promise.all([
    loadBundleProcessRecords(manifest, bundleDirectory),
    loadTechnosphereRecords(manifest, bundleDirectory),
    frozenSourceClosure(layout),
  ]);
  const identities = readDerivedIdentities(layout.identities);
  const drafts = projectModelDrafts({
    processes,
    identities,
    edges,
    sourceClosure,
  });
  writeGeneratedDrafts(layout.modelDrafts, drafts);
  const sha256 = await sha256File(layout.modelDrafts);
  return {
    summary: `Projected ${drafts.length} one-hop LifecycleModel drafts from ${edges.length} direct provider edges.`,
    inputHashes: {
      bundle: lock.bundleContentHash,
      sourceClosure: sourceClosure.manifestSha256,
    },
    outputHashes: { modelDrafts: sha256 },
    artifacts: [
      { path: layout.modelDrafts, sha256, mediaType: "application/x-ndjson" },
    ],
    nextCommands: nextCommand(layout.root, "project-model-drafts"),
  };
}

async function materializeResultDraftsStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const { lock, manifest } = readBundleFromLock(layout);
  const bundleDirectory = bundleDirectoryForManifest(lock.manifestPath);
  const [processes, lci, lcia, sourceClosure] = await Promise.all([
    loadBundleProcessRecords(manifest, bundleDirectory),
    loadLciRecords(manifest, bundleDirectory),
    loadLciaRecords(manifest, bundleDirectory),
    frozenSourceClosure(layout),
  ]);
  const identities = readDerivedIdentities(layout.identities);
  const drafts = materializeResultDrafts({
    processes,
    identities,
    lci,
    lcia,
    sourceClosure,
  });
  writeGeneratedDrafts(layout.resultDrafts, drafts);
  const sha256 = await sha256File(layout.resultDrafts);
  return {
    summary: `Materialized ${drafts.length} Result Process drafts with ${lci.length} directional LCI rows and ${lcia.length} LCIA rows.`,
    inputHashes: {
      bundle: lock.bundleContentHash,
      sourceClosure: sourceClosure.manifestSha256,
    },
    outputHashes: { resultDrafts: sha256 },
    artifacts: [
      { path: layout.resultDrafts, sha256, mediaType: "application/x-ndjson" },
    ],
    nextCommands: nextCommand(layout.root, "materialize-result-drafts"),
  };
}

function assertMetadataComplete(draft: GeneratedDatasetDraft): void {
  const serialized = canonicalize(draft.document);
  if (/__RUNTIME_|\bTODO\b|\bTBD\b/.test(serialized)) {
    throw new Error(
      `metadata_unresolved_placeholder:${draft.datasetType}:${draft.uuid}`,
    );
  }
  const root = draft.document as Record<string, any>;
  if (draft.datasetType === "lifecyclemodel") {
    const dataSet = root.lifeCycleModelDataSet;
    if (
      !dataSet?.lifeCycleModelInformation?.dataSetInformation
        ?.referenceToResultingProcess ||
      !dataSet?.modellingAndValidation?.validation ||
      !dataSet?.administrativeInformation?.publicationAndOwnership
    ) {
      throw new Error(`metadata_lifecycle_model_incomplete:${draft.uuid}`);
    }
  } else {
    const dataSet = root.processDataSet;
    if (
      dataSet?.modellingAndValidation?.LCIMethodAndAllocation?.typeOfDataSet !==
        "LCI result" ||
      !Array.isArray(dataSet?.exchanges?.exchange) ||
      !Array.isArray(dataSet?.LCIAResults?.LCIAResult)
    ) {
      throw new Error(`metadata_result_process_incomplete:${draft.uuid}`);
    }
  }
}

async function metadataCompletionStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const drafts = [
    ...readGeneratedDrafts(layout.modelDrafts),
    ...readGeneratedDrafts(layout.resultDrafts),
  ];
  drafts.forEach(assertMetadataComplete);
  writeGeneratedDrafts(layout.metadataDrafts, drafts);
  const sha256 = await sha256File(layout.metadataDrafts);
  return {
    summary: `${drafts.length} generated datasets passed deterministic metadata completeness checks.`,
    inputHashes: {
      modelDrafts: await sha256File(layout.modelDrafts),
      resultDrafts: await sha256File(layout.resultDrafts),
    },
    outputHashes: { metadataDrafts: sha256 },
    artifacts: [
      {
        path: layout.metadataDrafts,
        sha256,
        mediaType: "application/x-ndjson",
      },
    ],
    nextCommands: nextCommand(layout.root, "metadata-completion"),
  };
}

async function descriptorDraftsStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const drafts = readGeneratedDrafts(layout.metadataDrafts);
  const descriptors = drafts.map((draft) => ({
    datasetType: draft.datasetType,
    role: draft.role,
    processIndex: draft.processIndex,
    uuid: draft.uuid,
    provisionalVersion: "01.00.000",
    ...datasetHashes(draft),
  }));
  const document = {
    schemaVersion: "tiangong.release.descriptor-drafts.v1",
    descriptors,
  } as unknown as JsonValue;
  const artifact = await writeStageJsonArtifact(
    layout.descriptorDrafts,
    document,
  );
  return {
    summary: `Built version-significant, semantic, and canonical draft hashes for ${drafts.length} datasets.`,
    inputHashes: { metadataDrafts: await sha256File(layout.metadataDrafts) },
    outputHashes: { descriptorDrafts: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(
      layout.root,
      "build-version-significant-descriptors",
    ),
  };
}

function previousReleaseDatasets(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): PreviousReleaseDataset[] {
  const previous = readJsonFile<Record<string, unknown>>(
    layout.previousManifest,
  );
  const datasets = previous.datasets;
  if (!Array.isArray(datasets)) {
    throw new Error("previous_release_datasets_invalid");
  }
  return datasets.filter(
    (dataset): dataset is PreviousReleaseDataset =>
      Boolean(dataset) &&
      typeof dataset === "object" &&
      typeof (dataset as PreviousReleaseDataset).datasetType === "string" &&
      typeof (dataset as PreviousReleaseDataset).uuid === "string" &&
      typeof (dataset as PreviousReleaseDataset).version === "string" &&
      typeof (dataset as PreviousReleaseDataset).versionSignificantHash ===
        "string" &&
      typeof (dataset as PreviousReleaseDataset).semanticHash === "string" &&
      typeof (dataset as PreviousReleaseDataset).canonicalContentHash ===
        "string",
  );
}

async function resolveVersionSetStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const drafts = readGeneratedDrafts(layout.metadataDrafts);
  const resolved = resolveGeneratedVersionSet({
    drafts,
    previous: previousReleaseDatasets(layout),
  });
  const plan = {
    schemaVersion: "tiangong.release.version-plan.v1",
    convergenceRoundsMaximum: 2,
    datasets: resolved.map(({ document: _document, ...dataset }) => dataset),
  } as unknown as JsonValue;
  const artifact = await writeStageJsonArtifact(layout.versionPlan, plan);
  return {
    summary: `Resolved a converged exact public version set for ${resolved.length} generated datasets.`,
    inputHashes: {
      descriptors: await sha256File(layout.descriptorDrafts),
      previousRelease: await sha256File(layout.previousManifest),
    },
    outputHashes: { versionPlan: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "resolve-final-version-set"),
  };
}

async function renderExactReferencesStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const resolved = resolveGeneratedVersionSet({
    drafts: readGeneratedDrafts(layout.metadataDrafts),
    previous: previousReleaseDatasets(layout),
  });
  writeDatasetDescriptors(layout.renderedDatasets, resolved);
  const sha256 = await sha256File(layout.renderedDatasets);
  return {
    summary: `Rendered exact generated UUID/version references into ${resolved.length} datasets.`,
    inputHashes: { versionPlan: await sha256File(layout.versionPlan) },
    outputHashes: { renderedDatasets: sha256 },
    artifacts: [
      {
        path: layout.renderedDatasets,
        sha256,
        mediaType: "application/x-ndjson",
      },
    ],
    nextCommands: nextCommand(layout.root, "render-exact-references"),
  };
}

async function finalizeCanonicalArtifactsStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const generated = readDatasetDescriptors(layout.renderedDatasets);
  for (const descriptor of generated) {
    const hashes = datasetHashes({
      schemaVersion: "tiangong.release.generated-dataset-draft.v1",
      datasetType: descriptor.datasetType,
      role: descriptor.role,
      processIndex: descriptor.processIndex,
      uuid: descriptor.uuid,
      sourceProcess: descriptor.sourceProcess,
      document: descriptor.document,
    });
    if (
      hashes.versionSignificantHash !== descriptor.versionSignificantHash ||
      hashes.semanticHash !== descriptor.semanticHash ||
      hashes.canonicalContentHash !== descriptor.canonicalContentHash
    ) {
      throw new Error(`finalized_descriptor_hash_mismatch:${descriptor.uuid}`);
    }
  }
  const sourceClosure = await frozenSourceClosure(layout);
  const index = await buildCanonicalTidasTree({
    outputDirectory: layout.canonicalTidas,
    sourceClosure,
    generated,
  });
  const artifact = await writeStageJsonArtifact(
    layout.canonicalDatasetIndex,
    canonicalIndexDocument(index),
  );
  return {
    summary: `Finalized ${generated.length} generated and ${sourceClosure.datasets.length} frozen source datasets into the canonical TIDAS tree.`,
    inputHashes: {
      renderedDatasets: await sha256File(layout.renderedDatasets),
      sourceClosure: sourceClosure.manifestSha256,
    },
    outputHashes: {
      canonicalDatasetIndex: artifact.sha256,
      artifactSet: canonicalSha256(index as unknown as JsonValue),
    },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "finalize-canonical-artifacts"),
  };
}

async function validateTidasStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const report = validateCanonicalTidasTree(layout.canonicalTidas);
  const tidasArtifact = await writeStageJsonArtifact(
    path.join(layout.reports, "tidas-validation-report.json"),
    report,
  );
  const { lock, manifest } = readBundleFromLock(layout);
  const bundleDirectory = bundleDirectoryForManifest(lock.manifestPath);
  const [processes, lci, lcia] = await Promise.all([
    loadBundleProcessRecords(manifest, bundleDirectory),
    loadLciRecords(manifest, bundleDirectory),
    loadLciaRecords(manifest, bundleDirectory),
  ]);
  const parity = numericParityReport({
    processes,
    lci,
    lcia,
    generated: readDatasetDescriptors(layout.renderedDatasets),
  });
  const parityArtifact = await writeStageJsonArtifact(
    path.join(layout.reports, "numeric-parity-report.json"),
    parity,
  );
  if (report.status !== "passed" || parity.status !== "passed") {
    return {
      status: "blocked",
      summary:
        "Canonical TIDAS datasets failed schema, runtime, or numeric parity validation.",
      inputHashes: {
        canonicalDatasetIndex: await sha256File(layout.canonicalDatasetIndex),
      },
      outputHashes: {
        validationReport: tidasArtifact.sha256,
        numericParity: parityArtifact.sha256,
      },
      artifacts: [tidasArtifact, parityArtifact],
      blockers: [
        {
          code: "tidas_validation_failed",
          message:
            "Resolve every error in reports/tidas-validation-report.json and rerun.",
          subject: layout.canonicalTidas,
        },
      ],
      nextCommands: [
        `tiangong-release run-stage --run-dir ${layout.root} --stage validate-tidas`,
      ],
    };
  }
  return {
    summary: "Canonical TIDAS datasets passed schema and runtime validation.",
    inputHashes: {
      canonicalDatasetIndex: await sha256File(layout.canonicalDatasetIndex),
    },
    outputHashes: {
      validationReport: tidasArtifact.sha256,
      numericParity: parityArtifact.sha256,
    },
    artifacts: [tidasArtifact, parityArtifact],
    nextCommands: nextCommand(layout.root, "validate-tidas"),
  };
}

async function invokeTidasTool(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  args: string[],
): Promise<{ result: JsonValue; failed: boolean; code?: string }> {
  try {
    return {
      result: await runJsonCommand({
        executable: tidasToolsExecutable(),
        args,
        cwd: layout.root,
      }),
      failed: false,
    };
  } catch (error) {
    if (error instanceof ExternalCommandError && error.result) {
      return { result: error.result, failed: true, code: error.code };
    }
    throw error;
  }
}

function blockedToolGate(input: {
  stageId: StageId;
  code: string;
  report: StageArtifact;
  layout: ReturnType<typeof releaseWorkspaceLayout>;
  summary: string;
}): StageResult {
  return {
    status: "blocked",
    summary: input.summary,
    outputHashes: { report: input.report.sha256 },
    artifacts: [input.report],
    blockers: [
      {
        code: input.code,
        message: `Inspect ${input.report.path} and rerun ${input.stageId}.`,
        subject: input.stageId,
      },
    ],
    nextCommands: [
      `tiangong-release run-stage --run-dir ${input.layout.root} --stage ${input.stageId}`,
    ],
  };
}

async function convertIlcdStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const toolValidation = await invokeTidasTool(layout, [
    "validate-tidas",
    "--input-dir",
    layout.canonicalTidas,
  ]);
  const validationArtifact = await writeStageJsonArtifact(
    path.join(layout.reports, "tidas-tools-validation-report.json"),
    toolValidation.result,
  );
  if (toolValidation.failed) {
    return blockedToolGate({
      stageId: "convert-ilcd",
      code: toolValidation.code ?? "tidas_tools_validation_failed",
      report: validationArtifact,
      layout,
      summary:
        "tidas-tools rejected the canonical TIDAS tree before conversion.",
    });
  }
  const conversion = await invokeTidasTool(layout, [
    "convert-ilcd",
    "--input-dir",
    layout.canonicalTidas,
    "--output-dir",
    layout.ilcd,
  ]);
  const conversionArtifact = await writeStageJsonArtifact(
    path.join(layout.reports, "ilcd-conversion-report.json"),
    conversion.result,
  );
  if (conversion.failed) {
    return blockedToolGate({
      stageId: "convert-ilcd",
      code: conversion.code ?? "ilcd_conversion_failed",
      report: conversionArtifact,
      layout,
      summary: "Canonical TIDAS to ILCD conversion failed.",
    });
  }
  return {
    summary:
      "tidas-tools validated the canonical tree and converted it to ILCD.",
    inputHashes: {
      canonicalDatasetIndex: await sha256File(layout.canonicalDatasetIndex),
    },
    outputHashes: {
      toolValidation: validationArtifact.sha256,
      conversion: conversionArtifact.sha256,
    },
    artifacts: [validationArtifact, conversionArtifact],
    nextCommands: nextCommand(layout.root, "convert-ilcd"),
  };
}

async function validateIlcdStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const validation = await invokeTidasTool(layout, [
    "validate-ilcd",
    "--input-dir",
    layout.ilcd,
  ]);
  const artifact = await writeStageJsonArtifact(
    path.join(layout.reports, "ilcd-validation-report.json"),
    validation.result,
  );
  if (validation.failed) {
    return blockedToolGate({
      stageId: "validate-ilcd",
      code: validation.code ?? "ilcd_validation_failed",
      report: artifact,
      layout,
      summary: "ILCD schema validation failed.",
    });
  }
  return {
    summary: "ILCD datasets passed packaged XSD validation.",
    inputHashes: {
      conversion: await sha256File(
        path.join(layout.reports, "ilcd-conversion-report.json"),
      ),
    },
    outputHashes: { validation: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "validate-ilcd"),
  };
}

async function semanticRoundtripStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const roundtrip = await invokeTidasTool(layout, [
    "semantic-roundtrip",
    "--tidas-dir",
    layout.canonicalTidas,
    "--ilcd-dir",
    layout.ilcd,
  ]);
  const artifact = await writeStageJsonArtifact(
    path.join(layout.reports, "semantic-roundtrip-report.json"),
    roundtrip.result,
  );
  if (roundtrip.failed) {
    return blockedToolGate({
      stageId: "semantic-roundtrip",
      code: roundtrip.code ?? "semantic_roundtrip_failed",
      report: artifact,
      layout,
      summary:
        "TIDAS to ILCD semantic round-trip changed normalized dataset content.",
    });
  }
  return {
    summary:
      "All canonical datasets survived the normalized TIDAS/ILCD semantic round-trip.",
    inputHashes: {
      tidas: await sha256File(layout.canonicalDatasetIndex),
      ilcdValidation: await sha256File(
        path.join(layout.reports, "ilcd-validation-report.json"),
      ),
    },
    outputHashes: { roundtrip: artifact.sha256 },
    artifacts: [artifact],
    nextCommands: nextCommand(layout.root, "semantic-roundtrip"),
  };
}

function workspaceArtifactReference(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  filePath: string,
  sha256: string,
  mediaType: string,
): JsonValue {
  return {
    path: relativeContainedPath(layout.root, filePath),
    sha256,
    byteSize: statSync(filePath).size,
    mediaType,
  };
}

async function reportArtifactReference(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  fileName: string,
): Promise<JsonValue> {
  const filePath = path.join(layout.reports, fileName);
  return workspaceArtifactReference(
    layout,
    filePath,
    await sha256File(filePath),
    "application/json",
  );
}

function releaseVersion(
  previous: Record<string, unknown>,
  artifactSetHash: string,
): string {
  const previousVersion = previous.releaseVersion;
  if (typeof previousVersion !== "string") return "01.00.000";
  if (previous.artifactSetHash === artifactSetHash) return previousVersion;
  const parsed = parseDatasetVersion(previousVersion);
  return formatDatasetVersion({
    major: parsed.major + 1,
    minor: 0,
    revision: 0,
  });
}

async function buildPackagesStage(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
): Promise<StageResult> {
  const request = readRequest(layout);
  if (request.scope.coverageMode !== "global_eligible") {
    return {
      status: "blocked",
      summary:
        "Subset calculations may be previewed but cannot become public release packages.",
      blockers: [
        {
          code: "subset_publication_forbidden",
          message:
            "Recalculate with coverageMode=global_eligible before packaging.",
          subject: request.releaseRunId,
        },
      ],
      nextCommands: [],
    };
  }
  const packaging = await invokeTidasTool(layout, [
    "build-packages",
    "--tidas-dir",
    layout.canonicalTidas,
    "--ilcd-dir",
    layout.ilcd,
    "--dataset-index",
    layout.canonicalDatasetIndex,
    "--output-dir",
    layout.packages,
  ]);
  const packageReportPath = path.join(
    layout.reports,
    "release-packages-report.json",
  );
  const packageArtifact = await writeStageJsonArtifact(
    packageReportPath,
    packaging.result,
  );
  if (packaging.failed) {
    return blockedToolGate({
      stageId: "build-packages",
      code: packaging.code ?? "release_packages_failed",
      report: packageArtifact,
      layout,
      summary:
        "Release package closure or deterministic ZIP construction failed.",
    });
  }

  const packageResult = packaging.result as Record<string, any>;
  if (
    !Array.isArray(packageResult.packages) ||
    packageResult.packages.length !== 4
  ) {
    throw new Error("release_package_cardinality_invalid");
  }
  const packages = packageResult.packages.map((item: Record<string, any>) => ({
    profileId: item.profileId,
    format: item.format,
    selfContained: item.selfContained,
    closureHash: item.closureHash,
    artifact: workspaceArtifactReference(
      layout,
      item.artifact.path,
      item.artifact.sha256,
      "application/zip",
    ),
  }));
  const canonicalIndex = readJsonFile<Record<string, any>>(
    layout.canonicalDatasetIndex,
  );
  const generated = readDatasetDescriptors(layout.renderedDatasets);
  const datasets = canonicalIndex.datasets.map((entry: Record<string, any>) => {
    const descriptor = generated.find(
      (item) =>
        item.datasetType === entry.datasetType &&
        item.uuid === entry.uuid &&
        item.version === entry.version,
    );
    const canonicalContentHash = String(entry.canonicalContentHash);
    return {
      datasetType: entry.datasetType,
      role: entry.role,
      uuid: entry.uuid,
      version: entry.version,
      ...(entry.sourceProcess ? { sourceProcess: entry.sourceProcess } : {}),
      versionSignificantHash:
        descriptor?.versionSignificantHash ?? canonicalContentHash,
      semanticHash: descriptor?.semanticHash ?? canonicalContentHash,
      canonicalContentHash,
      lineageKeyHash: canonicalSha256({
        datasetType: entry.datasetType,
        uuid: entry.uuid,
      }),
      artifact: workspaceArtifactReference(
        layout,
        path.join(layout.canonicalTidas, entry.path),
        entry.sha256,
        "application/json",
      ),
    };
  });
  const previous = readJsonFile<Record<string, unknown>>(
    layout.previousManifest,
  );
  const artifactSetHash = String(packageResult.artifactSetHash);
  const version = releaseVersion(previous, artifactSetHash);
  const publishPlanBody = {
    schemaVersion: "tiangong.release.publish-plan-input.v1",
    releaseRunId: request.releaseRunId,
    releaseVersion: version,
    profileLockHash: readReleaseRun(layout.root).profileLockHash,
    calculationBundleHash: request.calculationBundle.bundleContentHash,
    artifactSetHash,
    datasets: datasets.map((dataset: Record<string, any>) => ({
      datasetType: dataset.datasetType,
      role: dataset.role,
      uuid: dataset.uuid,
      version: dataset.version,
      ...(dataset.sourceProcess
        ? { sourceProcess: dataset.sourceProcess }
        : {}),
      canonicalContentHash: dataset.canonicalContentHash,
    })),
    packages: packages.map((item: Record<string, any>) => ({
      profileId: item.profileId,
      format: item.format,
      sha256: item.artifact.sha256,
    })),
  };
  const publishPlanHash = canonicalSha256(
    publishPlanBody as unknown as JsonValue,
  );
  const lock = readJsonFile<BundleLock>(
    path.join(layout.outputs, "calculation-bundle-lock.json"),
  );
  const manifest = readBundleFromLock(layout).manifest;
  const releaseManifest = {
    schemaVersion: "tiangong.release-manifest.v1",
    releaseRunId: request.releaseRunId,
    releaseVersion: version,
    scope: {
      coverageMode: "global_eligible",
      selectionManifestHash: request.scope.selectionManifestHash,
      processCount: manifest.scope.processCount,
    },
    profileLockHash: readReleaseRun(layout.root).profileLockHash,
    calculationBundle: {
      calculationId: manifest.calculationId,
      bundleContentHash: lock.bundleContentHash,
      manifestSha256: lock.manifestSha256,
    },
    datasets,
    packages,
    validation: {
      tidas: {
        status: "passed",
        report: await reportArtifactReference(
          layout,
          "tidas-validation-report.json",
        ),
      },
      ilcd: {
        status: "passed",
        report: await reportArtifactReference(
          layout,
          "ilcd-validation-report.json",
        ),
      },
      semanticRoundtrip: {
        status: "passed",
        report: await reportArtifactReference(
          layout,
          "semantic-roundtrip-report.json",
        ),
      },
      referenceClosure: {
        status: "passed",
        report: workspaceArtifactReference(
          layout,
          packageReportPath,
          packageArtifact.sha256,
          "application/json",
        ),
      },
      numericParity: {
        status: "passed",
        report: await reportArtifactReference(
          layout,
          "numeric-parity-report.json",
        ),
      },
    },
    artifactSetHash,
    publishPlanHash,
  } as unknown as JsonValue;
  const manifestArtifact = await writeStageJsonArtifact(
    layout.releaseManifest,
    releaseManifest,
  );
  const plan = {
    ...publishPlanBody,
    schemaVersion: "tiangong.release.publish-plan.v1",
    planHash: publishPlanHash,
    releaseManifest: workspaceArtifactReference(
      layout,
      layout.releaseManifest,
      manifestArtifact.sha256,
      "application/json",
    ),
  } as unknown as JsonValue;
  const planArtifact = await writeStageJsonArtifact(layout.publishPlan, plan);
  return {
    summary: `Built four deterministic self-contained release packages and immutable publish plan ${publishPlanHash}.`,
    inputHashes: {
      tidas: await sha256File(layout.canonicalDatasetIndex),
      ilcdValidation: await sha256File(
        path.join(layout.reports, "ilcd-validation-report.json"),
      ),
      semanticRoundtrip: await sha256File(
        path.join(layout.reports, "semantic-roundtrip-report.json"),
      ),
    },
    outputHashes: {
      packageReport: packageArtifact.sha256,
      releaseManifest: manifestArtifact.sha256,
      publishPlan: planArtifact.sha256,
      publishPlanHash,
      artifactSetHash,
    },
    artifacts: [packageArtifact, manifestArtifact, planArtifact],
    nextCommands: nextCommand(layout.root, "build-packages"),
  };
}

async function executeStageHandler(
  layout: ReturnType<typeof releaseWorkspaceLayout>,
  stageId: StageId,
): Promise<StageResult> {
  switch (stageId) {
    case "intake":
      return {
        status: "passed",
        summary: "Intake was completed during workspace initialization.",
        nextCommands: nextCommand(layout.root, stageId),
      };
    case "resolve-calculation-bundle":
      return resolveCalculationBundleStage(layout);
    case "verify-graph-evidence":
      return verifyGraphEvidenceStage(layout);
    case "derive-identities":
      return deriveIdentitiesStage(layout);
    case "load-previous-release":
      return loadPreviousReleaseStage(layout);
    case "project-model-drafts":
      return projectModelDraftsStage(layout);
    case "materialize-result-drafts":
      return materializeResultDraftsStage(layout);
    case "metadata-completion":
      return metadataCompletionStage(layout);
    case "build-version-significant-descriptors":
      return descriptorDraftsStage(layout);
    case "resolve-final-version-set":
      return resolveVersionSetStage(layout);
    case "render-exact-references":
      return renderExactReferencesStage(layout);
    case "finalize-canonical-artifacts":
      return finalizeCanonicalArtifactsStage(layout);
    case "validate-tidas":
      return validateTidasStage(layout);
    case "convert-ilcd":
      return convertIlcdStage(layout);
    case "validate-ilcd":
      return validateIlcdStage(layout);
    case "semantic-roundtrip":
      return semanticRoundtripStage(layout);
    case "build-packages":
      return buildPackagesStage(layout);
    case "approval":
      return approvalStage(layout);
    case "publish":
      return publishStage(layout);
    case "readback-verify":
      return readbackVerifyStage(layout);
    default:
      return {
        status: "blocked",
        summary: `Stage ${stageId} has no executable handler yet.`,
        blockers: [
          {
            code: "stage_handler_not_implemented",
            message: `Implement and validate the ${stageId} stage before continuing.`,
            subject: stageId,
          },
        ],
        nextCommands: [],
      };
  }
}

function updateRunStatus(run: ReleaseRunRecord): void {
  if (run.stages.some((stage) => stage.status === "failed")) {
    run.status = "failed";
  } else if (run.stages.some((stage) => stage.status === "blocked")) {
    run.status = "blocked";
  } else if (run.stages[stageIndex("readback-verify")]?.status === "passed") {
    run.status = "verified";
  } else if (run.stages[stageIndex("publish")]?.status === "passed") {
    run.status = "published";
  } else if (run.stages[stageIndex("approval")]?.status === "passed") {
    run.status = "approved";
  } else if (run.stages[stageIndex("build-packages")]?.status === "passed") {
    run.status = "ready_for_approval";
  } else {
    run.status = "active";
  }
}

function stageMarkdown(stage: StageRecord): string {
  const lines = [
    `# ${stage.stageId}`,
    "",
    `Status: ${stage.status}`,
    "",
    stage.summary,
  ];
  if (stage.blockers.length) {
    lines.push("", "## Blockers", "");
    lines.push(
      ...stage.blockers.map(
        (blocker) => `- ${blocker.code}: ${blocker.message}`,
      ),
    );
  }
  if (stage.nextCommands.length) {
    lines.push("", "## Next", "");
    lines.push(...stage.nextCommands.map((command) => `- \`${command}\``));
  }
  return `${lines.join("\n")}\n`;
}

export async function runReleaseStage(
  runDirectory: string,
  value: string,
): Promise<StageRecord> {
  const stageId = assertStageId(value);
  const layout = releaseWorkspaceLayout(runDirectory);
  const run = readReleaseRun(layout.root);
  assertPredecessors(run, stageId);
  assertNoCompletedSuccessors(run, stageId);
  const index = stageIndex(stageId);
  const previous = run.stages[index]!;
  const startedAt = new Date().toISOString();
  run.stages[index] = {
    ...previous,
    status: "running",
    attempt: previous.attempt + 1,
    startedAt,
    completedAt: null,
    warnings: [],
    blockers: [],
    decisions: [],
    artifacts: [],
    summary: "",
    nextCommands: [],
  };
  updateRunStatus(run);
  writeReleaseRun(layout.root, run);

  try {
    const result = await executeStageHandler(layout, stageId);
    const completed: StageRecord = {
      ...run.stages[index]!,
      status: result.status ?? "passed",
      completedAt: new Date().toISOString(),
      inputHashes: result.inputHashes ?? {},
      outputHashes: result.outputHashes ?? {},
      artifacts: result.artifacts ?? [],
      warnings: result.warnings ?? [],
      blockers: result.blockers ?? [],
      decisions: result.decisions ?? [],
      summary: result.summary,
      nextCommands: result.nextCommands ?? [],
    };
    run.stages[index] = completed;
    updateRunStatus(run);
    writeReleaseRun(layout.root, run);
    writeTextAtomic(
      path.join(
        layout.stages,
        `${String(index + 1).padStart(2, "0")}-${stageId}.md`,
      ),
      stageMarkdown(completed),
    );
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: StageRecord = {
      ...run.stages[index]!,
      status: "failed",
      completedAt: new Date().toISOString(),
      blockers: [
        { code: message.split(":", 1)[0]!, message, subject: stageId },
      ],
      summary: `Stage ${stageId} failed.`,
      nextCommands: [
        `tiangong-release run-stage --run-dir ${layout.root} --stage ${stageId}`,
      ],
    };
    run.stages[index] = failed;
    updateRunStatus(run);
    writeReleaseRun(layout.root, run);
    writeTextAtomic(
      path.join(
        layout.stages,
        `${String(index + 1).padStart(2, "0")}-${stageId}.md`,
      ),
      stageMarkdown(failed),
    );
    throw error;
  }
}

export function releaseRunSummary(runDirectory: string) {
  const run = readReleaseRun(runDirectory);
  const layout = releaseWorkspaceLayout(runDirectory);
  const counts = Object.fromEntries(
    ["pending", "running", "passed", "blocked", "failed", "skipped"].map(
      (status) => [
        status,
        run.stages.filter((stage) => stage.status === status).length,
      ],
    ),
  ) as Record<StageStatus, number>;
  const next =
    run.stages.find((stage) => stage.status === "failed") ??
    run.stages.find((stage) => stage.status === "blocked") ??
    run.stages.find((stage) => stage.status === "pending");
  let nextCommands = next?.nextCommands ?? [];
  if (next && nextCommands.length === 0) {
    if (next.stageId === "approval" && !existsSync(layout.approvalDecision)) {
      nextCommands = [
        `tiangong-release decision apply --run-dir ${layout.root} --input <approval-decision.json>`,
      ];
    } else if (next.stageId === "readback-verify") {
      nextCommands = [`tiangong-release verify --run-dir ${layout.root}`];
    } else {
      nextCommands = [
        `tiangong-release run-stage --run-dir ${layout.root} --stage ${next.stageId}`,
      ];
    }
  }
  return {
    schemaVersion: "tiangong.release-status.v1",
    releaseRunId: run.releaseRunId,
    status: run.status,
    complete: counts.passed + counts.skipped === run.stages.length,
    partial:
      counts.passed > 0 && counts.passed + counts.skipped < run.stages.length,
    blocked: counts.blocked > 0,
    ambiguous: run.stages.some(
      (stage) => stage.status === "blocked" && stage.decisions.length > 0,
    ),
    counts,
    nextStage: next?.stageId ?? null,
    nextCommands,
  };
}

export function releasePlan(runDirectory: string) {
  const run = readReleaseRun(runDirectory);
  return {
    schemaVersion: "tiangong.release-plan.v1",
    releaseRunId: run.releaseRunId,
    requestHash: run.requestHash,
    profileLockHash: run.profileLockHash,
    planHash: canonicalSha256({
      requestHash: run.requestHash,
      profileLockHash: run.profileLockHash,
      stages: [...STAGE_IDS],
    }),
    stages: run.stages.map((stage, index) => ({
      order: index + 1,
      stageId: stage.stageId,
      status: stage.status,
      attempt: stage.attempt,
      cacheHit: stage.cache.hit,
      blockers: stage.blockers,
    })),
  };
}
