import { fail } from "./common.mjs";

const ABSOLUTE_TOLERANCE = 1e-12;
const RELATIVE_TOLERANCE = 1e-9;

export function validateOneHopReconstruction(context, processIndex) {
  const reconstructed = new Map();
  for (const record of context.biosphere.get(processIndex) ?? []) {
    add(reconstructed, record, Number(record.meanAmount));
  }
  const edges = context.technosphereEdges.filter(
    (edge) => edge.dependentProcessIndex === processIndex,
  );
  for (const edge of edges) {
    for (const record of context.lci.get(edge.balancingProcessIndex) ?? []) {
      add(
        reconstructed,
        record,
        Number(edge.activityRequirement) * Number(record.meanAmount),
      );
    }
  }
  const expected = new Map();
  for (const record of context.lci.get(processIndex) ?? [])
    add(expected, record, Number(record.meanAmount));
  const keys = new Set([...reconstructed.keys(), ...expected.keys()]);
  let maxAbsoluteDifference = 0;
  for (const key of keys) {
    const observed = reconstructed.get(key) ?? 0;
    const target = expected.get(key) ?? 0;
    const difference = Math.abs(observed - target);
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, difference);
    if (
      difference >
      ABSOLUTE_TOLERANCE +
        RELATIVE_TOLERANCE * Math.max(Math.abs(observed), Math.abs(target))
    ) {
      fail(
        "one_hop_reconstruction_mismatch",
        `One-hop inventory reconstruction differs for ${key}`,
        {
          processIndex,
          observed,
          expected: target,
          absoluteDifference: difference,
          absoluteTolerance: ABSOLUTE_TOLERANCE,
          relativeTolerance: RELATIVE_TOLERANCE,
        },
      );
    }
  }
  return {
    outcome: "passed",
    processIndex,
    flowCount: keys.size,
    providerEdgeCount: edges.length,
    maxAbsoluteDifference,
    absoluteTolerance: ABSOLUTE_TOLERANCE,
    relativeTolerance: RELATIVE_TOLERANCE,
  };
}

function add(target, record, amount) {
  if (!Number.isFinite(amount))
    fail("non_finite_reconstruction_value", "Non-finite reconstruction value");
  const key = [
    record.flow.id.toLowerCase(),
    record.flow.version,
    String(record.direction).toLowerCase(),
    record.unit,
    record.location ?? "",
  ].join("|");
  target.set(key, (target.get(key) ?? 0) + amount);
}
