import path from "node:path";
import {
  UUID_PATTERN,
  VERSION_PATTERN,
  deepGet,
  fail,
  hashJson,
} from "./common.mjs";
import { loadCandidate, loadProcessInputs } from "./candidate.mjs";
import { validateContract } from "./contracts.mjs";
import { readJson, writeCanonical, writeImmutableDirectory } from "./io.mjs";
import {
  LEGACY_UNIT_OPERATION,
  PENDING_OPERATION,
  SUPPORTED_OPERATIONS,
  TARGET_OPERATIONS,
  operationRole,
  requiresTargetDecision,
} from "./operations.mjs";

export const DSL_VERSION = "tiangong.release.dataset-transformation-dsl.v0";

const FAMILY_PATHS = Object.freeze({
  name: ["processInformation", "dataSetInformation", "name"],
  generalComment: [
    "processInformation",
    "dataSetInformation",
    "common:generalComment",
  ],
  classificationInformation: [
    "processInformation",
    "dataSetInformation",
    "classificationInformation",
  ],
  time: ["processInformation", "time"],
  geography: ["processInformation", "geography"],
  technology: ["processInformation", "technology"],
  mathematicalRelations: ["processInformation", "mathematicalRelations"],
  lciMethodAndAllocation: ["modellingAndValidation", "LCIMethodAndAllocation"],
  dataSourcesAndRepresentativeness: [
    "modellingAndValidation",
    "dataSourcesTreatmentAndRepresentativeness",
  ],
  complianceDeclarations: ["modellingAndValidation", "complianceDeclarations"],
  commissionerAndGoal: [
    "administrativeInformation",
    "common:commissionerAndGoal",
  ],
  dataGenerator: ["administrativeInformation", "dataGenerator"],
  dataEntryBy: ["administrativeInformation", "dataEntryBy"],
  publicationAndOwnership: [
    "administrativeInformation",
    "publicationAndOwnership",
  ],
});

const SYSTEM_DERIVED_FAMILIES = new Set([
  "quantitativeReference",
  "exchanges",
  "identity",
  "validation",
]);

export async function analyzeTransformation({ candidateDir, dslFile, outDir }) {
  const { value: draft } = await readJson(
    dslFile,
    "transformation_dsl_missing",
  );
  const candidate = await loadCandidate(candidateDir, {
    requiredRole: operationRole(draft.operation?.type) ?? null,
  });
  const analysis = await buildAnalysis({ candidate, draft });
  const conflictReport = {
    schemaVersion: "tiangong.release.transformation-conflict-report.v0",
    status: analysis.status,
    transformationDraftSha256: analysis.transformationDraftSha256,
    candidate: analysis.candidate,
    conflictCount: analysis.conflicts.length,
    unresolvedCount: analysis.unresolvedConflictIds.length,
    unresolvedConflictIds: analysis.unresolvedConflictIds,
    conflicts: analysis.conflicts,
  };
  validateContract("conflictReport", conflictReport);
  const target = await writeImmutableDirectory(outDir, async (staging) => {
    await writeCanonical(
      path.join(staging, "transformation-analysis.json"),
      analysis,
    );
    await writeCanonical(
      path.join(staging, "conflict-report.json"),
      conflictReport,
    );
  });
  return { path: target, draft, candidate, analysis };
}

