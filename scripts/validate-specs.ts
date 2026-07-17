import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import Ajv2020 from "ajv/dist/2020.js";

type AjvInstance = {
  addFormat(
    name: string,
    format: RegExp | ((value: string) => boolean),
  ): AjvInstance;
  compile(schema: object): unknown;
};

const AjvConstructor = Ajv2020 as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => AjvInstance;

const root = process.cwd();
const readJson = (relativePath: string) =>
  JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as Record<
    string,
    any
  >;

const ajv = new AjvConstructor({ allErrors: true, strict: true });
ajv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
ajv.addFormat("date-time", (value: string) =>
  Number.isFinite(Date.parse(value)),
);

for (const schemaPath of [
  "specs/calculation-bundle.schema.json",
  "specs/source-closure.schema.json",
  "specs/release-request.schema.json",
  "specs/release-manifest.schema.json",
  "specs/approval-decision.schema.json",
]) {
  const schema = readJson(schemaPath);
  ajv.compile(schema);
}

const identity = readJson("specs/identity-contract.json");
assert.equal(
  identity.namespaces.lifecycleModel,
  "1f09df9a-9a14-5247-a355-90ce73b521dd",
);
assert.equal(
  identity.namespaces.resultProcess,
  "6d130f3d-ca65-5a6f-a842-4b2f9c2f5461",
);

const profiles = readJson("specs/release-profiles.json");
assert.equal(profiles.result.methodSet.methodCount, 25);
assert.equal(profiles.packages.length, 2);
assert.equal(profiles.packages[1].mustContainUnitProfileClosure, true);

const stageContracts = readJson("specs/stage-contracts.json");
assert.equal(stageContracts.stages.length, 20);
assert.deepEqual(
  stageContracts.stages.map((stage: { order: number }) => stage.order),
  Array.from({ length: 20 }, (_, index) => index + 1),
);
assert.equal(
  new Set(stageContracts.stages.map((stage: { id: string }) => stage.id)).size,
  20,
);
assert.deepEqual(stageContracts.runStatuses.slice(-3), [
  "approved",
  "published",
  "verified",
]);

process.stdout.write("Release specs: valid\n");
