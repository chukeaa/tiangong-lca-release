---
title: Resolved One-hop Result Materialization Design
docType: design
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当设计或实现 Result Process 与 LifecycleModel 的本地物化时
  - 当决定一个 LifecycleModel 应包含哪些 Process instance 和 connection 时
  - 当按 Process 范围编排 Result Materialization 时
whenToUpdate:
  - 当 Result Process 原子物化、one-hop Model 组合或范围解析规则变化时
  - 当 provider edge、identity/version、validation 或本地输出契约变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: 5125fd8b6a1679f25b29032127e41d82bf063002
lastReviewedNote: "Defined local two-phase Result Process materialization and resolved one-hop LifecycleModel composition."
related:
  - ../README.md
  - ../AGENTS.md
  - ../../release/README.md
---

# Resolved One-hop Result Materialization

## 决策

Result Materialization 全部在本地完成。它生成、验证并冻结 canonical datasets；数据库写入、Package、审批和发布只由后续 Release Workflow 处理。

首个 LifecycleModel 组合 profile 固定为：

```text
resolved-one-hop-aggregated-background.v1
```

对于每个根 Process `P`：

- `U(P)`：精确 UUID/version 的源 Unit Process，不修改；
- `R(P)`：由已验证 Calculation Bundle 中 `P` 的 LCI/LCIA 结果物化的 Result Process；
- `M(P)`：以 `U(P)` 为 reference process、以直接 provider 的聚合 `R(Q)` 为 background process，并通过 `referenceToResultingProcess` 指向 `R(P)` 的 LifecycleModel。

`M(P)` 必须表达能够重构 `R(P)` 的模型，而不只是保存 `U(P)` 与 `R(P)` 的关联。

## 语义不变量

对于 Calculation Bundle 中 `P` 的有效直接 provider edges，物化结果必须在约定的数值容差内满足：

```text
inventory(R(P))
  ~= direct_inventory(U(P))
     + sum(effective_amount(edge) * inventory(R(provider(edge))))
```

其中 `effective_amount` 由 Calculation Bundle 冻结的 normalized amount、provider weight、allocation、单位换算和符号规则确定。Materialization 不重新求解，也不自行推导这些值。

`R(Q)` 是已经由全局计算求解的 terminal aggregated background。`M(P)` 不递归展开 `M(Q)` 或 `Q` 的完整上游网络，因此供应链中的环不会引发 Model 递归展开。

## 数据集关系

```text
R(Q1) --+
R(Q2) --+--> U(P) contained in M(P) --> R(P)
R(Q3) --+          provider connections   resulting Process
```

LifecycleModel 中的标准关系为：

```text
M(P).quantitativeReference.referenceToReferenceProcess
  -> U(P) process instance

M(P).technology.processes.processInstance[*].referenceToProcess
  -> U(P) or one direct provider R(Q)

provider process instance referencing R(Q).connections.outputExchange.downstreamProcess
  -> the matching input exchange of the U(P) instance

M(P).dataSetInformation.referenceToResultingProcess
  -> exact R(P) UUID/version
```

`R(P)` 是 resulting Process reference，不作为普通 provider process instance 加入 `M(P)`。

## 两类原子动作

### 1. `materialize-result(P)`

这个动作逐条物化 Result Process，可以在 Result identity/version plan 冻结后并行执行。

输入：

- 精确 `U(P)` UUID/version 和 canonical content hash；
- 唯一 quantitative reference、reference exchange 和 reference flow；
- Calculation Bundle 中 `P` 的 directional LCI 和所选 LCIA results；
- Result identity/version、metadata 和 numerical policy。

输出：

- canonical `R(P)`；
- Result descriptor：UUID、version、content hash 和 lineage；
- schema、quantitative reference 和 LCI/LCIA numerical parity evidence。

`U(P)` 提供身份锚点、reference basis 和可继承 metadata；`R(P)` 的数值只来自已验证 Calculation Bundle。

Generated Result identity 使用 `tiangong-result-process-identity.v2`：

```json
{
  "schema": "tiangong-result-process-identity.v2",
  "rootProcessUuid": "<U(P) UUID>",
  "referenceFlowUuid": "<reference flow UUID>",
  "resultProfileId": "lci-lcia-result.v2"
}
```

它使用冻结的 Result namespace 做 UUIDv5。`R(P)` 不再通过 `M(P)` UUID 间接派生，因此 `U(P) -> R(P)` 是独立原子动作；Model profile、数值、任务 ID、source version 和 dataset version 不进入 Result UUID。

### 2. `compose-model(P, finalized-result-catalog)`

这个动作在 Result Catalog 冻结后逐条组合 LifecycleModel。

输入：

- 精确 `U(P)`；
- `P` 的 resolved direct provider edges；
- finalized Result Catalog 中 `R(P)` 与每个 `R(Q)` 的精确 UUID/version/hash；
- Model identity/version 和 metadata policy。

输出：

- canonical `M(P)`；
- Model descriptor；
- graph/reference closure 和 one-hop numerical reconstruction evidence。