export async function buildAnalysis({ candidate, draft }) {
  validateContract("draft", draft);
  assertDraftEnvelope(draft);
  if (draft.operation.type === PENDING_OPERATION)
    return buildTargetSelectionAnalysis({ candidate, draft });
  const role = operationRole(draft.operation.type);
  const inputKeys = draft.operation?.inputs ?? [];
  const inputs = await loadProcessInputs(candidate, inputKeys, { role });
  const conflicts = [];
  analyzeTargetDecision(draft, conflicts);
  const compatibility = analyzeCompatibility(inputs, role, conflicts);
  const weights = resolveWeights(draft.operation?.weighting, inputs, conflicts);
  const familyAnalysis = analyzeFamilies(inputs, draft, conflicts);
  analyzeOutputAndPolicies(draft, inputs, weights, conflicts, candidate);

  const unresolvedConflictIds = conflicts
    .filter(({ resolutionStatus }) => resolutionStatus !== "resolved")
    .map(({ id }) => id)
    .sort();
  const status = unresolvedConflictIds.length ? "needs_decision" : "ready";
  const analysis = {
    schemaVersion: "tiangong.release.transformation-analysis.v0",
    status,
    transformationDraftSha256: hashJson(draft),
    candidate: {
      releaseCandidateSha256: candidate.candidateSha256,
      releaseVersion: candidate.candidate.releaseVersion,
      canonicalDatasetIndexSha256: candidate.indexSha256,
      packageSetHash: candidate.candidate.packageSetHash,
    },
    operation: {
      type: draft.operation.type,
      inputRole: role,
      inputCount: inputs.length,
      inputs: inputs.map(summarizeInput),
      compatibility,
      weighting: weights,
    },
    fieldFamilies: familyAnalysis,
    conflicts,
    unresolvedConflictIds,
    nextAction:
      status === "ready"
        ? "freeze_exact_dsl"
        : "agent_and_user_resolve_conflicts_in_dsl",
  };
  validateContract("analysis", analysis);
  return analysis;
}

function assertDraftEnvelope(draft) {
  if (
    draft?.schemaVersion !== DSL_VERSION ||
    draft?.status !== "draft" ||
    !SUPPORTED_OPERATIONS.has(draft?.operation?.type) ||
    (draft.operation.type !== PENDING_OPERATION &&
      !Array.isArray(draft.operation.inputs))
  )
    fail(
      "transformation_dsl_invalid",
      "Expected a supported draft Dataset Transformation weighted aggregation",
    );
  const decisionIds = (draft.decisions ?? []).map(
    ({ conflictId }) => conflictId,
  );
  if (new Set(decisionIds).size !== decisionIds.length)
    fail(
      "transformation_dsl_decision_duplicate",
      "Draft DSL contains duplicate decisions for one conflict",
    );
}

function buildTargetSelectionAnalysis({ candidate, draft }) {
  const recommendation = draft.operation.targetRecommendation ?? null;
  const conflictItem = conflict({
    id: "operation:aggregation-target",
    category: "operation-selection",
    summary:
      "Choose whether weighted aggregation constructs a Unit Process or combines existing Result Processes",
    sourceValues: [],
    options: [...TARGET_OPERATIONS],
    recommendation,
    resolutionStatus: "unresolved",
  });
  const analysis = {
    schemaVersion: "tiangong.release.transformation-analysis.v0",
    status: "needs_decision",
    transformationDraftSha256: hashJson(draft),
    candidate: candidateSummary(candidate),
    operation: {
      type: PENDING_OPERATION,
      inputRole: null,
      inputCount: 0,
      inputs: [],
      targetSelection: {
        status: "needs_confirmation",
        options: [...TARGET_OPERATIONS],
        recommendation,
      },
    },
    fieldFamilies: [],
    conflicts: [conflictItem],
    unresolvedConflictIds: [conflictItem.id],
    nextAction: "agent_recommends_and_user_selects_aggregation_target",
  };
  validateContract("analysis", analysis);
  return analysis;
}

function analyzeTargetDecision(draft, conflicts) {
  if (draft.operation.type === LEGACY_UNIT_OPERATION) return;
  if (!requiresTargetDecision(draft.operation.type)) return;
  const decision = decisionMap(draft.decisions).get(
    "operation:aggregation-target",
  );
  const resolved = Boolean(
    decision?.strategy === "select-operation" &&
    decision.value === draft.operation.type &&
    typeof decision.reason === "string" &&
    decision.reason.trim(),
  );
  conflicts.push(
    conflict({
      id: "operation:aggregation-target",
      category: "operation-selection",
      summary:
        "Confirm whether weighted aggregation targets Unit Process or Result Process semantics",
      sourceValues: [{ selectedOperation: draft.operation.type }],
      options: [...TARGET_OPERATIONS],
      recommendation: draft.operation.targetRecommendation ?? null,
      resolutionStatus: resolved ? "resolved" : "unresolved",
      decision: resolved ? decision : null,
    }),
  );
}

