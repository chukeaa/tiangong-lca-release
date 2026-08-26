import {
  amountString,
  canonicalJson,
  deepSet,
  fail,
  hashJson,
  nearlyEqual,
  sha256Bytes,
} from "./common.mjs";
import { FAMILY_PATHS, referenceDescriptor } from "./analysis.mjs";

const NUMERIC_KEYS = new Set([
  "meanAmount",
  "resultingAmount",
  "minimumAmount",
  "maximumAmount",
  "relativeStandardDeviation95In",
]);

export function aggregateProcesses({ inputs, frozenSpec, frozenSpecSha256 }) {
  const prototypeKey = frozenSpec.policies.prototypeInput;
  const prototype = inputs.find(({ key }) => key === prototypeKey);
  if (!prototype)
    fail(
      "frozen_spec_prototype_missing",
      "Frozen DSL prototype is not among the exact inputs",
    );
  const weights = new Map(
    frozenSpec.operation.weighting.values.map(({ input, normalized }) => [
      input,
      normalized,
    ]),
  );
  if (
    weights.size !== inputs.length ||
    !nearlyEqual(
      [...weights.values()].reduce((a, b) => a + b, 0),
      1,
    )
  )
    fail(
      "frozen_spec_weights_invalid",
      "Frozen DSL does not contain one normalized weight per input",
    );

  const output = structuredClone(prototype.document);
  const process = output.processDataSet;
  for (const [family, familyPath] of Object.entries(FAMILY_PATHS))
    deepSet(process, familyPath, frozenSpec.resolvedFields[family]);

  const identity = frozenSpec.output.identity;
  process.processInformation.dataSetInformation["common:UUID"] = identity.uuid;
  const publication =
    (process.administrativeInformation.publicationAndOwnership ??= {});
  publication["common:dataSetVersion"] = identity.version;
  publication["common:dateOfLastRevision"] = frozenSpec.output.generatedAt;
  publication["common:permanentDataSetURI"] = identity.uri;
  const dataEntry = (process.administrativeInformation.dataEntryBy ??= {});
  dataEntry["common:timeStamp"] = frozenSpec.output.generatedAt;
  process.modellingAndValidation.validation = {
    review: { "@type": "Not reviewed" },
  };

  const annualDecision = frozenSpec.resolvedFields.annualVolumeDecision;
  const representativeness =
    (process.modellingAndValidation.dataSourcesTreatmentAndRepresentativeness ??=
      {});
  if (annualDecision.strategy === "drop")
    representativeness.annualSupplyOrProductionVolume = [];
  else if (annualDecision.strategy === "rewrite")
    representativeness.annualSupplyOrProductionVolume = structuredClone(
      annualDecision.value,
    );
  else if (annualDecision.strategy === "sum-resolved") {
    const weighting = frozenSpec.operation.weighting;
    representativeness.annualSupplyOrProductionVolume = [
      {
        "@xml:lang": "en",
        "#text": `${amountString(weighting.rawTotal)} ${weighting.unit}`,
      },
    ];
  }

  const aggregation = aggregateExchanges(
    inputs,
    weights,
    prototypeKey,
    frozenSpec,
  );
  process.exchanges = { exchange: aggregation.exchanges };
  process.processInformation.quantitativeReference = {
    "@type": "Reference flow(s)",
    referenceToReferenceFlow: aggregation.referenceInternalId,
  };
  appendLineageComment(
    process.processInformation.dataSetInformation,
    frozenSpecSha256,
    inputs,
  );

  const bytes = Buffer.from(canonicalJson(output));
  return {
    document: output,
    bytes,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(output),
    aggregation,
  };
}

