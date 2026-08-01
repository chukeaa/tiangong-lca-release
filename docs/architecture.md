---
title: Release Core Architecture
docType: architecture
scope: repo
status: active
authoritative: true
owner: release
language: en
whenToUse:
  - when changing Release Run stages, materialization, publication handoff, or readback
  - when deciding cross-repository boundaries for Worker, tidas-tools, CLI, Database, Edge, and Next
whenToUpdate:
  - when stage ordering, dependency direction, publication authority, or workspace integration changes
checkPaths:
  - docs/architecture.md
  - AGENTS.md
  - .docpact/config.yaml
  - specs/**
  - contracts/supabase-consumer-manifest.v3.json
  - contracts/supabase-consumer-manifest.v3.schema.json
  - scripts/verify-supabase-consumer-manifest.ts
  - src/**
  - .github/workflows/supabase-consumer-manifest.yml
lastReviewedAt: 2026-08-02
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Reviewed the indirect Supabase consumer topology, AST exact-set proof, and external delivery-commit binding for Issue #9."
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ../README.md
---

# Architecture

The executable flow is:

```text
data-manager calculation package ID
  -> actor-scoped Calculation Bundle projection and exact downloads
  -> frozen manifest, source closure, and target-bound Release Request
  -> local Release Run stages and cache
  -> Rust tidas release validation / conversion / round-trip / closure / deterministic ZIP
  -> tiangong-lca actor-scoped remote commands
  -> Database / Edge publication truth
  -> independent readback
```

Calculation and publication are separate. A completed calculation may be previewed and downloaded without creating a public release. Publication is possible only after canonical artifacts, validation, closure, semantic round-trip, an immutable publish plan, and durable approval all match.

Stages 13–17 delegate their domain gates to the unified native `tidas release` surface and accept only the versioned `tidas.operation-report.v1` plus nested `tidas.release-report.v1` contracts. Release Core keeps orchestration, bundle-to-dataset numerical parity, stage evidence, manifest and publish-plan construction, approval, publication, and readback. The local adapter passes no publication credentials or Python environment assumptions and has no legacy executable fallback.

## Operator intake boundary

`doctor --target <id>` validates the Node runtime, versioned public target profile, protected credential presence, CLI/tool availability, and a read-only manager authorization probe. It does not create or mutate a release.

`bootstrap --target <id> --package-id <uuid>` asks `tiangong-lca` for the actor-scoped Calculation Bundle projection, keeps signed URLs in a temporary directory, downloads the exact raw manifest and every declared artifact, and re-verifies byte size, SHA-256, bundle content hash, scope, and required artifact kinds. The required `source_closure` NDJSON artifact is transformed into the repository's frozen source-tree contract without changing canonical document bytes.

The Release Run UUID is UUIDv5-derived from immutable package, calculation, bundle, profile-lock, and target facts. The same input reuses the same workspace; no command chooses a mutable latest run. `runs list` is discovery only, while every run-specific operation requires an exact directory. `candidate` is the bounded F2 report surface for Agents and humans.

The legacy `init` path remains readable for existing local runs. A run without a target binding may execute local stages, but it can never cross a remote frontier.

The relational platform stores release/index/hash/status/approval/audit facts. Generated datasets and packages remain immutable objects and never become ordinary editable Process or LifecycleModel rows.

## Workspace integration boundary

`lca-workspace` integrates this repository as the `release` child repository and pins an exact commit. Release Core remains the owner of local release orchestration; root workspace governance owns only cataloging, routing, branch-policy facts, and the submodule pointer. The current canonical remote is the private `chukeaa/tiangong-lca-release` repository until a separately approved ownership migration changes that URL.

## Remote stage boundary

The target profile contains only public environment identity: target ID, API base URL, and the SHA-256 of the expected publishable key. Its canonical fingerprint is frozen in the Release Request, included in the publish-plan hash, and repeated by approval-decision v2. Immediately before any remote command, Release Core requires the current environment, request, publish plan, and approval to bind the same fingerprint. This is a local fail-closed guard in addition to actor authorization enforced by Edge and Database.

The three remote stages use only the public `tiangong-lca release` command family:

```text
18 approval
  local exact-target and exact-plan v2 decision
  -> prepare run
  -> upload four content-addressed ZIPs
  -> service-only artifact finalize after Edge byte/hash verification
  -> actor approval

19 publish
  durable approval ID/hash + exact plan hash
  -> actor publication transaction

20 readback-verify
  fresh remote status
  -> four signed downloads to a new local directory
  -> local exact byte/hash comparison
  -> database readback receipt
  -> fresh terminal status
```

The control plane inherits the protected environment when spawning the CLI, but command arguments and workspace artifacts contain no credential. Prepare and publish use deterministic idempotency keys. Signed upload retry is confined to the same content-addressed identity, while finalize re-verifies bytes. A later passed stage seals all predecessors, preventing an old plan or package stage from being replayed after approval or publication.

## Supabase consumer evidence boundary

Release Core has no direct PostgREST, PostgreSQL/SQL, PGMQ, Cron, Realtime, or Supabase CLI database consumer. Its remote dependency is deliberately indirect: a versioned Functions gateway profile, actor-scoped `tiangong-lca release` commands whose authorization remains authoritative in Edge/Database, and one opaque signed-storage download whose bytes are independently verified.

`contracts/supabase-consumer-manifest.v3.json` is candidate evidence for that boundary. `scripts/verify-supabase-consumer-manifest.ts` reads regular files from the audited Git tree, derives every occurrence with the TypeScript AST, then independently scans the actual delivery HEAD and requires the governed source-tree bytes and bidirectional occurrence set to match exactly. The manifest therefore does not embed its own delivery SHA: an external verifier must bind the emitted actual `deliveryCommit` and exact manifest/schema hashes. This avoids a self-referential old-commit pin that could remain green after later consumer source changes. The evidence is non-authorizing and remains insufficient without database-engine exact-byte consumption and a real joint Supabase lifecycle test.
