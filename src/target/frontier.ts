import { existsSync } from "node:fs";
import { readApprovalDecision } from "../approval/decision.js";
import { readJsonFile } from "../io/files.js";
import { releaseWorkspaceLayout } from "../workspace/layout.js";
import type { ReleaseRequest } from "../workspace/run-store.js";
import {
  assertReleaseTargetBinding,
  resolveConfiguredReleaseTarget,
  sameReleaseTargetBinding,
  type ReleaseTargetBinding,
} from "./profile.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function assertRemoteTargetFrontier(input: {
  runDirectory: string;
  requireApproval: boolean;
  env?: NodeJS.ProcessEnv;
}): ReleaseTargetBinding {
  const layout = releaseWorkspaceLayout(input.runDirectory);
  const request = readJsonFile<ReleaseRequest>(layout.request);
  if (!request.target) throw new Error("release_target_binding_required");
  const frozen = assertReleaseTargetBinding(request.target);
  const configured = resolveConfiguredReleaseTarget({
    targetId: frozen.targetId,
    ...(input.env ? { env: input.env } : {}),
    requireCredential: true,
  });
  if (!sameReleaseTargetBinding(frozen, configured)) {
    throw new Error("release_target_binding_mismatch");
  }

  if (!existsSync(layout.publishPlan)) {
    throw new Error("publish_plan_required");
  }
  const plan = readJsonFile<Record<string, unknown>>(layout.publishPlan);
  const target = plan.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("publish_plan_target_required");
  }
  const targetRecord = target as Record<string, unknown>;
  if (
    targetRecord.targetId !== frozen.targetId ||
    typeof targetRecord.targetFingerprint !== "string" ||
    !SHA256_PATTERN.test(targetRecord.targetFingerprint) ||
    targetRecord.targetFingerprint !== frozen.targetFingerprint
  ) {
    throw new Error("publish_plan_target_mismatch");
  }

  if (input.requireApproval) {
    const decision = readApprovalDecision(layout.root);
    if (
      decision.schemaVersion !== "tiangong.release.approval-decision.v2" ||
      decision.targetFingerprint !== frozen.targetFingerprint
    ) {
      throw new Error("approval_decision_target_mismatch");
    }
  }
  return frozen;
}
