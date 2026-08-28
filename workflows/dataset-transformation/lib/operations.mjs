export const PENDING_OPERATION = "weighted-aggregate.choose-target.v0";
export const LEGACY_UNIT_OPERATION = "process.weighted-aggregate.v0";
export const UNIT_OPERATION = "unit-process.weighted-aggregate.v1";
export const RESULT_OPERATION = "result-process.weighted-aggregate.v0";

export const TARGET_OPERATIONS = Object.freeze([
  UNIT_OPERATION,
  RESULT_OPERATION,
]);

export const SUPPORTED_OPERATIONS = new Set([
  PENDING_OPERATION,
  LEGACY_UNIT_OPERATION,
  ...TARGET_OPERATIONS,
]);

export function operationRole(type) {
  if (type === LEGACY_UNIT_OPERATION || type === UNIT_OPERATION)
    return "unit_process";
  if (type === RESULT_OPERATION) return "result_process";
  if (type === PENDING_OPERATION) return null;
  return undefined;
}

export function requiresTargetDecision(type) {
  return type === UNIT_OPERATION || type === RESULT_OPERATION;
}
