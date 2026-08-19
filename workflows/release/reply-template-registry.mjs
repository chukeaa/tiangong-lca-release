const ROOT = "workflows/release/reply-templates";

const templates = Object.freeze({
  "package build": [
    "release-candidate-built",
    "release-candidate-built.md",
    [
      "candidate",
      "profile",
      "packageCount",
      "packageSetHash",
      "publicationAuthorized",
      "artifacts",
      "nextActions",
    ],
  ],
});

const inputDriftCodes = new Set([
  "materialized_dataset_hash_mismatch",
  "source_closure_hash_mismatch",
  "source_dataset_hash_mismatch",
  "materialization_manifest_hash_mismatch",
  "canonical_index_hash_mismatch",
]);

export function replyTemplateFor(command, { ok, errorCode } = {}) {
  const entry = ok
    ? templates[command]
    : inputDriftCodes.has(errorCode)
      ? [
          "release-input-drift",
          "release-input-drift.md",
          ["command", "error", "nextActions"],
        ]
      : [
          "release-command-failed",
          "release-command-failed.md",
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

export const REPLY_TEMPLATE_COMMANDS = Object.freeze(Object.keys(templates));