function analyzeCompatibility(inputs, role, conflicts) {
  const references = inputs.map((input) => referenceDescriptor(input));
  const referenceIdentities = new Set(
    references.map(({ flow, version, direction }) =>
      JSON.stringify({ flow, version, direction }),
    ),
  );
  if (referenceIdentities.size !== 1)
    conflicts.push(
      conflict({
        id: "compatibility:reference-flow",
        category: "compatibility",
        summary:
          "Selected Processes do not share one exact reference flow identity, version, and direction",
        sourceValues: references,
        options: [
          "revise-selection",
          "split-output",
          "defer-until-mapping-rule-exists",
        ],
        resolutionStatus: "revise_dsl_required",
      }),
    );
  const types = inputs.map((input) => ({
    input: input.key,
    value:
      input.document.processDataSet?.modellingAndValidation
        ?.LCIMethodAndAllocation?.typeOfDataSet ?? null,
  }));
  if (new Set(types.map(({ value }) => JSON.stringify(value))).size !== 1)
    conflicts.push(
      conflict({
        id: "compatibility:dataset-type",
        category: "compatibility",
        summary: "Selected Processes have different dataset types",
        sourceValues: types,
        options: ["revise-selection", "split-output"],
        resolutionStatus: "revise_dsl_required",
      }),
    );
  const compatibility = {
    referenceFlowCompatible: referenceIdentities.size === 1,
    datasetTypeCompatible:
      new Set(types.map(({ value }) => JSON.stringify(value))).size === 1,
    reference: references[0] ?? null,
  };
  if (role === "result_process")
    Object.assign(compatibility, analyzeResultCompatibility(inputs, conflicts));
  return compatibility;
}

function analyzeResultCompatibility(inputs, conflicts) {
  const lineages = inputs.map(resultLineageDescriptor);
  const calculationIds = new Set(
    lineages.map(({ calculationId }) => calculationId).filter(Boolean),
  );
  const calculationLineageCompatible =
    calculationIds.size === 1 &&
    lineages.every(({ calculationId }) => calculationId !== null);
  if (!calculationLineageCompatible)
    conflicts.push(
      conflict({
        id: "compatibility:calculation-lineage",
        category: "compatibility",
        summary:
          "Selected Result Processes do not expose one shared exact Calculation lineage",
        sourceValues: lineages,
        options: [
          "revise-selection",
          "provide-materialization-lineage-evidence",
          "switch-to-unit-process-aggregation",
          "split-output",
        ],
        resolutionStatus: "revise_dsl_required",
      }),
    );

  const exchangeSignatures = inputs.map((input) => ({
    input: input.key,
    identities: resultExchangeIdentities(input),
  }));
  const exchangeIdentityCompatible =
    new Set(exchangeSignatures.map(({ identities }) => hashJson(identities)))
      .size === 1;
  if (!exchangeIdentityCompatible)
    conflicts.push(
      conflict({
        id: "compatibility:result-exchanges",
        category: "compatibility",
        summary:
          "Selected Result Processes do not contain one exact LCI exchange identity set",
        sourceValues: exchangeSignatures,
        options: [
          "revise-selection",
          "switch-to-unit-process-aggregation",
          "split-output",
        ],
        resolutionStatus: "revise_dsl_required",
      }),
    );

  const methodSignatures = inputs.map((input) => ({
    input: input.key,
    identities: resultMethodIdentities(input),
  }));
  const lciaMethodCompatible =
    new Set(methodSignatures.map(({ identities }) => hashJson(identities)))
      .size === 1;
  if (!lciaMethodCompatible)
    conflicts.push(
      conflict({
        id: "compatibility:lcia-methods",
        category: "compatibility",
        summary:
          "Selected Result Processes do not contain one exact LCIA method identity/version set",
        sourceValues: methodSignatures,
        options: [
          "revise-selection",
          "materialize-a-common-method-set",
          "switch-to-unit-process-aggregation",
          "split-output",
        ],
        resolutionStatus: "revise_dsl_required",
      }),
    );
  return {
    calculationLineageCompatible,
    calculationId: calculationLineageCompatible
      ? lineages[0].calculationId
      : null,
    exchangeIdentityCompatible,
    exchangeIdentitySha256: exchangeIdentityCompatible
      ? hashJson(exchangeSignatures[0].identities)
      : null,
    lciaMethodCompatible,
    lciaMethodIdentitySha256: lciaMethodCompatible
      ? hashJson(methodSignatures[0].identities)
      : null,
    lciaMethodCount: lciaMethodCompatible
      ? methodSignatures[0].identities.length
      : null,
  };
}

