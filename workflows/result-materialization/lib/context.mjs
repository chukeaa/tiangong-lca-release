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
  for (const axis of axes) {
    axis.referencePivot = resolveReferencePivot(axis, sources);
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

export function resolveReferencePivot(axis, sources) {
  const source = sources.get(
    sourceKey("process", axis.rootProcess.id, axis.rootProcess.version),
  );
  if (!source || source.role !== "unit_process") {
    fail(
      "unit_process_missing",
      `Exact source Unit Process is missing: ${axis.rootProcess.id}@${axis.rootProcess.version}`,
    );
  }
  const data = source.document?.processDataSet;
  const internalId = String(
    data?.processInformation?.quantitativeReference?.referenceToReferenceFlow,
  );
  const exchanges = (data?.exchanges?.exchange ?? []).filter(
    (exchange) => String(exchange["@dataSetInternalID"]) === internalId,
  );
  if (
    exchanges.length !== 1 ||
    internalId !== String(axis.quantitativeReference.exchangeInternalId)
  ) {
    fail(
      "invalid_quantitative_reference",
      "Calculation axis does not identify the exact source quantitative-reference exchange",
    );
  }
  const exchange = exchanges[0];
  const flow = exchange.referenceToFlowDataSet;
  const sourceDirection = normalizeDirection(exchange.exchangeDirection);
  const sourceAmount = finiteNonzero(
    exchange.meanAmount,
    "source quantitative-reference meanAmount",
  );
  if (
    flow?.["@refObjectId"]?.toLowerCase() !==
      axis.quantitativeReference.flow.id.toLowerCase() ||
    flow?.["@version"] !== axis.quantitativeReference.flow.version
  ) {
    fail(
      "invalid_quantitative_reference",
      "Source quantitative-reference Flow does not match the Calculation Bundle axis",
    );
  }
  const supplied = axis.quantitativeReference.pivot;
  const rawDirection = supplied
    ? normalizeDirection(supplied.rawDirection)
    : sourceDirection;
  const rawMeanAmount = supplied
    ? finiteNonzero(
        supplied.rawMeanAmount,
        "quantitativeReference.pivot.rawMeanAmount",
      )
    : sourceAmount;
  const signedRawCoefficient = supplied
    ? finiteNonzero(
        supplied.signedRawCoefficient,
        "quantitativeReference.pivot.signedRawCoefficient",
      )
    : directionSign(rawDirection) * rawMeanAmount;
  const normalizationScale = supplied
    ? finiteNonzero(
        supplied.normalizationScale,
        "quantitativeReference.pivot.normalizationScale",
      )
    : 1 / Math.abs(signedRawCoefficient);
  const normalizedCoefficient = supplied
    ? finiteNonzero(
        supplied.normalizedCoefficient,
        "quantitativeReference.pivot.normalizedCoefficient",
      )
    : Math.sign(signedRawCoefficient);
  const normalizedMeanAmount = rawMeanAmount * normalizationScale;
  for (const [actual, expected, field] of [
    [rawDirection, sourceDirection, "rawDirection"],
    [rawMeanAmount, sourceAmount, "rawMeanAmount"],
  ]) {
    if (
      typeof actual === "string"
        ? actual !== expected
        : !nearlyEqual(actual, expected)
    ) {
      fail(
        "quantitative_reference_pivot_mismatch",
        `Calculation Bundle pivot ${field} does not match the exact source closure`,
      );
    }
  }
  for (const [actual, expected, field] of [
    [
      signedRawCoefficient,
      directionSign(rawDirection) * rawMeanAmount,
      "signedRawCoefficient",
    ],
    [
      normalizationScale,
      1 / Math.abs(signedRawCoefficient),
      "normalizationScale",
    ],
    [
      normalizedCoefficient,
      Math.sign(signedRawCoefficient),
      "normalizedCoefficient",
    ],
    [
      finiteNonzero(
        axis.quantitativeReference.meanAmount,
        "quantitativeReference.meanAmount",
      ),
      normalizedMeanAmount,
      "meanAmount",
    ],
  ]) {
    if (!nearlyEqual(actual, expected)) {
      fail(
        "quantitative_reference_pivot_mismatch",
        `Calculation Bundle pivot ${field} is internally inconsistent`,
      );
    }
  }
  return {
    rawDirection,
    rawMeanAmount,
    signedRawCoefficient,
    normalizationScale,
    normalizedCoefficient,
    normalizedMeanAmount,
    evidenceSource: supplied
      ? "calculation_bundle_process_axis.v2"
      : "exact_source_closure_legacy_fallback.v1",
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

function normalizeDirection(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === "input") return "Input";
  if (normalized === "output") return "Output";
  fail("invalid_quantitative_reference", `Unsupported direction: ${value}`);
}

function directionSign(direction) {
  return direction === "Input" ? -1 : 1;
}

function finiteNonzero(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0)
    fail(
      "invalid_quantitative_reference",
      `${field} must be finite and non-zero`,
    );
  return number;
}

function nearlyEqual(left, right) {
  const tolerance = 1e-12 * Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= tolerance;
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
