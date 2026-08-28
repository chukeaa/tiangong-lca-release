import {
  amountString,
  canonicalJson,
  fail,
  hashJson,
  sha256Bytes,
} from "./common.mjs";
import { referenceDescriptor } from "./analysis.mjs";
import { aggregateProcesses } from "./process-aggregation.mjs";

const NUMERIC_KEYS = new Set([
  "meanAmount",
  "resultingAmount",
  "minimumAmount",
  "maximumAmount",
  "relativeStandardDeviation95In",
]);

export function aggregateResultProcesses(args) {
  const result = aggregateProcesses(args);
  const { inputs, frozenSpec } = args;
  const prototypeKey = frozenSpec.policies.prototypeInput;
  const weights = new Map(
    frozenSpec.operation.weighting.values.map(({ input, normalized }) => [
      input,
      normalized,
    ]),
  );
  const aggregation = aggregateLciaResults(inputs, weights, prototypeKey);
  if (aggregation.results.length)
    result.document.processDataSet.LCIAResults = {
      LCIAResult: aggregation.results,
    };
  else delete result.document.processDataSet.LCIAResults;
  const bytes = Buffer.from(canonicalJson(result.document));
  return {
    ...result,
    bytes,
    sha256: sha256Bytes(bytes),
    canonicalContentHash: hashJson(result.document),
    aggregation: {
      ...result.aggregation,
      lcia: {
        methodCount: aggregation.results.length,
        methodIdentitySha256: hashJson(aggregation.methodIdentities),
        totals: aggregation.totals,
      },
    },
  };
}

function aggregateLciaResults(inputs, weights, prototypeKey) {
  const signatures = inputs.map((input) => ({
    input: input.key,
    identities: methodEntries(input).map(({ key }) => key),
  }));
  if (
    new Set(signatures.map(({ identities }) => hashJson(identities))).size !== 1
  )
    fail(
      "result_lcia_method_set_incompatible",
      "Frozen Result inputs no longer expose one exact LCIA method set",
    );
  const groups = new Map();
  for (const input of inputs) {
    const referenceAmount = referenceDescriptor(input).amount;
    const weight = weights.get(input.key);
    for (const { key, item } of methodEntries(input)) {
      const amount = Number(item.meanAmount ?? item.resultingAmount);
      if (!Number.isFinite(amount))
        fail(
          "result_lcia_amount_invalid",
          `Result Process has a non-finite LCIA amount: ${input.key}#${key}`,
        );
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        input: input.key,
        item,
        contribution: (amount / referenceAmount) * weight,
      });
    }
  }
  const results = [];
  const totals = [];
  for (const [key, contributions] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (contributions.length !== inputs.length)
      fail(
        "result_lcia_method_set_incompatible",
        `LCIA method is not present in every Result input: ${key}`,
      );
    const chosen =
      contributions.find(({ input }) => input === prototypeKey) ??
      contributions[0];
    const output = structuredClone(chosen.item);
    for (const numeric of NUMERIC_KEYS) delete output[numeric];
    const amount = contributions.reduce(
      (sum, contribution) => sum + contribution.contribution,
      0,
    );
    output.meanAmount = amountString(amount);
    results.push(output);
    totals.push({ key, meanAmount: amount });
  }
  return {
    results,
    totals,
    methodIdentities: [...groups.keys()].sort(),
  };
}

function methodEntries(input) {
  const raw = input.document.processDataSet?.LCIAResults?.LCIAResult;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return values
    .map((item) => {
      const reference = item.referenceToLCIAMethodDataSet;
      const uuid = reference?.["@refObjectId"];
      const version = reference?.["@version"];
      if (!uuid || !version)
        fail(
          "result_lcia_method_reference_invalid",
          `Result Process LCIA result lacks an exact method identity: ${input.key}`,
        );
      return { key: `${uuid}@${version}`, item };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}
