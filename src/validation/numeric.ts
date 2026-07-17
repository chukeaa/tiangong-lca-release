import type {
  BundleInventoryRecord,
  BundleLciaRecord,
  BundleProcessRecord,
} from "../bundle/types.js";
import type { JsonValue } from "../contracts/json.js";
import type { DatasetDescriptorRecord } from "../versioning/descriptors.js";

type Mismatch = {
  processIndex: number;
  path: string;
  expected: string;
  actual: string;
};

function lciKey(input: {
  flowId: string;
  flowVersion: string;
  direction: string;
  location?: string | null;
}): string {
  return `${input.flowId}:${input.flowVersion}:${input.direction}:${input.location ?? ""}`;
}

function lciaKey(input: { methodId: string; methodVersion: string }): string {
  return `${input.methodId}:${input.methodVersion}`;
}

export function numericParityReport(input: {
  processes: BundleProcessRecord[];
  lci: BundleInventoryRecord[];
  lcia: BundleLciaRecord[];
  generated: DatasetDescriptorRecord[];
}): JsonValue & { status: "passed" | "failed" } {
  const mismatches: Mismatch[] = [];
  let lciValueCount = 0;
  let lciaValueCount = 0;
  for (const process of input.processes) {
    const generated = input.generated.find(
      (dataset) =>
        dataset.role === "result_process" &&
        dataset.processIndex === process.processIndex,
    );
    if (!generated) {
      mismatches.push({
        processIndex: process.processIndex,
        path: "resultProcess",
        expected: "present",
        actual: "missing",
      });
      continue;
    }
    const dataSet = (generated.document as Record<string, any>).processDataSet;
    const actualLci = new Map<string, string>();
    for (const exchange of dataSet.exchanges.exchange.slice(1)) {
      const flow = exchange.referenceToFlowDataSet;
      actualLci.set(
        lciKey({
          flowId: String(flow["@refObjectId"]),
          flowVersion: String(flow["@version"]),
          direction: String(exchange.exchangeDirection),
          location: exchange.location ?? null,
        }),
        String(exchange.meanAmount),
      );
    }
    const expectedLci = input.lci.filter(
      (record) =>
        record.processIndex === process.processIndex &&
        !(
          record.flow.id === process.quantitativeReference.flow.id &&
          record.flow.version === process.quantitativeReference.flow.version &&
          record.direction === "Output"
        ),
    );
    lciValueCount += expectedLci.length;
    for (const expected of expectedLci) {
      const key = lciKey({
        flowId: expected.flow.id,
        flowVersion: expected.flow.version,
        direction: expected.direction,
        location: expected.location ?? null,
      });
      const actual = actualLci.get(key);
      if (actual !== String(expected.meanAmount)) {
        mismatches.push({
          processIndex: process.processIndex,
          path: `lci/${key}`,
          expected: String(expected.meanAmount),
          actual: actual ?? "missing",
        });
      }
    }
    if (actualLci.size !== expectedLci.length) {
      mismatches.push({
        processIndex: process.processIndex,
        path: "lci/count",
        expected: String(expectedLci.length),
        actual: String(actualLci.size),
      });
    }

    const actualLcia = new Map<string, string>();
    for (const result of dataSet.LCIAResults.LCIAResult) {
      const method = result.referenceToLCIAMethodDataSet;
      actualLcia.set(
        lciaKey({
          methodId: String(method["@refObjectId"]),
          methodVersion: String(method["@version"]),
        }),
        String(result.meanAmount),
      );
    }
    const expectedLcia = input.lcia.filter(
      (record) => record.processIndex === process.processIndex,
    );
    lciaValueCount += expectedLcia.length;
    for (const expected of expectedLcia) {
      const key = lciaKey({
        methodId: expected.method.id,
        methodVersion: expected.method.version,
      });
      const actual = actualLcia.get(key);
      if (actual !== String(expected.meanAmount)) {
        mismatches.push({
          processIndex: process.processIndex,
          path: `lcia/${key}`,
          expected: String(expected.meanAmount),
          actual: actual ?? "missing",
        });
      }
    }
    if (actualLcia.size !== expectedLcia.length) {
      mismatches.push({
        processIndex: process.processIndex,
        path: "lcia/count",
        expected: String(expectedLcia.length),
        actual: String(actualLcia.size),
      });
    }
  }
  return {
    schemaVersion: "tiangong.release.numeric-parity-report.v1",
    status: mismatches.length ? "failed" : "passed",
    policy: {
      bundleToDataset: "exact-shortest-roundtrip-number",
      baselineAbsoluteTolerance: 1e-9,
      baselineRelativeTolerance: 0.000001,
      nonFinite: "reject",
    },
    processCount: input.processes.length,
    lciValueCount,
    lciaValueCount,
    mismatchCount: mismatches.length,
    mismatches: mismatches as unknown as JsonValue,
  };
}
