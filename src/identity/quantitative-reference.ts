import { normalizeUuid } from "./uuid.js";

export type ResolvedQuantitativeReference = {
  exchangeInternalId: string;
  flowUuid: string;
  flowVersion: string;
  direction: "Output";
  meanAmount: number;
};

export class QuantitativeReferenceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "QuantitativeReferenceError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredInternalId(value: unknown): string {
  if (Array.isArray(value)) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_count_invalid",
      "Release v1 requires exactly one referenceToReferenceFlow value.",
    );
  }
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).trim() === ""
  ) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_missing",
      "referenceToReferenceFlow is required.",
    );
  }
  return String(value).trim();
}

function finiteNonZeroAmount(value: unknown): number {
  const amount =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(amount) || amount === 0) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_amount_invalid",
      "The quantitative-reference exchange must have a finite non-zero meanAmount.",
    );
  }
  return amount;
}

export function resolveSingleQuantitativeReference(
  process: unknown,
): ResolvedQuantitativeReference {
  const root = record(process);
  const dataSet = record(root?.processDataSet);
  const processInformation = record(dataSet?.processInformation);
  const quantitativeReference = record(
    processInformation?.quantitativeReference,
  );
  const exchangeInternalId = requiredInternalId(
    quantitativeReference?.referenceToReferenceFlow,
  );
  const exchanges = record(dataSet?.exchanges)?.exchange;
  if (!Array.isArray(exchanges)) {
    throw new QuantitativeReferenceError(
      "process_exchanges_missing",
      "Process exchanges are required.",
    );
  }

  const matches = exchanges.filter((exchange) => {
    const item = record(exchange);
    return (
      item && String(item["@dataSetInternalID"]).trim() === exchangeInternalId
    );
  });
  if (matches.length !== 1) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_exchange_ambiguous",
      `Reference internal ID ${exchangeInternalId} resolved to ${matches.length} exchanges.`,
    );
  }

  const exchange = record(matches[0])!;
  if (exchange.exchangeDirection !== "Output") {
    throw new QuantitativeReferenceError(
      "quantitative_reference_direction_invalid",
      "The quantitative-reference exchange must be Output.",
    );
  }
  const flow = record(exchange.referenceToFlowDataSet);
  const flowUuidValue = flow?.["@refObjectId"];
  const flowVersionValue = flow?.["@version"];
  if (
    typeof flowUuidValue !== "string" ||
    typeof flowVersionValue !== "string"
  ) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_flow_invalid",
      "The quantitative-reference exchange requires an exact flow UUID and version.",
    );
  }
  if (!/^\d{2}\.\d{2}\.\d{3}$/.test(flowVersionValue)) {
    throw new QuantitativeReferenceError(
      "quantitative_reference_flow_version_invalid",
      "The quantitative-reference flow version must use 00.00.000 format.",
    );
  }

  return {
    exchangeInternalId,
    flowUuid: normalizeUuid(flowUuidValue),
    flowVersion: flowVersionValue,
    direction: "Output",
    meanAmount: finiteNonZeroAmount(exchange.meanAmount),
  };
}
