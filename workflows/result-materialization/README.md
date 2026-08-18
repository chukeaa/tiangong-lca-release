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
lastReviewedNote: "Confirmed local two-phase Result Process materialization and resolved one-hop LifecycleModel composition."
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
   - 首版使用 `resolved-one-hop-aggregated-background.v1` 组合 profile；
   - 将根 `U(P)`、direct provider `R(Q)`、connections、multiplication factors 和 resulting `R(P)` 精确绑定。

Recipe 可以单独选择，但身份与版本集合必须在一次 materialization 中共同求解，不能各自生成后再猜测引用。

## 主路线

```text
读取并验证冻结输入
  -> 选择 Model root 范围和 Materialization Recipe
  -> 从 direct edges 派生 required Result set
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

# 为全部 root 生成 required R(P)/R(Q) 并冻结 Result Catalog
node cli.mjs materialize-results \
  --intake /path/to/intakes/<bundle-content-hash> \
  --all \
  --out-dir /path/to/materialized/results \
  --first-generation \
  --json

# 只选择部分 root 时使用：--processes <UUID1>,<UUID2>

# 使用冻结 Catalog 生成 resolved one-hop M(P)
node cli.mjs materialize-models \
  --intake /path/to/intakes/<bundle-content-hash> \
  --result-catalog /path/to/materialized/results/result-catalog.json \
  --all-selected \
  --out-dir /path/to/materialized/models \
  --first-generation \
  --json
```

`intake` 会验证 Calculation Bundle manifest、每个压缩 artifact 的 hash/size，以及 gzip 解压后的 hash/size/record count，再原子地冻结为 Release 自有的 `materialization-intake.v1`。Worker v2 的 `bundleContentHash` 基于原始 canonical manifest bytes（移除顶层 hash 字段）验证，不能先解析为 JavaScript number 再序列化，否则大整数会发生精度变化并产生假 mismatch。输出目录存在时拒绝覆盖。

`materialize-results` 接受显式 root 范围，并自动把每个 root 的 direct provider `Q` 纳入 required Result set。`R(P)` 的 UUIDv5 name 只包含 `U(P) UUID + reference flow UUID`，不包含 schema/version 字段；Result profile、LCI/LCIA 数值、方法集、计算任务、source version 和生成时间也都不进入 UUID，而通过外层 identity evidence、profile、semantic hash、dataset version 和 provenance 表达。命令先解析整个 Result version set，再冻结 `result-catalog.json`。

`materialize-models` 只读取同一 intake 和已冻结 Result Catalog，以精确 `R(P)@version` / `R(Q)@version` 生成 `resolved-one-hop-aggregated-background.v1` 的 `M(P)`。每条 direct provider edge 产生一个 provider process instance，并执行 TIDAS schema、Catalog dataset hash 和 one-hop inventory reconstruction 校验。

两个生成命令必须二选一提供 `--first-generation` 或 `--previous-manifest <path>`。相同 semantic hash 与 version-significant hash 复用版本；语义变化升 major；仅 metadata 等公开内容变化升 minor；同一 UUID/version 出现不同 canonical content 时 fail closed。整个过程不会查询数据库，也不会上传或发布。

CLI 的 `--json` 输出保持有界，包含 completeness、产物路径和下一条可复制命令；大数据集始终写入文件。

## 需要用户决定的内容

- 选择哪个 materialization recipe；
- 是否需要 LifecycleModel；
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
2. 明确 LCI-only 与 LCI + LCIA 的 lineage/version policy 后，再开放对应 recipe 选项。
3. 增加 metadata completion decision artifact，而不是对无法继承的字段做隐式猜测。
4. 把完成的 `materialization-manifest.json` 接入 Release Workflow 的打包与发布入口。
