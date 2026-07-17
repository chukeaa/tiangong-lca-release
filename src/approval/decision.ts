import { appendFileSync, existsSync } from "node:fs";
import { canonicalSha256, canonicalize } from "../canonical/jcs.js";
import type { JsonValue } from "../contracts/json.js";
import { readJsonFile, sha256File, writeJsonAtomic } from "../io/files.js";
import { normalizeUuid } from "../identity/uuid.js";
import { releaseWorkspaceLayout } from "../workspace/layout.js";

export type ApprovalDecision = {
  schemaVersion: "tiangong.release.approval-decision.v1";
  releaseRunId: string;
  publishPlanHash: string;
  decision: "approve";
  reason?: string;
  expiresAt?: string;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function assertApprovalDecision(value: unknown): ApprovalDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("approval_decision_invalid");
  }
  const source = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "releaseRunId",
    "publishPlanHash",
    "decision",
    "reason",
    "expiresAt",
  ]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new Error("approval_decision_unknown_field");
  }
  if (
    source.schemaVersion !== "tiangong.release.approval-decision.v1" ||
    source.decision !== "approve" ||
    typeof source.publishPlanHash !== "string" ||
    !SHA256_PATTERN.test(source.publishPlanHash)
  ) {
    throw new Error("approval_decision_contract_invalid");
  }
  const decision: ApprovalDecision = {
    schemaVersion: "tiangong.release.approval-decision.v1",
    releaseRunId: normalizeUuid(String(source.releaseRunId)),
    publishPlanHash: source.publishPlanHash,
    decision: "approve",
  };
  if (source.reason !== undefined) {
    if (
      typeof source.reason !== "string" ||
      !source.reason.trim() ||
      source.reason.trim().length > 1000
    ) {
      throw new Error("approval_decision_reason_invalid");
    }
    decision.reason = source.reason.trim();
  }
  if (source.expiresAt !== undefined) {
    if (
      typeof source.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(source.expiresAt))
    ) {
      throw new Error("approval_decision_expiry_invalid");
    }
    decision.expiresAt = new Date(source.expiresAt).toISOString();
  }
  return decision;
}

function assertDecisionBinding(
  decision: ApprovalDecision,
  releaseRunId: string,
  publishPlanHash: string,
): void {
  if (
    decision.releaseRunId !== normalizeUuid(releaseRunId) ||
    decision.publishPlanHash !== publishPlanHash
  ) {
    throw new Error("approval_decision_binding_mismatch");
  }
}

export async function applyApprovalDecision(input: {
  runDirectory: string;
  value: unknown;
}): Promise<{
  decision: ApprovalDecision;
  path: string;
  sha256: string;
  reused: boolean;
}> {
  const layout = releaseWorkspaceLayout(input.runDirectory);
  const plan = readJsonFile<Record<string, unknown>>(layout.publishPlan);
  const planHash = String(plan.planHash ?? "");
  const releaseRunId = String(plan.releaseRunId ?? "");
  const decision = assertApprovalDecision(input.value);
  assertDecisionBinding(decision, releaseRunId, planHash);

  if (existsSync(layout.approvalDecision)) {
    const existing = assertApprovalDecision(
      readJsonFile<unknown>(layout.approvalDecision),
    );
    assertDecisionBinding(existing, releaseRunId, planHash);
    if (
      canonicalize(existing as unknown as JsonValue) !==
      canonicalize(decision as unknown as JsonValue)
    ) {
      throw new Error("approval_decision_conflict");
    }
    return {
      decision: existing,
      path: layout.approvalDecision,
      sha256: await sha256File(layout.approvalDecision),
      reused: true,
    };
  }

  writeJsonAtomic(layout.approvalDecision, decision as unknown as JsonValue);
  const event = {
    schemaVersion: "tiangong.release.decision-event.v1",
    decisionHash: canonicalSha256(decision as unknown as JsonValue),
    decision,
  } as unknown as JsonValue;
  appendFileSync(layout.decisionLog, `${canonicalize(event)}\n`, {
    encoding: "utf8",
  });
  return {
    decision,
    path: layout.approvalDecision,
    sha256: await sha256File(layout.approvalDecision),
    reused: false,
  };
}

export function readApprovalDecision(runDirectory: string): ApprovalDecision {
  const layout = releaseWorkspaceLayout(runDirectory);
  if (!existsSync(layout.approvalDecision)) {
    throw new Error("approval_decision_required");
  }
  const plan = readJsonFile<Record<string, unknown>>(layout.publishPlan);
  const decision = assertApprovalDecision(
    readJsonFile<unknown>(layout.approvalDecision),
  );
  assertDecisionBinding(
    decision,
    String(plan.releaseRunId ?? ""),
    String(plan.planHash ?? ""),
  );
  return decision;
}
