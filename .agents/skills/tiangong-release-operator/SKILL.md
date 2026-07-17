---
name: tiangong-release-operator
description: Operate the TianGong LCI/LCIA release repository through its agent-friendly CLI. Use when a user asks Codex to check release readiness, bootstrap a deterministic Release Run from a calculation package, list or inspect runs, build and review release packages, apply an exact target-bound approval, publish, or verify independent readback.
---

# TianGong Release Operator

Use the repository CLI as the control surface for a release. Keep every target and run selection explicit, preserve the actor-scoped security boundary, and stop for exact human approval before the first remote mutation.

## Command entrypoint

Run commands from the repository root. During source development, use:

```bash
npm run release -- <command> --json
```

The executable loads the ignored repository-local `.env` when present. Never print, decode, copy into an argument, or persist `TIANGONG_LCA_API_KEY`. Do not inspect `.env` contents to diagnose a release; use `doctor` and report only its bounded checks.

After a build, `node dist/cli.js <command> --json` is equivalent.

## Safety boundary

- Treat `doctor`, `bootstrap`, `runs list`, `candidate`, `plan`, `status`, `next`, `validate`, and `package` as local or read-only operations.
- Treat `decision apply` as the durable local approval frontier.
- Treat stage `approval`, `publish`, and `verify` as remote operations. The approval stage performs remote prepare, upload, finalize, and actor approval before publish.
- Never choose a mutable “latest” run. Require an exact `--run-dir` for every run-specific command.
- Never infer a target. Require `--target production` or another versioned target ID for `doctor` and `bootstrap`.
- Never use a service-role key. The protected key must represent an actor whose live role is `data_product_manager`; Edge and Database remain authoritative.
- Local `tidas-tools` processes must receive only the release executable's minimal non-credential environment; do not forward `.env` values manually.
- Never create or apply an approval merely because local packaging passed. Human confirmation must bind the exact target fingerprint and publish-plan hash.

## Workflow

### 1. Check the explicit target

```bash
npm run release -- doctor --target production --json
```

Continue only when `status` is `ready`. A `package_not_found` result from the random read probe is an expected authorization success and is already normalized by `doctor`. Resolve failed environment, tool, credential-presence, or manager-role checks before intake.

### 2. Bootstrap from an exact calculation package

```bash
npm run release -- bootstrap --target production --package-id <package-uuid> --json
```

Bootstrap performs only actor-scoped reads. It downloads and verifies the Calculation Bundle manifest and every artifact, materializes the frozen source closure, and derives a deterministic Release Run ID from immutable inputs. Repeating the same command must return the same run with `reused: true`; an existing conflicting run is an error.

Preserve the returned `runDirectory`. Do not replace it with a guessed path.

### 3. Inspect a specific run

Discover runs only when needed:

```bash
npm run release -- runs list --json
```

Then inspect one exact candidate:

```bash
npm run release -- candidate --run-dir <exact-run-directory> --json
npm run release -- plan --run-dir <exact-run-directory> --json
```

Summarize status, target ID and fingerprint, bundle hash, blockers, warnings, artifact paths, and next commands. Prefer the compact candidate report over loading large NDJSON artifacts into context.

### 4. Validate and package locally

```bash
npm run release -- package --run-dir <exact-run-directory> --json
npm run release -- candidate --run-dir <exact-run-directory> --json
```

Packaging may produce four ZIPs: TIDAS and ILCD variants for the unit-process profile and standalone LifecycleModel/result profile. It does not authorize or publish them.

Before requesting approval, verify that the candidate has no blockers and report:

- exact run directory and Release Run UUID;
- target ID and full target fingerprint;
- full `outputs/publish-plan.json` plan hash;
- release version and the four package SHA-256 values;
- validation status and relevant report paths.

### 5. Stop for exact human confirmation

Do not proceed from a generic earlier statement such as “publish when ready.” Ask the user to confirm the displayed target fingerprint and plan hash for this run. If either value changes, request confirmation again.

After exact confirmation, create a local v2 decision containing only:

```json
{
  "schemaVersion": "tiangong.release.approval-decision.v2",
  "releaseRunId": "<exact-run-uuid>",
  "publishPlanHash": "<exact-plan-sha256>",
  "targetFingerprint": "<exact-target-sha256>",
  "decision": "approve",
  "reason": "<concise human-approved reason>"
}
```

Apply it to the same exact run:

```bash
npm run release -- decision apply --run-dir <exact-run-directory> --input <decision-file> --json
```

### 6. Publish and verify

Only after the exact decision is applied:

```bash
npm run release -- publish --run-dir <exact-run-directory> --approve-plan <exact-plan-sha256> --json
npm run release -- verify --run-dir <exact-run-directory> --json
```

The CLI rechecks the current environment against the frozen target profile before every remote frontier. A target mismatch must fail before any remote command. Do not work around this guard by editing the request, plan, decision, catalog, or environment during a release.

Completion requires terminal `verified` status and an independent readback report that re-downloaded and hash-checked all four published ZIPs.

## Failure handling

- Use the returned `code`, artifact paths, and `nextCommands`; do not scrape prose logs when JSON exists.
- A failed stage remains retryable at the same exact frontier after correcting the cause.
- Do not rerun a sealed predecessor after a successor has passed.
- If output says `truncated: true`, open only the named report artifact needed to resolve the finding.
- If authorization or target checks fail, stop. Do not substitute another account, key, endpoint, run, or target without explicit user direction.
