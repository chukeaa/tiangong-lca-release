import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  REPLY_TEMPLATE_COMMANDS,
  replyTemplateFor,
} from "../reply-template-registry.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("every successful Calculation command maps to an existing bounded template", async () => {
  assert.deepEqual(REPLY_TEMPLATE_COMMANDS, [
    "result-set.list",
    "result-set.get",
    "result-set.create",
    "closure.start",
    "calculation.start",
    "worker.logs",
  ]);
  for (const command of REPLY_TEMPLATE_COMMANDS) {
    const template = replyTemplateFor(command, { ok: true });
    assert.match(template.id, /^[a-z][a-z0-9-]+$/);
    assert.ok(template.requiredFacts.length > 0);
    assert.equal(template.format, "markdown");
    assert.equal(template.placeholderSyntax, "{{...}}");
    const body = await readFile(
      path.join(repositoryRoot, template.path),
      "utf8",
    );
    assert.match(body, /```markdown/);
    assert.match(body, /{{[^}]+}}/);
    assert.match(body, /[✅🚀🔎⚠️❌]/u);
  }
});

test("uncertain remote outcomes use a distinct no-blind-retry reply template", async () => {
  const template = replyTemplateFor("result-set.create", {
    ok: false,
    errorCode: "remote_outcome_unknown",
  });
  assert.equal(template.id, "remote-outcome-unknown");
  const body = await readFile(path.join(repositoryRoot, template.path), "utf8");
  assert.match(body, /不会自动重试/);
});
