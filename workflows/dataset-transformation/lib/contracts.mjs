import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { UUID_PATTERN, fail } from "./common.mjs";

const CONTRACTS = Object.freeze({
  draft: "../contracts/dataset-transformation-dsl.v0.schema.json",
  analysis: "../contracts/transformation-analysis.v0.schema.json",
  conflictReport: "../contracts/transformation-conflict-report.v0.schema.json",
  frozenSpec: "../contracts/transformation-frozen-spec.v0.schema.json",
  executionReceipt:
    "../contracts/transformation-execution-receipt.v0.schema.json",
  handoff: "../contracts/transformation-handoff.v0.schema.json",
});

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("uuid", UUID_PATTERN);
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) && !Number.isNaN(Date.parse(value)),
});

const validators = new Map(
  Object.entries(CONTRACTS).map(([name, relative]) => {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    const schema = JSON.parse(readFileSync(file, "utf8"));
    return [name, ajv.compile(schema)];
  }),
);

export function validateContract(name, value) {
  const validator = validators.get(name);
  if (!validator) fail("contract_unknown", `Unknown contract: ${name}`);
  if (validator(value)) return;
  fail(
    "contract_validation_failed",
    `Artifact does not satisfy the ${name} JSON Schema`,
    {
      contract: name,
      errors: validator.errors?.slice(0, 20) ?? [],
    },
  );
}

export function contractNames() {
  return [...validators.keys()];
}
