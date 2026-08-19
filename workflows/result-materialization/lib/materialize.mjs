import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail } from "./common.mjs";
import { materializeModels } from "./materialize-models.mjs";
import { materializeResults } from "./materialize-results.mjs";
import { hashJson } from "./versioning.mjs";

export const OUTPUT_TYPES = new Set(["result-process", "lifecycle-model"]);
export const RESULT_LAYERS = new Set(["lci", "lci-lcia"]);

export async function materialize({
  intakeDir,
  outDir,
  processUuids,
  outputType,
  resultLayer,
  firstGeneration = false,
  previousManifestPath,
}) {
  if (!OUTPUT_TYPES.has(outputType))
    fail("unsupported_output_type", `Unsupported output type: ${outputType}`);
  if (!RESULT_LAYERS.has(resultLayer))
    fail(
      "unsupported_result_layer",
      `Unsupported result layer: ${resultLayer}`,
    );

  const target = path.resolve(outDir);
  await mkdir(path.dirname(target), { recursive: true });
  const workspace = await mkdtemp(`${target}.work-`);
  try {
    const results = await materializeResults({
      intakeDir,
      outDir: path.join(workspace, "results"),
      processUuids,
      includeDirectProviders: outputType === "lifecycle-model",
      resultLayer,
      firstGeneration,
      previousManifestPath,
    });
    const request = {
      schemaVersion: "tiangong.release.materialization-request.v1",
      scope: {
        mode: processUuids?.length ? "selected" : "all_eligible",
        requestedSelectors: processUuids ?? [],
        processes: results.catalog.selection,
      },
      outputType,
      resultLayer,
      modelProfile:
        outputType === "lifecycle-model"
          ? "resolved-one-hop-aggregated-background.v1"
          : null,
    };
    let completed;
    if (outputType === "lifecycle-model") {
      completed = await materializeModels({
        intakeDir,
        resultCatalogPath: path.join(results.path, "result-catalog.json"),
        outDir: path.join(workspace, "complete"),
        processUuids,
        firstGeneration,
        previousManifestPath,
      });
      await writeFile(
        path.join(completed.path, "result-catalog.json"),
        canonicalJson(results.catalog),
        { flag: "wx" },
      );
    } else {
      completed = await finalizeResultOnly({
        results,
        intakeDir,
        previousManifestPath,
        firstGeneration,
      });
    }
    completed.manifest.inputs.materializationRequestSha256 = hashJson(request);
    await writeFile(
      path.join(completed.path, "materialization-manifest.json"),
      canonicalJson(completed.manifest),
    );
    await writeFile(
      path.join(completed.path, "materialization-request.json"),
      canonicalJson(request),
      { flag: "wx" },
    );
    await rename(completed.path, target);
    const datasets = completed.manifest.datasets;
    return {
      path: target,
      request,
      manifest: completed.manifest,
      summary: {
        requestedRootCount: results.catalog.selection.length,
        primaryDatasetCount: datasets.filter((item) =>
          ["primary", "lifecycle_model"].includes(
            item.materializationRole ?? item.role,
          ),
        ).length,
        dependencyDatasetCount: datasets.filter(
          (item) => item.materializationRole === "dependency",
        ).length,
        resultingDatasetCount: datasets.filter(
          (item) => item.materializationRole === "resulting",
        ).length,
      },
    };
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY")
      fail("output_exists", `Refusing to overwrite existing output: ${target}`);
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function finalizeResultOnly({
  results,
  intakeDir,
  previousManifestPath,
  firstGeneration,
}) {
  const intake = JSON.parse(
    await readFile(
      path.join(path.resolve(intakeDir), "intake-manifest.json"),
      "utf8",
    ),
  );
  const manifest = {
    schemaVersion: "tiangong.release.materialization-manifest.v1",
    completeness: "complete-for-selected-roots",
    inputs: {
      calculationId: intake.source.calculationId,
      bundleContentHash: intake.source.bundleContentHash,
      intakeManifestSha256: hashJson(intake),
      resultCatalogSha256: hashJson(results.catalog),
      previousManifestSha256: previousManifestPath
        ? hashJson(
            JSON.parse(
              await readFile(path.resolve(previousManifestPath), "utf8"),
            ),
          )
        : null,
      firstGeneration,
    },
    profiles: {
      result: results.catalog.datasets[0]?.profile ?? null,
      model: null,
    },
    datasets: results.catalog.datasets,
    validation: {
      tidasSdk: "@tiangong-lca/tidas-sdk@0.1.46",
      sourceDocuments: "verified",
      resultReferences: "verified",
      modelSchemas: "not_applicable",
      oneHopReconstruction: "not_applicable",
    },
  };
  await writeFile(
    path.join(results.path, "materialization-manifest.json"),
    canonicalJson(manifest),
    { flag: "wx" },
  );
  return { path: results.path, manifest };
}