虽然 Model 逐条生成，但 provider Result 的身份和版本必须先由范围级编排统一解析，不能在单条动作中查询 mutable `latest`。

## Provider process instance 判定

对 Calculation Bundle 中每一条 direct edge `e`，只有同时满足以下条件，才在 `M(P)` 中创建 provider process instance：

```text
e.consumerProcess == P
and e.consumerInputExchange is resolvable
and e.providerProcess is resolved
and e.providerOutputExchange is resolvable
and e.normalizedAmount is finite and non-zero
and e.providerWeight is finite and positive
and flow/unit/location mapping is compatible
and exact R(e.providerProcess) exists in the finalized Result Catalog
```

首版采用“一条有效 direct edge 对应一个 provider process instance”的规则：

- 同一个 consumer input 由多个 provider 分摊时，每个 provider edge 单独建 instance；
- 同一个 `R(Q)` 服务多个 input exchanges 时，每条 edge 仍使用独立 instance；
- 多个 instance 可以引用同一个 `R(Q)` UUID/version，但必须有不同 internal ID、connection、multiplication factor 和 edge evidence；
- 不在首版合并 instance，避免丢失 exchange、allocation、provider weight 或 scaling 语义。

以下内容不产生 provider process instance：

- elementary-flow exchange；
- 零值或明确被 calculation policy cutoff 的 edge；
- 不属于 `P` 的 direct edge；
- 仅因为某个 Process 也出现在用户选择范围内；
- 没有被 Calculation Bundle 解析为 provider 的猜测关系。

默认 `full-closure` profile 下，未解析 provider、缺失 `R(Q)` 或引用不兼容都会阻塞 `M(P)`；不得静默忽略或自动降级。

## 范围编排

用户选择范围定义需要生成 LifecycleModel 的根集合：

```text
requestedModelRoots = selected P set
```

Result 阶段需要的范围由冻结 direct edges 确定：

```text
requiredResults
  = requestedModelRoots
    union directProviders(requestedModelRoots)
```

依赖扩展只加入直接 provider Result，不递归加入 provider Model。范围计划必须区分：

- `requested`：用户要求生成 `M(P)` 的根 Process；
- `dependency`：仅为了完成 requested Model 而需要物化的 `R(Q)`。

例如用户只选择 `P1`，而其直接 providers 为 `Q1`、`Q2`：

```text
生成 R(P1), R(Q1), R(Q2), M(P1)
不自动生成 M(Q1), M(Q2)
```

`global_eligible` 下，所有合格 Process 通常同时是 requested Model root 和 required Result。

## 两阶段身份和版本解析

一次本地 materialization run 必须按以下顺序收敛：

1. 冻结 Calculation Bundle、requested Model roots、required Result set 和 recipe profiles；
2. 为所有 required Results 派生稳定 identity，并生成 Result drafts/descriptors；
3. 对照 previous manifest 或显式 first-generation policy，统一解析并冻结所有 `R(P)` UUID/version/hash；
4. 生成 finalized Result Catalog；
5. 使用 Catalog 中的精确 `R(Q)` 与 `R(P)` 引用逐条生成 `M(P)` drafts；
6. 解析并冻结 Model version set，重新渲染精确 references；
7. 验证版本集合、内容 hash 和引用收敛后，冻结本地 materialization manifest。

Identity 不使用随机 UUID；version 解析不查询 mutable `latest`；相同 dataset identity/version 不得对应不同 canonical content。

## 本地产物

```text
materialization-runs/<run-id>/
├── materialization-request.json
├── selection.json
├── identity-plan.json
├── version-plan.json
├── result-catalog.json
├── items/
│   └── <root-process-id>/
│       ├── result-process.json
│       ├── lifecycle-model.json
│       ├── item-manifest.json
│       └── validation-report.json
├── dependencies/
│   └── <provider-process-id>/
│       ├── result-process.json
│       ├── result-manifest.json
│       └── validation-report.json
├── canonical-datasets/
├── dataset-index.json
├── materialization-manifest.json
└── materialization-report.json
```

实现可以使用内容寻址存储去重重复的 Result Process bytes；manifest 中仍需保留 requested/dependency role 和精确 lineage。

## 完成条件

一个 run 只有在以下条件全部满足后才能交给 Release Workflow：

- 每个 `R(P)` 通过 TIDAS schema、quantitative reference 和 LCI/LCIA parity 验证；
- 每个 `M(P)` 的 root、provider、connection、factor 和 resulting Process 引用都能解析到精确数据集；
- 每条有效 direct edge 与 Model provider instance 一一对应；
- one-hop 重构库存与对应 `R(P)` 在冻结容差内一致；
- requested/dependency scope、Result Catalog、identity/version 和 canonical hashes 已冻结；
- 相同输入和 recipe 重放得到相同 canonical content；
- 没有未解析 provider、动态 latest、半成品 item 或 identity/version 内容冲突。

Release Workflow 只消费这些冻结文件。它可以验证、打包、上传、审批、发布和回读，但不得在该阶段修改 Result Process、LifecycleModel、identity、version 或 connection。
