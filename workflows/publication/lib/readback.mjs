import path from "node:path";
import { fail, hashJson } from "./common.mjs";
import { classifyRow } from "./inspection.mjs";
import {
  assertExactObject,
  readJson,
  verifyJsonHash,
  writeCanonical,
  writeImmutableDirectory,
} from "./io.mjs";
import { loadVerifiedPayload } from "./payload.mjs";
import { inspectDataset, resolvePublicationRuntime } from "./remote.mjs";

export async function verifyPublicationReadback({
  executionDir,
  payloadDir,
  outDir,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const executionRoot = path.resolve(executionDir);
  const { value: executionReceipt } = await readJson(
    path.join(executionRoot, "publication-execution-receipt.json"),
    "publication_execution_receipt_missing",
  );
  const { value: executablePlan } = await readJson(
    path.join(executionRoot, "publication-executable-plan.json"),
    "publication_executable_plan_missing",
  );
  const { value: approval } = await readJson(
    path.join(executionRoot, "publication-approval.json"),
    "publication_approval_missing",
  );
  if (
    executionReceipt.schemaVersion !==
      "tiangong.release.publication-execution-receipt.v1" ||
    executionReceipt.status !== "published"
  )
    fail(
      "publication_execution_receipt_unsupported",
      "Independent readback requires a completed Publication Execution Receipt",
    );
  assertExactObject(
    executionReceipt,
    [
      "schemaVersion",
      "status",
      "approvalSha256",
      "executablePlanSha256",
      "payloadManifestSha256",
      "targetId",
      "publishedState",
      "completedAt",
      "datasetCount",
      "completedKeys",
      "eventCount",
      "eventLogHash",
      "independentReadbackVerified",
    ],
    "publication_execution_receipt_invalid",
    "Publication execution receipt",
  );
  verifyJsonHash(
    executablePlan,
    executionReceipt.executablePlanSha256,
    "publication_readback_plan_hash_mismatch",
    "Publication executable plan",
  );
  verifyJsonHash(
    approval,
    executionReceipt.approvalSha256,
    "publication_readback_approval_hash_mismatch",
    "Publication approval",
  );
  const payload = await loadVerifiedPayload(
    payloadDir,
    executionReceipt.payloadManifestSha256,
  );
  const runtime = await resolvePublicationRuntime({ env, fetchImpl });
  const rows = [];
  const failures = [];
  for (const dataset of payload.datasets) {
    const remoteRow = await inspectDataset({ runtime, dataset, fetchImpl });
    const observed = classifyRow({
      dataset,
      row: remoteRow,
      actorUserId: runtime.actorUserId,
      publishedStateCode: executionReceipt.publishedState.code,
    });
    const verified = observed.classification === "matching_published";
    rows.push({
      key: dataset.key,
      table: dataset.table,
      uuid: dataset.uuid,
      version: dataset.version,
      expectedCanonicalContentHash: dataset.canonicalContentHash,
      observedCanonicalContentHash: observed.observedContentHash,
      expectedStateCode: executionReceipt.publishedState.code,
      observedStateCode: observed.stateCode,
      verified,
    });
    if (!verified)
      failures.push({
        key: dataset.key,
        classification: observed.classification,
        blocker: observed.blocker,
      });
  }
  if (failures.length)
    fail(
      "publication_independent_readback_failed",
      "Independent Publication readback found content or state mismatches",
      { failures },
    );
  const receipt = {
    schemaVersion: "tiangong.release.publication-readback-receipt.v1",
    status: "verified",
    independentlyQueried: true,
    executionReceiptSha256: hashJson(executionReceipt),
    executablePlanSha256: hashJson(executablePlan),
    approvalSha256: hashJson(approval),
    payloadManifestSha256: payload.manifestSha256,
    targetId: executionReceipt.targetId,
    publishedState: executionReceipt.publishedState,
    verifiedAt: now().toISOString(),
    datasetCount: rows.length,
    verifiedSetHash: hashJson(
      rows.map(({ key, observedCanonicalContentHash, observedStateCode }) => ({
        key,
        observedCanonicalContentHash,
        observedStateCode,
      })),
    ),
    rows,
  };
  const target = path.resolve(outDir);
  await writeImmutableDirectory(target, async (staging) => {
    await writeCanonical(
      path.join(staging, "publication-execution-receipt.json"),
      executionReceipt,
    );
    await writeCanonical(
      path.join(staging, "publication-readback-receipt.json"),
      receipt,
    );
  });
  return { path: target, receipt, receiptSha256: hashJson(receipt) };
}
