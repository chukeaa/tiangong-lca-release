import assert from "node:assert/strict";
import test from "node:test";
import {
  QuantitativeReferenceError,
  resolveSingleQuantitativeReference,
} from "../src/identity/quantitative-reference.js";

function processFixture(overrides: Record<string, unknown> = {}) {
  const referenceExchange = {
    "@dataSetInternalID": 7,
    exchangeDirection: "Output",
    meanAmount: "1",
    referenceToFlowDataSet: {
      "@refObjectId": "22222222-2222-4222-8222-222222222222",
      "@version": "01.00.000",
    },
    ...overrides,
  };
  return {
    processDataSet: {
      processInformation: {
        quantitativeReference: {
          "@type": "Reference flow(s)",
          referenceToReferenceFlow: 7,
        },
      },
      exchanges: { exchange: [referenceExchange] },
    },
  };
}

test("resolves one exact Output quantitative reference", () => {
  assert.deepEqual(resolveSingleQuantitativeReference(processFixture()), {
    exchangeInternalId: "7",
    flowUuid: "22222222-2222-4222-8222-222222222222",
    flowVersion: "01.00.000",
    direction: "Output",
    meanAmount: 1,
  });
});

test("fails closed for missing, array, duplicate, Input, zero, and incomplete flow references", () => {
  const missing = processFixture();
  delete (
    missing.processDataSet.processInformation.quantitativeReference as any
  ).referenceToReferenceFlow;
  assert.throws(
    () => resolveSingleQuantitativeReference(missing),
    QuantitativeReferenceError,
  );

  const array = processFixture();
  (
    array.processDataSet.processInformation.quantitativeReference as any
  ).referenceToReferenceFlow = [7];
  assert.throws(
    () => resolveSingleQuantitativeReference(array),
    /exactly one/u,
  );

  const duplicate = processFixture();
  duplicate.processDataSet.exchanges.exchange.push({
    ...duplicate.processDataSet.exchanges.exchange[0]!,
  });
  assert.throws(
    () => resolveSingleQuantitativeReference(duplicate),
    /resolved to 2/u,
  );

  assert.throws(
    () =>
      resolveSingleQuantitativeReference(
        processFixture({ exchangeDirection: "Input" }),
      ),
    /must be Output/u,
  );
  assert.throws(
    () => resolveSingleQuantitativeReference(processFixture({ meanAmount: 0 })),
    /finite non-zero/u,
  );
  assert.throws(
    () =>
      resolveSingleQuantitativeReference(
        processFixture({ referenceToFlowDataSet: {} }),
      ),
    /exact flow UUID and version/u,
  );
});