function resultLineageDescriptor(input) {
  const comments = languageTexts(
    input.document.processDataSet?.processInformation?.dataSetInformation?.[
      "common:generalComment"
    ],
  ).join("\n");
  const calculationId =
    comments.match(
      /under calculation\s+([0-9a-f]{8}-[0-9a-f-]{27})\b/iu,
    )?.[1] ?? null;
  const sourceProcess =
    comments.match(
      /generated for\s+([0-9a-f]{8}-[0-9a-f-]{27}@[0-9]{2}\.[0-9]{2}\.[0-9]{3})\b/iu,
    )?.[1] ?? null;
  return { input: input.key, calculationId, sourceProcess };
}

function resultExchangeIdentities(input) {
  return (input.document.processDataSet?.exchanges?.exchange ?? [])
    .map((exchange) => {
      const reference = exchange.referenceToFlowDataSet;
      return {
        direction: exchange.exchangeDirection ?? null,
        flow: reference?.["@refObjectId"] ?? null,
        version: reference?.["@version"] ?? null,
        location: exchange.location ?? null,
        functionType: exchange.functionType ?? null,
      };
    })
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function resultMethodIdentities(input) {
  return resultItems(input)
    .map((item) => ({
      uuid: item.referenceToLCIAMethodDataSet?.["@refObjectId"] ?? null,
      version: item.referenceToLCIAMethodDataSet?.["@version"] ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function resultItems(input) {
  const value = input.document.processDataSet?.LCIAResults?.LCIAResult;
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function languageTexts(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map((item) => item?.["#text"])
    .filter((text) => typeof text === "string");
}

function referenceDescriptor(input) {
  const process = input.document.processDataSet;
  const referenceId = String(
    process.processInformation?.quantitativeReference
      ?.referenceToReferenceFlow ?? "",
  );
  const exchange = (process.exchanges?.exchange ?? []).find(
    (item) => String(item?.["@dataSetInternalID"]) === referenceId,
  );
  const amount = Number(exchange?.resultingAmount ?? exchange?.meanAmount);
  if (
    !exchange?.referenceToFlowDataSet?.["@refObjectId"] ||
    !exchange.referenceToFlowDataSet?.["@version"] ||
    !Number.isFinite(amount) ||
    amount <= 0
  )
    fail(
      "process_quantitative_reference_invalid",
      `Process does not have one positive exact quantitative reference: ${input.key}`,
    );
  return {
    input: input.key,
    internalId: referenceId,
    flow: exchange.referenceToFlowDataSet["@refObjectId"],
    version: exchange.referenceToFlowDataSet["@version"],
    direction: exchange.exchangeDirection,
    amount,
  };
}

function resolveWeights(weighting, inputs, conflicts) {
  const mode = weighting?.mode;
  if (!new Set(["explicit", "annual-production"]).has(mode)) {
    conflicts.push(
      conflict({
        id: "weighting:mode",
        category: "weighting",
        summary: "Choose explicit or annual-production weighting",
        sourceValues: [],
        options: ["explicit", "annual-production"],
        resolutionStatus: "unresolved",
      }),
    );
    return { mode: mode ?? null, status: "needs_decision", values: [] };
  }
  const values = [];
  for (const input of inputs) {
    let resolved;
    if (mode === "explicit") {
      const raw = weighting.values?.[input.key];
      if (Number.isFinite(raw) && raw > 0)
        resolved = { value: raw, unit: null, source: "explicit" };
    } else {
      const override = weighting.overrides?.[input.key];
      if (
        Number.isFinite(override?.value) &&
        override.value > 0 &&
        typeof override.unit === "string" &&
        override.unit.trim() &&
        typeof override.reason === "string" &&
        override.reason.trim()
      )
        resolved = {
          value: override.value,
          unit: normalizeUnit(override.unit),
          source: "user-override",
          reason: override.reason,
          evidence: override.evidence ?? null,
        };
      else resolved = parseAnnualVolume(input);
    }
    if (!resolved) {
      conflicts.push(
        conflict({
          id: `weight:${input.key}`,
          category: "weighting",
          summary:
            mode === "explicit"
              ? `A positive explicit weight is required for ${input.key}`
              : `Annual production is missing or ambiguous for ${input.key}`,
          sourceValues: [annualEvidence(input)],
          options:
            mode === "explicit"
              ? ["provide-explicit-weight", "exclude-input"]
              : [
                  "provide-annual-override-with-evidence",
                  "switch-to-explicit-weighting",
                  "exclude-input",
                  "split-output",
                ],
          resolutionStatus: "unresolved",
        }),
      );
    } else values.push({ input: input.key, ...resolved });
  }
  if (mode === "annual-production") {
    const units = new Set(values.map(({ unit }) => unit));
    if (values.length === inputs.length && units.size > 1)
      conflicts.push(
        conflict({
          id: "weighting:annual-unit",
          category: "weighting",
          summary: "Resolved annual production values use different units",
          sourceValues: values,
          options: [
            "provide-compatible-overrides",
            "switch-to-explicit-weighting",
            "split-output",
          ],
          resolutionStatus: "unresolved",
        }),
      );
  }
  const total = values.reduce((sum, { value }) => sum + value, 0);
  const complete = values.length === inputs.length && total > 0;
  return {
    mode,
    status: complete ? "resolved" : "needs_decision",
    values: values.map((entry) => ({
      ...entry,
      normalized: complete ? entry.value / total : null,
    })),
    rawTotal: complete ? total : null,
    unit: complete && mode === "annual-production" ? values[0].unit : null,
  };
}

function parseAnnualVolume(input) {
  const evidence = annualEvidence(input);
  const values = Array.isArray(evidence.value) ? evidence.value : [];
  const english = values.find((item) => item?.["@xml:lang"] === "en");
  const text = english?.["#text"] ?? values[0]?.["#text"];
  if (
    typeof text !== "string" ||
    /missing|sentinel|fallback|normalized/iu.test(text)
  )
    return null;
  const match = text
    .trim()
    .match(/^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+(.+)$/iu);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = normalizeUnit(match[2]);
  if (!Number.isFinite(value) || value <= 0 || !unit.includes("/year"))
    return null;
  return { value, unit, source: "annual-field", rawText: text };
}

function annualEvidence(input) {
  return {
    input: input.key,
    value:
      input.document.processDataSet?.modellingAndValidation
        ?.dataSourcesTreatmentAndRepresentativeness
        ?.annualSupplyOrProductionVolume ?? null,
  };
}

function normalizeUnit(unit) {
  return unit.trim().toLowerCase().replaceAll("年", "year").replaceAll(" ", "");
}

function analyzeFamilies(inputs, draft, conflicts) {
  const decisions = decisionMap(draft.decisions);
  const result = [];
  for (const [family, familyPath] of Object.entries(FAMILY_PATHS)) {
    const values = inputs.map((input) => ({
      input: input.key,
      value: normalizedFamilyValue(family, input.document, familyPath),
    }));
    const differs =
      new Set(values.map(({ value }) => hashJson(value ?? null))).size > 1;
    const requested = decisions.get(`field:${family}`);
    const resolved = differs
      ? validateFieldDecision(requested, inputs, family)
      : { status: "equal", value: values[0]?.value };
    if (differs)
      conflicts.push(
        conflict({
          id: `field:${family}`,
          category: "business-field",
          summary: `Business field family '${family}' differs across selected Processes`,
          sourceValues: values,
          options: ["take-from", "rewrite", "drop", "split-output"],
          resolutionStatus:
            resolved.status === "resolved" ? "resolved" : "unresolved",
          decision: resolved.status === "resolved" ? requested : null,
        }),
      );
    result.push({
      family,
      differs,
      systemDerived: SYSTEM_DERIVED_FAMILIES.has(family),
      resolutionStatus: resolved.status,
      resolvedValueHash:
        resolved.status === "resolved" || resolved.status === "equal"
          ? hashJson(resolved.value ?? null)
          : null,
    });
  }
  return result;
}

function normalizedFamilyValue(family, document, familyPath) {
  const value = structuredClone(deepGet(document.processDataSet, familyPath));
  if (family === "dataSourcesAndRepresentativeness" && value)
    delete value.annualSupplyOrProductionVolume;
  if (family === "dataEntryBy" && value) delete value["common:timeStamp"];
  if (family === "publicationAndOwnership" && value) {
    delete value["common:dataSetVersion"];
    delete value["common:dateOfLastRevision"];
    delete value["common:permanentDataSetURI"];
  }
  return value;
}

function analyzeOutputAndPolicies(
  draft,
  inputs,
  weights,
  conflicts,
  candidate,
) {
  const prototype = draft.policies?.prototypeInput;
  if (!inputs.some(({ key }) => key === prototype))
    conflicts.push(
      conflict({
        id: "policy:prototype-input",
        category: "policy",
        summary: "Choose one selected Process as the structural prototype",
        sourceValues: inputs.map(({ key }) => key),
        options: ["set-prototype-input"],
        resolutionStatus: "unresolved",
      }),
    );
  const exchange = draft.policies?.exchangeMetadata;
  const exchangeReady =
    exchange?.base === "take-from-prototype-then-input-order" &&
    exchange?.dataSources === "union-deduplicate" &&
    exchange?.comments === "replace-with-lineage" &&
    exchange?.uncertainty === "reset" &&
    exchange?.allocations === "reset";
  if (!exchangeReady)
    conflicts.push(
      conflict({
        id: "policy:exchange-metadata",
        category: "policy",
        summary:
          "Choose explicit metadata, source, comment, uncertainty, and allocation handling for aggregated exchanges",
        sourceValues: [exchange ?? null],
        options: ["set-supported-exchange-metadata-policy"],
        resolutionStatus: "unresolved",
      }),
    );
  const identity = draft.output?.identity;
  const identityReady =
    UUID_PATTERN.test(identity?.uuid ?? "") &&
    VERSION_PATTERN.test(identity?.version ?? "") &&
    typeof identity?.uri === "string" &&
    identity.uri.includes(identity.uuid) &&
    identity.uri.includes(identity.version) &&
    !candidate.byKey.has(`process:${identity.uuid}@${identity.version}`);
  if (!identityReady)
    conflicts.push(
      conflict({
        id: "output:identity",
        category: "output",
        summary:
          "Provide a new exact UUID, version, and matching permanent URI",
        sourceValues: [identity ?? null],
        options: ["provide-new-output-identity"],
        resolutionStatus: "unresolved",
      }),
    );
  if (
    typeof draft.output?.generatedAt !== "string" ||
    Number.isNaN(Date.parse(draft.output.generatedAt))
  )
    conflicts.push(
      conflict({
        id: "output:generated-at",
        category: "output",
        summary: "Provide the deterministic output generation timestamp",
        sourceValues: [draft.output?.generatedAt ?? null],
        options: ["provide-iso-8601-timestamp"],
        resolutionStatus: "unresolved",
      }),
    );
  const annualDecision = decisionMap(draft.decisions).get("field:annualVolume");
  const annualReady = validateAnnualDecision(annualDecision, weights);
  conflicts.push(
    conflict({
      id: "field:annualVolume",
      category: "business-field",
      summary: "Choose the annual production meaning of the aggregated Process",
      sourceValues: inputs.map(annualEvidence),
      options: ["sum-resolved", "rewrite", "drop"],
      resolutionStatus: annualReady ? "resolved" : "unresolved",
      decision: annualReady ? annualDecision : null,
    }),
  );
}

function validateFieldDecision(decision, inputs, family) {
  if (
    !decision ||
    typeof decision.reason !== "string" ||
    !decision.reason.trim()
  )
    return { status: "unresolved", value: null };
  if (decision.strategy === "take-from") {
    const source = inputs.find(({ key }) => key === decision.input);
    if (!source) return { status: "unresolved", value: null };
    return {
      status: "resolved",
      value: normalizedFamilyValue(
        family,
        source.document,
        FAMILY_PATHS[family],
      ),
    };
  }
  if (decision.strategy === "rewrite" && "value" in decision)
    return { status: "resolved", value: decision.value };
  if (decision.strategy === "drop")
    return { status: "resolved", value: undefined };
  return { status: "unresolved", value: null };
}

function validateAnnualDecision(decision, weights) {
  if (
    !decision ||
    typeof decision.reason !== "string" ||
    !decision.reason.trim()
  )
    return false;
  if (decision.strategy === "drop") return true;
  if (decision.strategy === "rewrite") return Array.isArray(decision.value);
  return (
    decision.strategy === "sum-resolved" &&
    weights.status === "resolved" &&
    weights.mode === "annual-production" &&
    typeof weights.unit === "string"
  );
}

export function resolveFamilyValues(inputs, draft) {
  const decisions = decisionMap(draft.decisions);
  const resolved = {};
  for (const [family, familyPath] of Object.entries(FAMILY_PATHS)) {
    const values = inputs.map((input) =>
      normalizedFamilyValue(family, input.document, familyPath),
    );
    const differs =
      new Set(values.map((value) => hashJson(value ?? null))).size > 1;
    if (!differs) resolved[family] = values[0];
    else {
      const decision = validateFieldDecision(
        decisions.get(`field:${family}`),
        inputs,
        family,
      );
      if (decision.status !== "resolved")
        fail(
          "frozen_dsl_resolution_incomplete",
          `Field family is unresolved: ${family}`,
        );
      resolved[family] = decision.value;
    }
  }
  const annual = decisions.get("field:annualVolume");
  resolved.annualVolumeDecision = structuredClone(annual);
  return resolved;
}

function decisionMap(decisions) {
  const map = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (
      typeof decision?.conflictId !== "string" ||
      map.has(decision.conflictId)
    )
      continue;
    map.set(decision.conflictId, decision);
  }
  return map;
}

function summarizeInput(input) {
  const info = input.document.processDataSet.processInformation;
  return {
    key: input.key,
    uuid: input.entry.uuid,
    version: input.entry.version,
    path: input.entry.path,
    sha256: input.entry.sha256,
    canonicalContentHash: input.entry.canonicalContentHash,
    name: multilingualText(info.dataSetInformation?.name?.baseName),
    geography:
      info.geography?.locationOfOperationSupplyOrProduction?.["@location"] ??
      null,
    annualProduction: annualEvidence(input).value,
    reference: referenceDescriptor(input),
    resultLineage:
      input.entry.role === "result_process"
        ? resultLineageDescriptor(input)
        : null,
  };
}

function candidateSummary(candidate) {
  return {
    releaseCandidateSha256: candidate.candidateSha256,
    releaseVersion: candidate.candidate.releaseVersion,
    canonicalDatasetIndexSha256: candidate.indexSha256,
    packageSetHash: candidate.candidate.packageSetHash,
  };
}

function multilingualText(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    language: item?.["@xml:lang"] ?? null,
    text: item?.["#text"] ?? null,
  }));
}

function conflict(value) {
  return {
    decisionRequired: true,
    ...value,
  };
}

export { FAMILY_PATHS, referenceDescriptor };
