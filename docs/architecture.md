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
  - src/**
lastReviewedAt: 2026-07-17
lastReviewedCommit: 460c6ddd8425d5441a386cf2f1c5da41dd8ced05
lastReviewedNote: "Documented Release Core workspace integration during initial Docpact onboarding; runtime architecture is unchanged."
related:
  - ../AGENTS.md
  - ../.docpact/config.yaml
  - ../README.md
---

# Architecture

The executable flow is:

```text
Worker Calculation Bundle
  -> local Release Run stages and cache
  -> tidas-sdk programmatic validation
  -> tidas-tools conversion / closure / deterministic ZIP
  -> tiangong-lca actor-scoped remote commands
  -> Database / Edge publication truth
  -> independent readback
```

Calculation and publication are separate. A completed calculation may be previewed and downloaded without creating a public release. Publication is possible only after canonical artifacts, validation, closure, semantic round-trip, an immutable publish plan, and durable approval all match.

The relational platform stores release/index/hash/status/approval/audit facts. Generated datasets and packages remain immutable objects and never become ordinary editable Process or LifecycleModel rows.

## Workspace integration boundary

`lca-workspace` integrates this repository as the `release` child repository and pins an exact commit. Release Core remains the owner of local release orchestration; root workspace governance owns only cataloging, routing, branch-policy facts, and the submodule pointer. The current canonical remote is the private `chukeaa/tiangong-lca-release` repository until a separately approved ownership migration changes that URL.

## Remote stage boundary

The three remote stages use only the public `tiangong-lca release` command family:

```text
18 approval
  local exact-plan decision
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
