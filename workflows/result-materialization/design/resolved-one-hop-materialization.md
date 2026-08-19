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
lastReviewedAt: 2026-08-19
lastReviewedCommit: 5125fd8b6a1679f25b29032127e41d82bf063002
lastReviewedNote: "Defined exact source-version Result variants and quantitative-reference pivot preservation."
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

## 一个公开动作与两个内部生成节点

用户只调用一次 `materialize`，并在请求中依次冻结：

1. `scope`：一条、指定一批或 `all_eligible`；
2. `outputType`：`result-process` 或 `lifecycle-model`；
3. `resultLayer`：`lci` 或 `lci-lcia`。

`materialize-result` 与 `compose-model` 是同一次请求内部的确定性生成节点，不是需要用户手动串联的 CLI，也不是两个独立 Workflow。内部执行图由 `outputType` 决定：

```text
outputType = result-process
  requested roots -> materialize-result -> primary R(P)

outputType = lifecycle-model
  requested roots
    -> expand direct-provider Result dependencies
    -> materialize-result for resulting R(P) and dependency R(Q)
    -> freeze Result Catalog
    -> compose-model
    -> primary M(P)
```

因此选择 `lifecycle-model` 时，最终主要对象只有每个 requested root 对应的 `M(P)`；内部生成的 `R(P)` 是 resulting dataset，`R(Q)` 是 dependency dataset，不应被解释为用户另外请求了一批主要 Result Process。

### 内部节点 1：`materialize-result(P)`

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

`U(P)` 提供身份锚点、reference basis 和可继承 metadata；`R(P)` 的数值只来自已验证 Calculation Bundle。Result-only 模式只对 requested roots 执行；LifecycleModel 模式则对 requested roots 与其 direct providers 的并集执行。

Generated Result UUIDv5 name 只包含业务身份：

```json
{
  "rootProcessUuid": "<U(P) UUID>",
  "referenceFlowUuid": "<reference flow UUID>"
}
```

它使用冻结的 Result namespace 做 UUIDv5。name 中不放 `schema` 或 identity contract version，避免纯协议升级改变业务 lineage。`R(P)` 不再通过 `M(P)` UUID 间接派生，因此 `U(P) -> R(P)` 是内部独立的身份与内容生成节点，但仍由同一个公开 `materialize` 动作编排；Result/Model profile、LCI/LCIA 与方法集、任务 ID、source version 和 dataset version 都不进入 Result UUID。这些变化通过 dataset profile、semantic/version-significant hash、dataset version 和 provenance 表达。

算法证据保存在 Result descriptor 外层，不参与 UUID name：

```json
{
  "algorithm": "uuidv5",
  "namespace": "6d130f3d-ca65-5a6f-a842-4b2f9c2f5461",
  "name": {
    "rootProcessUuid": "<U(P) UUID>",
    "referenceFlowUuid": "<reference flow UUID>"
  }
}
```

如果未来必须让不同 system boundary 的 Result lineage 同时存在，应增加语义明确且有证据的 boundary identity 字段，并为改变后的 name contract 冻结新 namespace；不得使用泛化的 `resultProfileId` 把 recipe 或输出形态误当成业务身份。

#### 同一 Result lineage 的多个 exact source revisions

`source Process version` 不进入 Result UUID，因此同一个 `U(P) UUID + reference Flow UUID` 可以在一次计算中对应多个 exact source revisions。它们属于同一个业务 lineage，但不能折叠成一个数据集：

- Result UUID 保持相同；
- 每个 exact `sourceProcess UUID@version` 生成独立的 Result dataset version；
- Result Catalog 同时保留这些 descriptor，并用 `processIndex + sourceProcess + Result UUID@version` 精确对应 calculation axis；
- `M(P)` 与 provider instance 只引用其 calculation axis 对应的精确 Result version，不读取 mutable `latest`；
- previous manifest 先按 exact `sourceProcess UUID@version` 匹配已有 Result variant；相同内容复用版本，metadata 变化升 minor，语义变化升 major；
- first generation 或新增 source revision 按 source identity/version 的确定性顺序分配尚未占用的 major version，从 `01.00.000` 开始；同一 lineage 内不得出现重复 dataset version。

这个规则把“稳定业务身份”和“精确 source revision”分别放在 UUID lineage 与 dataset version/provenance 中表达。

#### Quantitative-reference pivot

Result Materialization 必须保持 Worker 求解时使用的 signed normalization pivot，而不是假设 quantitative reference 总是 Output。每个 v2 process axis 提供：

```text
rawDirection
rawMeanAmount
signedRawCoefficient = directionSign * rawMeanAmount
normalizationScale = 1 / abs(signedRawCoefficient)
normalizedCoefficient = sign(signedRawCoefficient)
normalizedMeanAmount = rawMeanAmount * normalizationScale
```

生成 `R(P)` 时，reference exchange 保留 `rawDirection`，amount 使用 `normalizedMeanAmount`；生成 `M(P)` 时，根 `U(P)` process instance 的 multiplication factor 使用 `normalizationScale`。这样 Input/Output 与正负 amount 都沿用计算时语义，Result 和 Model 不会因统一改写为 Output 而失真。

