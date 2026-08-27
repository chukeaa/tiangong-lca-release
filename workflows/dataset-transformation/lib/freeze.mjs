import path from "node:path";
import { buildAnalysis, resolveFamilyValues } from "./analysis.mjs";
import { loadCandidate, loadProcessInputs } from "./candidate.mjs";
import { fail, hashJson } from "./common.mjs";
import { validateContract } from "./contracts.mjs";
import { readJson, writeCanonical, writeImmutableDirectory } from "./io.mjs";

export async function freezeTransformation({
  candidateDir,
  dslFile,
  analysisDir,
  outDir,
}) {
  const { value: draft } = await readJson(
    dslFile,
    "transformation_dsl_missing",
  );
  const { value: priorAnalysis } = await readJson(
    path.join(analysisDir, "transformation-analysis.json"),
    "transformation_analysis_missing",
  );
  const candidate = await loadCandidate(candidateDir);
  if (
    priorAnalysis.transformationDraftSha256 !== hashJson(draft) ||
    priorAnalysis.candidate?.releaseCandidateSha256 !==
      candidate.candidateSha256
  )
    fail(
      "transformation_analysis_binding_mismatch",
      "Draft DSL or Candidate differs from the inspected analysis",
    );
  const analysis = await buildAnalysis({ candidate, draft });
  if (hashJson(analysis) !== hashJson(priorAnalysis))
    fail(
      "transformation_analysis_drift",
      "Current deterministic analysis differs from the inspected artifact",
    );
  if (analysis.status !== "ready")
    return {
      status: "needs_decision",
      unresolvedConflictIds: analysis.unresolvedConflictIds,
      analysisSha256: hashJson(analysis),
      path: null,
    };

  const inputs = await loadProcessInputs(candidate, draft.operation.inputs);
  const fields = resolveFamilyValues(inputs, draft);
  const frozen = {
    schemaVersion: "tiangong.release.dataset-transformation-frozen-spec.v0",
    status: "frozen",
    operation: {
      type: draft.operation.type,
      candidate: analysis.candidate,
      inputs: analysis.operation.inputs.map((input) => ({
        key: input.key,
        uuid: input.uuid,
        version: input.version,
        path: input.path,
        sha256: input.sha256,
        canonicalContentHash: input.canonicalContentHash,
        reference: input.reference,
      })),
      weighting: analysis.operation.weighting,
    },
    output: structuredClone(draft.output),
    policies: structuredClone(draft.policies),
    resolvedFields: fields,
    decisions: structuredClone(draft.decisions ?? []),
    resultEvidence: {
      disposition: "invalidated",
      reason:
        "Weighted Unit Process aggregation creates new quantitative inventory semantics",
      nextWorkflow: "calculation",
    },
    lineage: {
      transformationDraftSha256: hashJson(draft),
      transformationAnalysisSha256: hashJson(analysis),
    },
  };
  validateContract("frozenSpec", frozen);
  const target = await writeImmutableDirectory(outDir, async (staging) => {
    await writeCanonical(
      path.join(staging, "transformation-frozen-spec.json"),
      frozen,
    );
    await writeCanonical(
      path.join(staging, "transformation-analysis.json"),
      analysis,
    );
  });
  return {
    status: "frozen",
    path: target,
    frozenSpec: frozen,
    frozenSpecSha256: hashJson(frozen),
    unresolvedConflictIds: [],
  };
}
