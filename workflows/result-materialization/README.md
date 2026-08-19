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
lastReviewedCommit: 5125fd8b6a1679f25b29032127e41d82bf063002
lastReviewedNote: "Confirmed one public scope/output/result-layer request over internal Result/Model convergence."
related:
  - AGENTS.md
  - design/resolved-one-hop-materialization.md
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
M(P)
├── reference process instance -> U(P)
├── direct provider instance   -> R(Q1)
├── direct provider instance   -> R(Q2)
└── referenceToResultingProcess -> R(P)
```

- 源 Unit Process 不因计算或 materialization 而改变。
- LifecycleModel 和 Result Process 使用独立 UUID lineage 和 dataset version。
- LifecycleModel 必须引用同一次 materialization 中的精确 Result Process identity/version。
- 首版 LifecycleModel 使用 `resolved-one-hop-aggregated-background.v1` profile：根 instance 引用 `U(P)`，每条有效 direct provider edge 的 instance 引用对应聚合 `R(Q)`。
- `R(Q)` 是 terminal aggregated background；Model 不递归展开 provider 的 LifecycleModel 或完整上游网络。
- LCI 是 Result Process 的基础结果层。
- LCIA 默认作为同一 Result Process 上的可选结果层，不单独制造只有 LCIA、没有 LCI 的 Process。
- 如果未来标准或消费者确实要求独立 LCIA Process，再增加经过验证的 recipe。

完整的单条、范围、provider instance 和验证规则见 [Resolved One-hop Result Materialization](design/resolved-one-hop-materialization.md)。

## Recipe，而不是多个顶层 Workflow

用户先选择范围，再选择最终对象和结果层。它们高度共享身份、版本、引用和验证，因此属于同一 Workflow 下的 recipe：

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
   - 首版使用 `resolved-one-hop-aggregated-background.v1` 组合 profile；
   - 将根 `U(P)`、direct provider `R(Q)`、connections、multiplication factors 和 resulting `R(P)` 精确绑定。

稳定的请求维度是：

1. `scope`：单条、指定一批或全部 eligible Process，显式选择使用 `UUID@version`；
2. `outputType`：`result-process` 或 `lifecycle-model`；
3. `resultLayer`：`lci` 或 `lci-lcia`，不支持 LCIA-only。

`result-process` 对每个 root 只生成一个主要 `R(P)`，不扩展 provider。`lifecycle-model` 对每个 root 生成一个主要 `M(P)`，并在内部生成 resulting `R(P)` 和 direct provider dependency `R(Q)`。这些依赖不会计入主要对象数量。身份与版本集合必须在一次 materialization 中共同求解，不能各自生成后再猜测引用。

## 主路线

```text
读取并验证冻结输入
  -> 冻结 scope + outputType + resultLayer
  -> 仅在 lifecycle-model 模式从 direct edges 派生 required Result set
  -> 确认 metadata completion policy
  -> 派生稳定 identity lineage并读取上一版 manifest
  -> 逐条生成 required R(P) drafts
  -> 求解并冻结 Result version set / Result Catalog
  -> 使用精确 R(Q)/R(P) references 逐条生成 M(P)
  -> 求解 Model version set并渲染精确 references
  -> 生成 canonical dataset collection
  -> schema / reference / LCI-LCIA parity / one-hop reconstruction validation
  -> Materialization Manifest + Dataset Index
```

## 当前可执行入口

第一阶段已经提供 workflow-local 薄 CLI，不增加 `tiangong-release` 顶层命令：

```bash
cd workflows/result-materialization
npm install

# 一次性导入本地 Calculation Bundle；支持 evidence ZIP 或解压目录
node cli.mjs intake \
  --bundle /path/to/calculation-evidence-bundle.zip \
  --out-dir /path/to/intakes/<bundle-content-hash> \
  --json

# 生成指定 root 的 LCI + LCIA Result Process
node cli.mjs materialize \
  --intake /path/to/intakes/<bundle-content-hash> \
  --processes <UUID@VERSION> \
  --output-type result-process \
  --result-layer lci-lcia \
  --out-dir /path/to/materialized/result-process \
  --first-generation \
  --json

# 一次完成依赖规划、Result Catalog 和 resolved one-hop LifecycleModel
node cli.mjs materialize \
  --intake /path/to/intakes/<bundle-content-hash> \
  --processes <UUID@VERSION> \
  --output-type lifecycle-model \
  --result-layer lci-lcia \
  --out-dir /path/to/materialized/lifecycle-model \
  --first-generation \
  --json
```

`intake` 会验证 Calculation Bundle manifest、每个压缩 artifact 的 hash/size，以及 gzip 解压后的 hash/size/record count，再原子地冻结为 Release 自有的 `materialization-intake.v1`。Worker v2 的 `bundleContentHash` 基于原始 canonical manifest bytes（移除顶层 hash 字段）验证，不能先解析为 JavaScript number 再序列化，否则大整数会发生精度变化并产生假 mismatch。输出目录存在时拒绝覆盖。

`materialize` 冻结 `materialization-request.json`，并根据最终对象选择内部路线。Result-only 路线只生成 selected `R(P)`；LifecycleModel 路线自动完成 direct provider 扩展、Result Catalog 冻结和 `M(P)` 生成。`R(P)` 的 UUIDv5 name 只包含 `U(P) UUID + reference flow UUID`，其他变化由 profile、semantic hash、dataset version 和 provenance 表达。

生成命令必须二选一提供 `--first-generation` 或 `--previous-manifest <path>`。相同 semantic hash 与 version-significant hash 复用版本；语义变化升 major；仅 metadata 等公开内容变化升 minor；同一 UUID/version 出现不同 canonical content时 fail closed。同一次请求中多个 exact axes 解析到同一 Result lineage 时也会在写出产物前 fail closed，并要求先解决 calculation graph 的精确 source version；不会再按 UUID 静默去重。整个过程不会查询数据库，也不会上传或发布。

CLI 的 `--json` 输出保持有界，包含 completeness、产物路径和下一条可复制命令；大数据集始终写入文件。

## 需要用户决定的内容

- 选择处理范围；
- 选择最终对象 `result-process` 或 `lifecycle-model`；
- 是否显式选择未来新增、已经过验证的非默认模型组织 profile；
- 输出 LCI-only 还是 LCI + LCIA；
- 需要使用的上一版 Release Manifest；
- 无法从输入确定的名称、描述、分类、地理、时间、技术和来源字段；
- metadata 冲突时继承、声明或阻塞。

## 主要产物

```text
materialization-request.json
selection.json
identity-plan.json
version-plan.json
result-catalog.json
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
- 每条有效 direct provider edge 与 LifecycleModel provider instance 一一对应；
- Unit、Flow、direction 和 location 映射正确；
- Calculation Bundle 到 Result Process 的 LCI/LCIA 数值一致；
- one-hop Model 重构库存与对应 Result Process 数值一致；
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

## 后续增强点

1. 使用真实完整 Calculation Bundle 做大范围 replay、性能和内存基准。
2. 根据真实 replay 继续验证 LCI-only 与 LCI + LCIA 的 lineage/version policy。
3. 增加 metadata completion decision artifact，而不是对无法继承的字段做隐式猜测。
4. 把完成的 `materialization-manifest.json` 接入 Release Workflow 的打包与发布入口。
