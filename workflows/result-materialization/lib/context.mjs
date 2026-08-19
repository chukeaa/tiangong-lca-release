import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, fail, sha256Bytes } from "./common.mjs";
import canonicalize from "canonicalize";
import { readNdjson } from "./records.mjs";

export async function loadMaterializationContext(intakeDir) {
  const root = path.resolve(intakeDir);
  const intake = JSON.parse(
    await readFile(path.join(root, "intake-manifest.json"), "utf8"),
  );
  if (intake.schemaVersion !== "tiangong.release.materialization-intake.v1") {
    fail("unsupported_intake", "Expected materialization-intake.v1");
  }
  const artifacts = groupArtifacts(
    intake.artifacts,
    path.join(root, "calculation-bundle"),
  );
  const axes = [];
  for await (const record of recordsFor(artifacts.process_axis))
    axes.push(record);
  axes.sort((left, right) => left.processIndex - right.processIndex);
  const sources = new Map();
  for await (const record of recordsFor(artifacts.source_closure)) {
    if (
      sha256Bytes(Buffer.from(canonicalize(record.document))) !== record.sha256
    ) {
      fail(
        "source_document_hash_mismatch",
        `Source closure document hash mismatch: ${record.path}`,
      );
    }
    sources.set(
      sourceKey(record.datasetType, record.uuid, record.version),
      record,
    );
  }
  return {
    root,
    intake,
    axes,
    sources,
    lci: await recordsByProcess(artifacts.lci),
    lcia: await recordsByProcess(artifacts.lcia),
    biosphere: await recordsByProcess(artifacts.biosphere_edges),
    technosphereEdges: await allRecords(artifacts.technosphere_edges),
  };
}

export function selectAxes(context, processUuids) {
  if (!processUuids?.length) return context.axes;
  const selected = [];
  for (const selector of processUuids) {
    const [uuid, version] = String(selector).toLowerCase().split("@");
    const matches = context.axes.filter(
      (axis) =>
        axis.rootProcess.id.toLowerCase() === uuid &&
        (!version || axis.rootProcess.version.toLowerCase() === version),
    );
    if (!matches.length) {
      fail(
        "process_not_in_bundle",
        `Process is not in Calculation Bundle: ${selector}`,
      );
    }
    if (matches.length > 1) {
      fail(
        "ambiguous_process_selection",
        `Process selector matches multiple calculation axes; use UUID@version: ${selector}`,
        {
          candidates: matches.map((axis) => ({
            ...axis.rootProcess,
            processIndex: axis.processIndex,
          })),
        },
      );
    }
    if (!selected.some((axis) => axis.processIndex === matches[0].processIndex))
      selected.push(matches[0]);
  }
  return selected.sort((left, right) => left.processIndex - right.processIndex);
}

export function sourceKey(datasetType, uuid, version) {
  return `${datasetType}:${uuid.toLowerCase()}:${version}`;
}

function groupArtifacts(entries, root) {
  const result = {};
  for (const entry of entries)
    (result[entry.kind] ??= []).push(path.join(root, entry.path));
  return result;
}

async function* recordsFor(paths = []) {
  for (const artifact of [...paths].sort()) yield* readNdjson(artifact);
}

async function allRecords(paths = []) {
  const result = [];
  for await (const record of recordsFor(paths)) result.push(record);
  return result;
}

async function recordsByProcess(paths = []) {
  const result = new Map();
  for await (const record of recordsFor(paths)) {
    const records = result.get(record.processIndex) ?? [];
    records.push(record);
    result.set(record.processIndex, records);
  }
  return result;
}
