import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";
import { loadMaterializationContext, selectAxes } from "./context.mjs";
import { RESULT_PROFILE } from "./identity.mjs";
import { renderResultProcess } from "./result-renderer.mjs";
import {
  assertNoContentCollision,
  hashJson,
  indexPrevious,
  resolveVersion,
  versionSignificantHash,
} from "./versioning.mjs";

export async function materializeResults({
  intakeDir,
  outDir,
  processUuids,
  firstGeneration = false,
  previousManifestPath,
}) {
  if (firstGeneration === Boolean(previousManifestPath)) {
    fail(
      "version_history_choice_required",
      "Choose exactly one of --first-generation or --previous-manifest",
    );
  }
  const previousManifest = previousManifestPath
    ? JSON.parse(await readFile(path.resolve(previousManifestPath), "utf8"))
    : null;
  const previous = indexPrevious(previousManifest);
  const context = await loadMaterializationContext(intakeDir);
  const rootAxes = selectAxes(context, processUuids);
  if (!rootAxes.length)
    fail("empty_selection", "Result materialization selection is empty");
  const rootIndexes = new Set(rootAxes.map((axis) => axis.processIndex));
  const requiredIndexes = new Set(rootIndexes);
  for (const edge of context.technosphereEdges) {
    if (rootIndexes.has(edge.dependentProcessIndex)) {
      requiredIndexes.add(edge.balancingProcessIndex);
    }
  }
  const axes = context.axes.filter((axis) =>
    requiredIndexes.has(axis.processIndex),
  );
  const descriptors = [];
  for (const axis of axes) {
    const provisional = renderResultProcess(context, axis, "01.00.000");
    const hashes = resultHashes(provisional);
    const historical = previous.get(`process:${provisional.uuid}`);
    const resolution = resolveVersion(
      { uuid: provisional.uuid, ...hashes },
      historical,
    );
    const rendered = renderResultProcess(context, axis, resolution.version);
    const finalHashes = resultHashes(rendered);
    const descriptor = {
      schemaVersion: "tiangong.release.dataset-descriptor.v1",
      datasetType: "process",
      role: "result_process",
      processIndex: axis.processIndex,
      uuid: rendered.uuid,
      version: rendered.version,
      profile: RESULT_PROFILE,
      sourceProcess: rendered.sourceProcess,
      identity: rendered.identity,
      versionChange: resolution.change,
      ...finalHashes,
      counts: rendered.counts,
      document: rendered.document,
    };
    assertNoContentCollision(descriptor, historical);
    descriptors.push(descriptor);
  }
  descriptors.sort((left, right) => left.processIndex - right.processIndex);
  const target = path.resolve(outDir);
  const staging = await mkdtemp(`${target}.tmp-`);
  try {
    const datasetDir = path.join(staging, "canonical-datasets", "processes");
    await mkdir(datasetDir, { recursive: true });
    const catalogDatasets = [];
    for (const descriptor of descriptors) {
      const fileName = `${descriptor.uuid}_${descriptor.version}.json`;
      await writeFile(
        path.join(datasetDir, fileName),
        canonicalJson(descriptor.document),
        { flag: "wx" },
      );
      const { document: _document, ...catalogEntry } = descriptor;
      catalogDatasets.push({
        ...catalogEntry,
        path: `canonical-datasets/processes/${fileName}`,
      });
    }
    const catalog = {
      schemaVersion: "tiangong.release.result-catalog.v1",
      completeness: "complete-for-selection",
      calculationId: context.intake.source.calculationId,
      bundleContentHash: context.intake.source.bundleContentHash,
      selection: rootAxes.map((axis) => axis.rootProcess).sort(compareIdentity),
      requiredResults: axes
        .map((axis) => axis.rootProcess)
        .sort(compareIdentity),
      datasets: catalogDatasets,
    };
    await writeFile(
      path.join(staging, "result-catalog.json"),
      canonicalJson(catalog),
      { flag: "wx" },
    );
    await writeFile(
      path.join(staging, "materialization-report.json"),
      canonicalJson({
        schemaVersion: "tiangong.release.result-materialization-report.v2",
        outcome: "materialized",
        completeness: "complete-for-selection",
        datasetCount: descriptors.length,
        versionChanges: countChanges(descriptors),
        validator: "@tiangong-lca/tidas-sdk@0.1.46",
      }),
      { flag: "wx" },
    );
    await mkdir(path.dirname(target), { recursive: true });
    await rename(staging, target);
    return { path: target, catalog };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      fail("output_exists", `Refusing to overwrite existing output: ${target}`);
    }
    throw error;
  }
}

function resultHashes(result) {
  const data = result.document.processDataSet;
  const semantic = {
    schema: "tiangong.release.result-process-semantic.v2",
    profile: RESULT_PROFILE,
    uuid: result.uuid,
    sourceProcess: result.sourceProcess,
    quantitativeReference: data.processInformation.quantitativeReference,
    typeOfDataSet:
      data.modellingAndValidation.LCIMethodAndAllocation.typeOfDataSet,
    exchanges: data.exchanges.exchange.map((exchange) => ({
      flow: {
        uuid: exchange.referenceToFlowDataSet["@refObjectId"].toLowerCase(),
        version: exchange.referenceToFlowDataSet["@version"],
      },
      direction: exchange.exchangeDirection,
      location: exchange.location ?? null,
      meanAmount: exchange.meanAmount,
    })),
    lciaResults: (data.LCIAResults?.LCIAResult ?? []).map((item) => ({
      method: {
        uuid: item.referenceToLCIAMethodDataSet["@refObjectId"].toLowerCase(),
        version: item.referenceToLCIAMethodDataSet["@version"],
      },
      meanAmount: item.meanAmount,
    })),
  };
  return {
    versionSignificantHash: versionSignificantHash(result.document),
    semanticHash: hashJson(semantic),
    canonicalContentHash: hashJson(result.document),
  };
}

function countChanges(descriptors) {
  return descriptors.reduce((result, item) => {
    result[item.versionChange] = (result[item.versionChange] ?? 0) + 1;
    return result;
  }, {});
}

function compareIdentity(left, right) {
  return (
    left.id.localeCompare(right.id) || left.version.localeCompare(right.version)
  );
}
