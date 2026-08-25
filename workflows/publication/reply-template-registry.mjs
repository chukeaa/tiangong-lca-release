const ROOT = "workflows/publication/reply-templates";

const templates = Object.freeze({
  "plan prepare": [
    "publish-plan-prepared",
    "publish-plan-prepared.md",
    [
      "candidate",
      "component",
      "targetId",
      "requestedRootCount",
      "dependencyAdditionCount",
      "prunedDatasetCount",
      "effectiveDatasetCount",
      "effectiveSetHash",
      "publishPlanSha256",
      "publicationAuthorized",
      "remoteExecutionAvailable",
      "artifacts",
      "nextActions",
    ],
  ],
});

export function replyTemplateFor(command, { ok } = {}) {
  const entry = ok
    ? templates[command]
    : [
        "publication-command-failed",
        "publication-command-failed.md",
        ["command", "error", "nextActions"],
      ];
  if (!entry) return undefined;
  const [id, filename, requiredFacts] = entry;
  return {
    id,
    path: `${ROOT}/${filename}`,
    format: "markdown",
    placeholderSyntax: "{{...}}",
    requiredFacts,
  };
}