function aggregateExchanges(inputs, weights, prototypeKey, frozenSpec) {
  const groups = new Map();
  let referenceGroupKey = null;
  for (const input of inputs) {
    const reference = referenceDescriptor(input);
    const inputWeight = weights.get(input.key);
    for (const exchange of input.document.processDataSet.exchanges?.exchange ??
      []) {
      const amount = Number(exchange.resultingAmount ?? exchange.meanAmount);
      if (!Number.isFinite(amount))
        fail(
          "process_exchange_amount_invalid",
          `Process exchange has a non-numeric amount: ${input.key}#${exchange["@dataSetInternalID"]}`,
        );
      const key = exchangeGroupKey(exchange);
      const contribution = {
        input: input.key,
        exchange,
        resultingAmount: (amount / reference.amount) * inputWeight,
        meanAmount: (amount / reference.amount) * inputWeight,
      };
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(contribution);
      if (String(exchange["@dataSetInternalID"]) === reference.internalId)
        referenceGroupKey = key;
    }
  }
  if (!referenceGroupKey)
    fail(
      "process_reference_group_missing",
      "Cannot locate the aggregated reference exchange",
    );
  const exchanges = [];
  const totals = [];
  const sorted = [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [key, contributions] of sorted) {
    const prototypeContribution = contributions.find(
      ({ input }) => input === prototypeKey,
    );
    const chosen = prototypeContribution ?? contributions[0];
    const exchange = structuredClone(chosen.exchange);
    for (const numeric of NUMERIC_KEYS) delete exchange[numeric];
    delete exchange["@dataSetInternalID"];
    delete exchange.allocations;
    delete exchange.uncertaintyDistributionType;
    exchange.referencesToDataSource = unionDataSources(contributions);
    exchange.generalComment = lineageExchangeComment(contributions);
    const meanAmount = contributions.reduce(
      (sum, contribution) => sum + contribution.meanAmount,
      0,
    );
    const resultingAmount = contributions.reduce(
      (sum, contribution) => sum + contribution.resultingAmount,
      0,
    );
    exchange.meanAmount = amountString(meanAmount);
    exchange.resultingAmount = amountString(resultingAmount);
    exchanges.push(exchange);
    totals.push({ key, meanAmount, resultingAmount });
  }
  exchanges.forEach((exchange, index) => {
    exchange["@dataSetInternalID"] = String(index);
  });
  const referenceIndex = sorted.findIndex(([key]) => key === referenceGroupKey);
  if (referenceIndex < 0)
    fail(
      "process_reference_group_missing",
      "Reference group was not materialized",
    );
  return {
    exchanges,
    referenceInternalId: String(referenceIndex),
    referenceGroupKey,
    totals,
    exchangeCount: exchanges.length,
    metadataPolicy: structuredClone(frozenSpec.policies.exchangeMetadata),
  };
}

function exchangeGroupKey(exchange) {
  const reference = exchange.referenceToFlowDataSet;
  if (!reference?.["@refObjectId"] || !reference?.["@version"])
    fail(
      "process_exchange_reference_invalid",
      "Every aggregated exchange must have an exact Flow UUID and version",
    );
  return JSON.stringify({
    direction: exchange.exchangeDirection ?? null,
    flow: reference["@refObjectId"],
    version: reference["@version"],
    location: exchange.location ?? null,
    functionType: exchange.functionType ?? null,
  });
}

function unionDataSources(contributions) {
  const sources = [];
  const seen = new Set();
  for (const { exchange } of contributions)
    for (const source of exchange.referencesToDataSource
      ?.referenceToDataSource ?? []) {
      const hash = hashJson(source);
      if (seen.has(hash)) continue;
      seen.add(hash);
      sources.push(structuredClone(source));
    }
  return sources.length
    ? {
        referenceToDataSource: sources.sort((left, right) =>
          hashJson(left).localeCompare(hashJson(right)),
        ),
      }
    : undefined;
}

function lineageExchangeComment(contributions) {
  const inputs = contributions
    .map(({ input }) => input)
    .sort()
    .join(", ");
  return [
    {
      "@xml:lang": "en",
      "#text": `Deterministically aggregated from normalized weighted Process exchanges. Contributing inputs: ${inputs}. Original exchange comments are retained through the frozen Transformation evidence, not copied as output claims.`,
    },
  ];
}

function appendLineageComment(dataSetInformation, specSha256, inputs) {
  const existing = Array.isArray(dataSetInformation["common:generalComment"])
    ? dataSetInformation["common:generalComment"]
    : [];
  dataSetInformation["common:generalComment"] = [
    ...existing,
    {
      "@xml:lang": "en",
      "#text": `Derived by Dataset Transformation frozen spec ${specSha256} from ${inputs.map(({ key }) => key).join(", ")}.`,
    },
  ];
}
