---
title: Result Materialization Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要把 Calculation Bundle 或派生结果组装成标准 Process、LifecycleModel 和 canonical dataset collection 时
whenToUpdate:
  - 当 materialization recipe、身份版本、数据集关系、验证或输出变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Added the confirmed Result Materialization workflow between calculation/transformation outputs and release packaging."
related:
  - AGENTS.md
  - ../../README.md
---

# Result Materialization Workflow

## 目标

把 Calculation Bundle 或经过确认的派生结果，确定性地组装为符合标准、具有稳定身份和版本、内部引用一致的 LCA 数据集集合。

这个 Workflow 解决的是“数值和图证据如何成为 Process/LifecycleModel”，不是重新计算，也不是打包发布。

## 可以从哪里开始

- Calculation Workflow 下载并验证的 Calculation Bundle；
- Dataset Transformation Workflow 生成的 Derived Result；
- 已冻结的 source closure、graph evidence 和 result arrays；
- 已有 Materialization Request、Identity Plan、Version Plan 或部分生成结果；
- 已完成 materialization、但需要针对新 recipe 或上一版 manifest 重新生成的 dataset collection。

## 为什么是独立 Workflow

它拥有与 Calculation、Transformation、Release 不同的输入、决定、产物和验证：

- Calculation 产生数值、图证据和 Calculation Bundle；
- Transformation 改变模型或结果的业务语义；
- Result Materialization 把冻结语义投影为标准数据集；
- Release 消费已经 materialize 的数据集，负责打包和发布。

Materialization 失败时，可以修复 recipe、字段或引用并重新生成，不需要重新计算或进入远程发布。

## 数据集关系

```text
源 Unit Process
      |
      +-------------------+
      |                   |
      v                   v
LifecycleModel       Result Process
模型结构              quantitative reference
组件与权重            聚合 LCI exchanges
provider 关系         可选 LCIAResults
      |                   ^
      +-------------------+
       referenceToResultingProcess
```

- 源 Unit Process 不因计算或 materialization 而改变。
- LifecycleModel 和 Result Process 使用独立 UUID lineage 和 dataset version。
- LifecycleModel 必须引用同一次 materialization 中的精确 Result Process identity/version。
- LCI 是 Result Process 的基础结果层。
- LCIA 默认作为同一 Result Process 上的可选结果层，不单独制造只有 LCIA、没有 LCI 的 Process。
- 如果未来标准或消费者确实要求独立 LCIA Process，再增加经过验证的 recipe。

## Recipe，而不是多个顶层 Workflow

LCI Result Process、LCI + LCIA Result Process 和 LifecycleModel 高度共享身份、版本、引用和验证，因此属于同一 Workflow 下的 recipe：

1. `lci-result-process`
   - 生成 quantitative reference 和聚合 LCI exchanges；
   - 不包含 LCIAResults；
   - 可作为不需要模型文档的独立结果数据集。
2. `lci-lcia-result-process`
   - 包含完整 LCI；
   - 增加绑定精确方法 ID/version 的 LCIAResults；
   - 方法集变化必须进入版本和 provenance 判断。
3. `lifecycle-model-with-result`
   - 生成 LifecycleModel；
   - 同时选择 LCI-only 或 LCI + LCIA Result Process；
   - 将模型组件、权重、provider 关系和 resulting Process 精确绑定。

Recipe 可以单独选择，但身份与版本集合必须在一次 materialization 中共同求解，不能各自生成后再猜测引用。

## 主路线

```text
读取并验证冻结输入
  -> 选择 Materialization Recipe
  -> 确认模型组织和 metadata completion policy
  -> 派生稳定 identity lineage
  -> 读取上一版 manifest
  -> 求解 dataset version set
  -> 生成 Result Process
  -> 按 recipe 生成 LifecycleModel
  -> 渲染精确 identity/version references
  -> 生成 canonical dataset collection
  -> schema / reference / numerical parity validation
  -> Materialization Manifest + Dataset Index
```

## 需要用户决定的内容

- 选择哪个 materialization recipe；
- 是否需要 LifecycleModel；
- LifecycleModel 的组织 recipe，例如 one-hop 或未来其他模型结构；
- 输出 LCI-only 还是 LCI + LCIA；
- 需要使用的上一版 Release Manifest；
- 无法从输入确定的名称、描述、分类、地理、时间、技术和来源字段；
- metadata 冲突时继承、声明或阻塞。

## 主要产物

```text
materialization-request.json
identity-plan.json
version-plan.json
canonical-datasets/
dataset-index.json
materialization-manifest.json
materialization-report.json
```

Materialization Manifest 至少绑定：

- 输入 Calculation Bundle 或 Derived Result hash；
- source closure 和 graph evidence；
- recipe ID/version；
- identity、version 和 metadata policy；
- 每个输出数据集的 role、UUID、version、hash 和来源；
- validator 版本和验证结果。

## 必须通过的验证

- TIDAS schema 和 canonical JSON；
- quantitative reference 唯一且完整；
- source Process、LifecycleModel、Result Process identity/version 一致；
- LifecycleModel resulting Process 引用闭合；
- Unit、Flow、direction 和 location 映射正确；
- Calculation Bundle 到 Result Process 的 LCI/LCIA 数值一致；
- 相同输入和 recipe 重放得到相同内容；
- 同一 dataset identity/version 不对应冲突内容；
- 版本集合能够收敛。

## 不属于本 Workflow

- Worker 求解和 Calculation Bundle 生产；
- 用户加权组合等业务语义变换；
- ZIP/分发包构建；
- 人工发布审批和远程写入；
- 把生成数据自动写回 authoring tables。

后两类分别属于 Release Workflow；业务语义变换属于 Dataset Transformation Workflow。

## 待确认点

1. 首版是否只支持上面三个 recipe？
2. LifecycleModel 首版是否保留 one-hop recipe，但不再作为全局默认？
3. LCI-only 与 LCI + LCIA 是否使用不同 Result Process lineage，还是同 lineage 下通过 semantic change 升版？
4. Materialization 是否总是要求上一版 Release Manifest，还是首次生成允许显式 `none`？
