---
title: tiangong-lca-release Repository Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: release
language: en
whenToUse:
  - when changing release identity, versioning, stage orchestration, materialization, package planning, approval handoff, or readback
  - when deciding whether logic belongs in Release, Worker, tidas-tools, tidas-sdk, CLI, Database, Edge, or Next
whenToUpdate:
  - when repository ownership, branch policy, stage contracts, or validation gates change
checkPaths:
  - AGENTS.md
  - README.md
  - specs/**
  - src/**
  - test/**
  - package.json
---

# Repository Contract

`tiangong-lca-release` is the Agent-first control plane for deterministic TianGong LCI/LCIA releases. It consumes an immutable Calculation Bundle and frozen source closure, derives Model/Result identities and versions, orchestrates TIDAS/ILCD materialization and validation, records resumable stage evidence, and hands an approved publish plan to the public `tiangong-lca` CLI.

## Ownership

This repository owns:

- Release Run workspaces and the 20-stage state machine;
- F3 Calculation Bundle, Release Manifest, identity, profile, stage, and decision contracts;
- UUIDv5 identity and dataset-version planning;
- one-hop LifecycleModel and Result Process materialization orchestration;
- content-addressed local cache and artifact ledger;
- package-plan, approval-plan, publish handoff, and readback aggregation;
- the `tiangong-release` executable and its human/JSON output contract.

This repository does not own:

- Worker solving or Calculation Bundle production;
- TIDAS/ILCD schemas, standalone conversion, validation, or deterministic ZIP implementation;
- SDK generation;
- remote authentication, direct SQL/REST mutation, RLS, or publication truth;
- frontend behavior.

Route those concerns respectively to Worker, `tidas-tools`, `tidas-sdk`, `tiangong-lca-cli` / Database / Edge, and Next.

## Hard Boundaries

- Never use a Supabase secret/service-role credential.
- Never decode, print, persist, or forward `TIANGONG_LCA_API_KEY`; invoke `tiangong-lca` with the inherited protected environment.
- Never write generated Model/Result datasets to ordinary authoring tables.
- Never infer missing graph, exchange, provider, method, or version facts from mutable database `latest` state.
- Never publish without an exact durable plan hash and a successful independent readback.
- Never rerun an earlier stage after a successor has passed; recovery may only retry the current frontier with the same immutable identities.
- Never treat partial closure or a legacy LCIA-only package as a Release v1 package.
- Large artifacts go to files/object storage, never JSON stdout.

## Runtime and Branch Facts

- Node: `>=24 <25`
- package manager: `npm`
- branch model: M1, `main` is the daily and release trunk
- local baseline: `npm run lint`, `npm test`, `npm run build`
- full local gate: `npm run prepush:gate`
- runtime workspaces: `.release/workspaces/<release-run-id>/` and always gitignored

## Validation

Changes to identity or canonicalization require fixed-vector tests. Changes to versioning require same-input replay, major/minor, collision, and non-convergence tests. Changes to stages require resume/cache/failure evidence. Materialization/package changes require TIDAS schema, ILCD XSD, semantic round-trip, full closure, cross-package canonical-content, and numerical parity proof.

Remote publication changes additionally require exact-plan approval, manager-denial, partial-failure resume, four-artifact independent download/hash verification, post-readback status, and credential non-persistence tests. Run status advances through `ready_for_approval -> approved -> published -> verified`; a passed successor permanently seals its predecessors.
