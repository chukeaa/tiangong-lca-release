import path from "node:path";

export type ReleaseWorkspaceLayout = ReturnType<typeof releaseWorkspaceLayout>;

export function releaseWorkspaceLayout(runDirectory: string) {
  const root = path.resolve(runDirectory);
  return {
    root,
    run: path.join(root, "run.json"),
    request: path.join(root, "release-request.json"),
    profileLock: path.join(root, "profile-lock.json"),
    previousManifest: path.join(root, "previous-release-manifest.json"),
    artifactIndex: path.join(root, "artifact-index.jsonl"),
    decisionLog: path.join(root, "decision-log.jsonl"),
    stages: path.join(root, "stages"),
    cache: path.join(root, "cache"),
    reports: path.join(root, "reports"),
    outputs: path.join(root, "outputs"),
    identities: path.join(root, "outputs", "identities.jsonl"),
    modelDrafts: path.join(root, "outputs", "model-drafts.jsonl"),
    resultDrafts: path.join(root, "outputs", "result-drafts.jsonl"),
    metadataDrafts: path.join(
      root,
      "outputs",
      "metadata-complete-drafts.jsonl",
    ),
    descriptorDrafts: path.join(root, "outputs", "descriptor-drafts.json"),
    versionPlan: path.join(root, "outputs", "version-plan.json"),
    renderedDatasets: path.join(root, "outputs", "rendered-datasets.jsonl"),
    canonicalTidas: path.join(root, "outputs", "canonical-tidas"),
    canonicalDatasetIndex: path.join(
      root,
      "outputs",
      "canonical-dataset-index.json",
    ),
    ilcd: path.join(root, "outputs", "ilcd"),
    packages: path.join(root, "outputs", "packages"),
    releaseManifest: path.join(root, "outputs", "release-manifest.json"),
    publishPlan: path.join(root, "outputs", "publish-plan.json"),
    approvalDecision: path.join(root, "outputs", "approval-decision.json"),
    prepareRequest: path.join(root, "outputs", "release-prepare-request.json"),
    prepareReceipt: path.join(root, "outputs", "release-prepare-receipt.json"),
    uploadRequest: path.join(root, "outputs", "release-upload-request.json"),
    uploadReceipt: path.join(root, "outputs", "release-upload-receipt.json"),
    finalizeRequest: path.join(
      root,
      "outputs",
      "release-finalize-request.json",
    ),
    finalizeReceipt: path.join(
      root,
      "outputs",
      "release-finalize-receipt.json",
    ),
    approvalRequest: path.join(
      root,
      "outputs",
      "release-approval-request.json",
    ),
    approvalReceipt: path.join(root, "outputs", "approval-receipt.json"),
    publicationRequest: path.join(
      root,
      "outputs",
      "release-publish-request.json",
    ),
    publicationReceipt: path.join(root, "outputs", "publication-receipt.json"),
    readbackStatusBefore: path.join(
      root,
      "outputs",
      "readback-status-before.json",
    ),
    readbackRequest: path.join(
      root,
      "outputs",
      "release-readback-request.json",
    ),
    readbackReceipt: path.join(root, "outputs", "readback-receipt.json"),
    readbackStatusAfter: path.join(
      root,
      "outputs",
      "readback-status-after.json",
    ),
    readbackReport: path.join(
      root,
      "reports",
      "independent-readback-report.json",
    ),
    readbackArtifacts: path.join(root, "outputs", "readback-artifacts"),
  };
}
