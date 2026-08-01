---
title: TianGong LCA Release Operator Guide
docType: guide
scope: repo
status: active
authoritative: true
owner: release
language: en
whenToUse:
  - when configuring or operating a deterministic LCI/LCIA release
  - when bootstrapping, inspecting, packaging, approving, publishing, or verifying a Release Run
whenToUpdate:
  - when the operator CLI, target binding, credential boundary, package profiles, or publication workflow changes
checkPaths:
  - README.md
  - .env.example
  - .agents/skills/tiangong-release-operator/**
  - specs/release-targets.json
  - contracts/supabase-consumer-manifest.v3.json
  - contracts/supabase-consumer-manifest.v3.schema.json
  - scripts/verify-supabase-consumer-manifest.ts
  - src/cli.ts
  - src/operator/**
  - src/target/**
  - .github/workflows/supabase-consumer-manifest.yml
lastReviewedAt: 2026-08-02
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Documented the candidate Supabase consumer manifest and actual-delivery-HEAD verification boundary for Issue #9."
related:
  - AGENTS.md
  - docs/architecture.md
  - .agents/skills/tiangong-release-operator/SKILL.md
---

# TianGong LCA Release

Agent-first control plane for deterministic, resumable LCI/LCIA releases.

The pipeline consumes a frozen `tiangong.calculation-bundle.v1` containing graph evidence, LCI/LCIA results, and an exact source closure. It builds one-hop LifecycleModels and Result Processes with stable UUID/version lineage, validates canonical TIDAS and ILCD variants, constructs four self-contained ZIPs, and publishes only through the actor-scoped `tiangong-lca` CLI.

## Security and target boundary

Remote access uses these environment variables:

```text
TIANGONG_LCA_API_BASE_URL
TIANGONG_LCA_API_KEY
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
```

`TIANGONG_LCA_API_KEY` is a password-equivalent user-session bootstrap. The release executable checks only that it is present and passes the protected environment to `tiangong-lca`; it never prints, decodes, puts it in command arguments, or persists it. Never use a Supabase service-role key.

The actor must have the live platform role `data_product_manager`. Authentication is performed by `tiangong-lca`; Edge and Database make the final authorization decision for every private read and state transition.

Only actor-scoped `tiangong-lca` commands receive the protected remote environment. Local Rust `tidas release` validation, conversion, round-trip, closure, and packaging processes run with a minimal non-credential environment allowlist.

Public target facts are versioned in `specs/release-targets.json`. Bootstrap freezes the selected target ID, API base URL, publishable-key SHA-256, and derived target fingerprint into the Release Request. The publish plan and v2 approval repeat that fingerprint. Before every remote frontier, the executable recomputes the current environment binding and rejects any mismatch before calling the public CLI.

The machine-verifiable candidate inventory at `contracts/supabase-consumer-manifest.v3.json` records this repository's complete indirect Supabase surface: versioned Functions gateway profiles, actor-scoped `tiangong-lca release` commands, the bounded dynamic dispatch helper, and signed bundle-manifest download. The verifier derives occurrences from the actual Git HEAD with the TypeScript AST, requires exact governed-source bytes relative to the audited source snapshot, and binds the schema bytes and canonical origin. It fails closed on direct PostgREST/SQL/PGMQ/Cron/Realtime or unresolved dynamic access. The manifest is non-authorizing and cannot approve a database freeze, migration, hosted mutation, or production mutation.

The ignored repository-local `.env` is loaded automatically by the executable when present. Keep it mode `0600` and never commit it.

## Development

```bash
nvm use 24
npm ci
npm run prepush:gate
```

The repository deliberately does not link an old CLI implementation. Point `TIANGONG_LCA_CLI_EXECUTABLE` at a release-capable `tiangong-lca` build and, when pinning a local native artifact, point `TIANGONG_TIDAS_EXECUTABLE` at Rust `tidas` v0.1.0 or newer. The default executable name is `tidas`; neither override is a credential.

Release stages 13–17 invoke only the unified `tidas release` command family. The adapter requires `tidas.operation-report.v1` with a matching nested `tidas.release-report.v1`, preserves the Rust diagnostic code and exit class in stage evidence, and records the observed binary version. Stable Rust exit classes are success `0`, data issues `2`, usage `64`, unavailable `69`, internal `70`, I/O `74`, and cancelled `130`. There is no Python package, legacy executable, or implicit fallback path.

For source operation with clean JSON stdout:

```bash
npm run --silent release -- doctor --target production --json
```

## Operator workflow

Check the explicit target and actor first:

```bash
tiangong-release doctor --target production --json
```

Bootstrap one deterministic run from an exact calculation package:

```bash
tiangong-release bootstrap --target production --package-id <package-uuid> --json
```

Bootstrap performs read/download operations only. It verifies the raw Calculation Bundle manifest and every artifact, materializes `source/source-closure.ndjson.gz` into a frozen local source tree, and derives the Release Run UUID from the package, calculation, bundle hash, profile lock, and target fingerprint. An identical retry reuses the same run; conflicting bytes cannot overwrite it. Signed URLs remain only in a deleted temporary projection.

List runs without selecting one implicitly, then inspect an exact directory:

```bash
tiangong-release runs list --json
tiangong-release candidate --run-dir .release/workspaces/<id> --json
tiangong-release plan --run-dir .release/workspaces/<id> --json
tiangong-release status --run-dir .release/workspaces/<id> --json
tiangong-release next --run-dir .release/workspaces/<id> --json
```

Every run-specific command requires `--run-dir`; there is no mutable-latest fallback. `candidate` writes the bounded report `reports/release-candidate.json`, containing counts, hashes, findings, artifact paths, and next commands rather than large dataset arrays.

Run local validation and packaging:

```bash
tiangong-release validate --run-dir .release/workspaces/<id> --json
tiangong-release package --run-dir .release/workspaces/<id> --json
tiangong-release candidate --run-dir .release/workspaces/<id> --json
```

The four deterministic ZIPs are:

- unit-process full closure in TIDAS;
- unit-process full closure in ILCD;
- standalone LifecycleModel/result full closure in TIDAS;
- standalone LifecycleModel/result full closure in ILCD.

Packaging never authenticates or mutates remote publication state. `tidas release build-packages` atomically publishes the four archives; a failed retry leaves the preceding package bytes and Release Core publish plan unchanged.

## Approval, publication, and readback

Human approval must bind the exact target fingerprint and `outputs/publish-plan.json` `planHash`:

```json
{
  "schemaVersion": "tiangong.release.approval-decision.v2",
  "releaseRunId": "<release-run-uuid>",
  "publishPlanHash": "<64 lowercase hex characters>",
  "targetFingerprint": "<64 lowercase hex characters>",
  "decision": "approve",
  "reason": "Reviewed the exact target, package hashes, and validation evidence."
}
```

Apply the immutable decision, publish that plan, then independently verify remote bytes:

```bash
tiangong-release decision apply --run-dir .release/workspaces/<id> --input approval.json --json
tiangong-release publish --run-dir .release/workspaces/<id> --approve-plan <plan-hash> --json
tiangong-release verify --run-dir .release/workspaces/<id> --json
```

Stage 18 revalidates all bindings before remote work, then performs idempotent `prepare -> upload -> finalize -> approve`. Stage 19 publishes only with the returned approval ID/hash. Stage 20 performs a fresh status read, downloads all four ZIPs into `outputs/readback-artifacts/`, verifies exact byte size and SHA-256, submits the readback receipt, and queries terminal status again.

Failures leave a stage ledger entry and may be retried at the same frontier. A passed successor seals all predecessors. Terminal status progresses through `ready_for_approval`, `approved`, `published`, and `verified`.

Remote request/receipt files contain IDs, hashes, public metadata, and storage references only. The combined proof is `reports/independent-readback-report.json`.

## Codex operation

The repository-local `.agents/skills/tiangong-release-operator/SKILL.md` teaches Codex the bounded workflow. Its default actions are doctor, bootstrap, list, candidate, plan, validation, and package. It requires an exact human confirmation of the current target fingerprint and plan hash before creating a v2 decision or beginning any remote mutation.
