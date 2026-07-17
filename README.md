# TianGong LCA Release

Agent-first control plane for deterministic, resumable LCI/LCIA releases.

The release pipeline consumes a frozen `tiangong.calculation-bundle.v1`, builds one-hop LifecycleModels and Result Processes with stable UUID/version lineage, validates canonical TIDAS and ILCD package variants, and publishes only through the actor-scoped `tiangong-lca` CLI.

## Security boundary

The process inherits these variables only when a remote command is needed:

```text
TIANGONG_LCA_API_BASE_URL
TIANGONG_LCA_API_KEY
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
```

The API key is a password-equivalent user-session bootstrap. This repository never reads or stores it and never accepts a Supabase service-role key.

The account behind the key must have the live platform role `data_product_manager`. Authentication is performed by `tiangong-lca`; Edge and Database make the final authorization decision for every private read and state transition.

## Development

```bash
nvm use 24
npm ci
npm run prepush:gate
```

The remote stages require an independently provisioned `tiangong-lca` build that implements `tiangong-lca release --help`; this repository deliberately does not link an old CLI library dependency. During local cross-repo development, point `TIANGONG_LCA_CLI_EXECUTABLE` at that exact built executable. `TIANGONG_TIDAS_TOOLS_EXECUTABLE` similarly selects the release-capable TIDAS tool. Neither override is a credential.

## Command surface

```bash
tiangong-release init --input release-request.json --out-dir .release/workspaces/<id>
tiangong-release plan --run-dir .release/workspaces/<id>
tiangong-release status --run-dir .release/workspaces/<id>
tiangong-release next --run-dir .release/workspaces/<id>
tiangong-release run-stage --run-dir .release/workspaces/<id> --stage <id>
tiangong-release decision apply --run-dir .release/workspaces/<id> --input decisions.json
tiangong-release validate --run-dir .release/workspaces/<id>
tiangong-release package --run-dir .release/workspaces/<id>
tiangong-release publish --run-dir .release/workspaces/<id> --approve-plan <sha256>
tiangong-release verify --run-dir .release/workspaces/<id>
```

Use `--json` for stable machine output. Logs go to stderr and large data goes to workspace artifacts.

## Publication workflow

`package` runs every incomplete local stage through deterministic four-ZIP construction. It does not authenticate or mutate remote state:

```bash
tiangong-release package --run-dir .release/workspaces/<id> --json
tiangong-release plan --run-dir .release/workspaces/<id> --json
```

Publication requires an explicit decision bound to the exact `outputs/publish-plan.json` `planHash`:

```json
{
  "schemaVersion": "tiangong.release.approval-decision.v1",
  "releaseRunId": "<release-run-uuid>",
  "publishPlanHash": "<64 lowercase hex characters>",
  "decision": "approve",
  "reason": "Reviewed exact package and validation evidence."
}
```

Apply the immutable decision, publish, then independently verify remote bytes:

```bash
tiangong-release decision apply --run-dir .release/workspaces/<id> --input approval.json --json
tiangong-release publish --run-dir .release/workspaces/<id> --approve-plan <plan-hash> --json
tiangong-release verify --run-dir .release/workspaces/<id> --json
```

Stage 18 validates the decision before any remote action, re-hashes the profile lock, Calculation Bundle manifest, publish plan, Release Manifest, and all four ZIPs, then performs idempotent `prepare -> upload -> finalize -> approve` through the public CLI. Stage 19 publishes only with the returned approval ID/hash. Stage 20 starts from a fresh remote status read, downloads all four published ZIPs to `outputs/readback-artifacts/`, verifies exact byte size and SHA-256, submits the readback receipt, and queries the terminal status again.

Failures leave a stage ledger entry and may be retried at the same frontier. Upload object keys and prepare/publish idempotency keys are derived from immutable release identities. Once a successor passes, earlier stages are sealed and cannot be rerun. Terminal run status progresses through `ready_for_approval`, `approved`, `published`, and `verified`.

Remote request/receipt files are stored under `outputs/`; the combined independent proof is `reports/independent-readback-report.json`. They contain IDs, hashes, public metadata, and storage references only—never the User API Key, password, access/refresh token, or service-role credential.