新 Bundle 以 `calculation_bundle_process_axis.v2` 作为 pivot 证据。旧 Bundle 缺少 pivot 时，只允许从 intake 已下载并校验 hash 的 exact source-closure Process 中读取同一个 reference exchange，计算上述字段，并在 descriptor 中记录 `exact_source_closure_legacy_fallback.v1`；这个兼容路径不查询数据库，也不接受其他 source revision 或 mutable current state。

### 内部节点 2：`compose-model(P, finalized-result-catalog)`

这个节点只在 `outputType = lifecycle-model` 时运行，并在 Result Catalog 冻结后为每个 requested root 逐条组合 LifecycleModel。它不会为 provider roots 自动生成 `M(Q)`。

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
and e.activityRequirement is finite and non-zero
and e.residualCoefficient/referenceCoefficient/routingWeight evidence is present
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

在 `resolved-one-hop-aggregated-background.v1` profile 下，Calculation Bundle 已保留的有效 edge 若缺失 `R(Q)`、balancing reference 或引用不兼容，都会阻塞 `M(P)`；不得静默忽略或自动降级。

## 范围编排

请求首先冻结 `scope + outputType + resultLayer`。用户选择范围定义 requested roots：

```text
requestedRoots = selected P set
```

当 `outputType = result-process`：

```text
primaryResults = requestedRoots
requiredResults = requestedRoots
```

当 `outputType = lifecycle-model`，Result 阶段需要的范围才由冻结 direct edges 扩展：

```text
requiredResults
  = requestedRoots
    union directProviders(requestedRoots)
```

依赖扩展只加入直接 provider Result，不递归加入 provider Model。范围计划必须区分：

- `primary`：用户要求的 `R(P)` 或 `M(P)`；
- `resulting`：仅在 Model recipe 中由 `M(P)` 指向的 `R(P)`；
- `dependency`：仅为了完成 requested Model 而需要物化的 `R(Q)`。

例如用户只选择 `P1`，而其直接 providers 为 `Q1`、`Q2`：

```text
主要产物 M(P1)
resulting 依赖 R(P1)
provider 依赖 R(Q1), R(Q2)
不自动生成 M(Q1), M(Q2)
```

`global_eligible` 下，Result-only recipe 把所有合格 Process 作为 primary Results；LifecycleModel recipe 把它们作为 requested Model roots，并按 direct edges 扩展 required Results。

## 内部两阶段身份和版本收敛

一次本地 materialization run 必须按以下顺序收敛：

1. 冻结 Calculation Bundle、requested roots、output type、result layer、required Result set 和 recipe profiles；
2. 为所有 required Results 派生稳定 identity，并生成 Result drafts/descriptors；
3. 对照 previous manifest 或显式 first-generation policy，统一解析并冻结所有 `R(P)` UUID/version/hash；
4. 生成 finalized Result Catalog；
5. 使用 Catalog 中的精确 `R(Q)` 与 `R(P)` 引用逐条生成 `M(P)` drafts；
6. 解析并冻结 Model version set，重新渲染精确 references；
7. 验证版本集合、内容 hash 和引用收敛后，冻结本地 materialization manifest。

Identity 不使用随机 UUID；version 解析不查询 mutable `latest`；相同 dataset identity/version 不得对应不同 canonical content。

如果多个 exact calculation axes 解析到同一个 Result UUID lineage，范围规划按 exact source revision 生成多个 dataset versions，并把每个 process index 固定到对应版本。只有同一个 exact source revision 重复出现、版本分配碰撞或同一 UUID/version 对应不同 canonical content 时才 fail closed。

## 当前本地产物

```text
<out-dir>/
├── materialization-request.json
├── result-catalog.json
├── model-catalog.json                 # lifecycle-model 模式
├── canonical-datasets/
│   ├── processes/
│   │   └── <result-uuid>_<version>.json
│   └── lifecyclemodels/               # lifecycle-model 模式
│       └── <model-uuid>_<version>.json
├── materialization-manifest.json
└── materialization-report.json
```

`materialization-request.json` 是 scope/outputType/resultLayer 的冻结请求；Catalog 和 Manifest 共同承担早期规划中 selection、identity plan、version plan 与 dataset index 的职责，当前实现不再额外生成这些重复文件。每个 descriptor 必须保留 `primary`、`resulting` 或 `dependency` role、process index、exact source revision、UUID/version 与 hashes。

## 完成条件

一个 run 只有在以下条件全部满足后才能交给 Release Workflow：

- 每个 `R(P)` 通过 TIDAS schema、quantitative reference 和 LCI/LCIA parity 验证；
- 每个 `M(P)` 的 root、provider、connection、factor 和 resulting Process 引用都能解析到精确数据集；
- 每条有效 direct edge 与 Model provider instance 一一对应；
- one-hop 重构库存与对应 `R(P)` 在冻结容差内一致；
- requested/resulting/dependency scope、Result Catalog、identity/version 和 canonical hashes 已冻结；
- 相同输入和 recipe 重放得到相同 canonical content；
- 没有未解析 provider、动态 latest、半成品 item 或 identity/version 内容冲突。

Release Workflow 只消费这些冻结文件。它可以验证、打包、上传、审批、发布和回读，但不得在该阶段修改 Result Process、LifecycleModel、identity、version 或 connection。
