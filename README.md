---
title: TianGong LCA Release 项目说明
docType: guide
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要理解 Release 项目的当前目标、Workflow 边界和确认状态时
  - 当需要决定一项工作属于 Calculation、Result Materialization、Release Candidate、Dataset Transformation 还是 Publication 时
  - 当准备实现、运行或审查任一 Workflow 时
whenToUpdate:
  - 当项目目标、Workflow 划分、跨 Workflow 关系或确认结论变化时
  - 当新增、删除或重新定义根目录 workflows 子目录时
checkPaths:
  - README.md
  - AGENTS.md
  - docs/architecture.md
  - workflows/**
  - .docpact/config.yaml
lastReviewedAt: 2026-08-25
lastReviewedCommit: ae317c02e73e9e3d14e6aa5e8aa4685b80d1cb8a
lastReviewedNote: "Separated immutable Release Candidate construction from future authorized Publication and positioned Dataset Transformation as an optional Candidate refinement loop."
related:
  - AGENTS.md
  - docs/architecture.md
  - workflows/README.md
---

# TianGong LCA Release

`tiangong-lca-release` 是一个面向人和 Agent 的本地数据产品工作台。它组织计算、标准数据集生成、Candidate 构建、可选再加工和正式发布，同时保存每一步使用的精确输入、用户决定、验证证据、输出产物和恢复入口。

这个项目不是前端、计算引擎或数据库服务。它调用其他系统已经提供的能力，但不修改其他仓库，也不从 mutable `latest` 猜测 identity、version、graph 或 method。

## 当前 Workflow 结构

```text
workflows/
├── calculation/
├── result-materialization/
├── release-candidate/
├── dataset-transformation/
└── publication/
```

当前默认主线是：

```text
Calculation
  -> Result Materialization
  -> Release Candidate
```

Release Candidate 完成后提供三个明确选择：

```text
Release Candidate
  ├─ direct publish -> Publication
  ├─ scope refinement -> dependency impact -> new Candidate -> Publication
  └─ data refinement -> Dataset Transformation -> new Candidate
```

Candidate、范围决定和变换产物都不可原地改写。任何改变 Candidate 内容的动作必须产生新 Candidate，并绑定父 Candidate 与决定或变换证据。

## 1. Calculation Workflow

Calculation 负责从计算意图或已有远程资源继续工作，直到所需 Calculation Bundle 已可靠下载到本地。

它负责：

- 创建或接入 ResultSet；
- 确认 scope 和 LCIA 方法集；
- 启动、跟踪 Closure Check 和计算任务；
- 展示报告、阻塞项和可恢复动作；
- 下载并校验 Calculation Bundle；
- 绑定远程资源 identity 与本地产物证据。

完整性验证属于 Calculation 内部的可恢复节点，不是独立顶层 Workflow。

详见 [Calculation Workflow](workflows/calculation/README.md)。

## 2. Result Materialization Workflow

Result Materialization 负责把 Calculation Bundle 或其他已经冻结并验证的结果，确定性地组装为标准 LCA 数据集。

它负责：

- 冻结 scope、最终对象和 Result Process 内容层；
- 生成 LCI 或 LCI + LCIA Result Process；
- 生成引用精确 Result Process 的 resolved one-hop LifecycleModel；
- 求解并冻结 identity/version；
- 验证 TIDAS schema、引用闭合、数值一致性和 Model 重构；
- 输出 canonical dataset collection、dataset index 和 materialization manifest。

LCI Result Process、LCI + LCIA Result Process 和 LifecycleModel 是本 Workflow 下的 recipe，不是额外顶层 Workflow。

详见 [Result Materialization Workflow](workflows/result-materialization/README.md)。

## 3. Release Candidate Workflow

Release Candidate 负责把已经 materialize 并验证的数据组织为不可变、可审查、尚未授权发布的 Candidate。

它负责：

- 从冻结上游准备 Release Intake；
- 补齐独立分发所需的精确支持数据；
- 冻结 Package Plan；
- 执行 TIDAS/eILCD 验证、转换、语义 round-trip 和确定性打包；
- 对失败构建生成完整影响报告和人工审核视图；
- 将范围排除绑定到精确影响报告 hash；
- 通过新的 Package Plan 重跑全部验证；
- 冻结 `publicationAuthorized=false` 的 Release Candidate。

Packaging 和 Candidate qualification 都属于本 Workflow。生成 ZIP 不等于 Candidate 已通过资格验证，Candidate 构建成功也不等于已经获得发布授权。

Candidate 完成后必须展示三个后续方向：

1. 原 Candidate 直接进入 Publication；
2. 选择依赖闭合的子范围，生成并验证新的 Candidate；
3. 选择精确 Candidate 数据进入 Dataset Transformation，再生成新 Candidate。

按 Unit Process、Result 或 Both 选择已经独立闭合的 Candidate component，可以留到 Publication Plan；任何 dataset-level 的排除都会改变内容和 hash，必须先回到本 Workflow 生成新 Candidate。

详见 [Release Candidate Workflow](workflows/release-candidate/README.md)。

## 4. Dataset Transformation Workflow

Dataset Transformation 是 Candidate 完成后的可选再加工入口。它消费 Candidate 中精确选择且经过 hash 验证的数据，产生带完整父 Candidate 与变换血缘的新数据，再进入 Candidate 构建。

当前只确认以下边界：

- 不原地修改 Candidate；
- 输入必须绑定父 Candidate hash 和精确 dataset identity/version/hash；
- 加工规则必须在后续设计中先形成可审查草案，再冻结为确定性规格；
- 输出必须经过必要验证并生成新 Candidate；
- 如果变换使原计算结果失效，必须返回 Calculation/Result Materialization，不能复用旧 Result evidence。

具体支持的修改、聚合规则、字段策略、验证和执行入口尚未设计，本阶段不预设。

详见 [Dataset Transformation Workflow](workflows/dataset-transformation/README.md)。

## 5. Publication Workflow

Publication 负责消费不可变 Release Candidate，在精确选择和授权后改变 TianGong LCA 平台上的发布状态，并独立确认终态。

当前确认的发布方向是：

- 用户选择发布 Unit Process、Result 或 Both；
- 平台已存在精确 UUID + Version 的数据时，发布动作改变其生命周期状态；
- 平台不存在该主键时，发布动作写入精确 Candidate 数据并进入发布态；
- 发布计划必须区分用户选择的 roots 与保证引用完整性所需的有效发布集合；
- 精确状态码、事务、写入 adapter、审批 artifact 和恢复规则留待后续设计。

Publication 不得在执行阶段临时修改 Candidate 内容、删除数据集或补猜依赖。内容变化必须先返回 Release Candidate 或 Dataset Transformation 生成新 Candidate。

详见 [Publication Workflow](workflows/publication/README.md)。

## Candidate 的三条后续路径

### 直接发布

Publication 以原 Candidate 为不可变输入。用户仍需确认发布类型、精确 target 和后续定义的 Publish Plan。

### 选择性发布

如果只选择已经独立闭合的 Candidate component，Publication Plan 可以选择该 component。如果选择或剔除包内具体数据集，则必须：

```text
Candidate
  -> scope selection
  -> dependency and reverse-impact analysis
  -> scope decision
  -> new Package Plan
  -> full validation
  -> new Candidate
```

剔除集合必须包含所有因此失去完整性的关联数据。原 Candidate、失败构建和上游 materialization 均保持不变。

### 再加工

Dataset Transformation 只能读取并验证 Candidate 数据，不能覆盖它。加工完成后根据结果有效性返回 Release Candidate，或返回 Calculation/Result Materialization 重新产生结果证据。

## 共享边界

- Workflow 可以从已有精确资源或 artifact 继续，不要求从第一步重跑。
- 远程副作用、耗时计算、Candidate 范围、变换语义和正式发布都需要明确用户决定。
- 数值计算、格式验证、hash 和打包必须由确定性实现完成，不能由语言模型直接生成。
- 大型 artifacts 写入文件或对象存储，stdout 只返回有界摘要和引用。
- 其他系统能力不存在时报告 `capability_unavailable`，不扩大修改范围。
- Candidate 构建与 Publication 是不同权限边界；本地验证成功不能替代远程发布授权或独立回读。

## 当前实施状态

- Calculation 已实现 workflow-local ResultSet、Closure、计算任务、Bundle 数据面和 Worker 日志委托入口。
- Result Materialization 已实现 intake、Result Process/LifecycleModel 生成、验证和本地后台 Job。
- Release Candidate 已实现 Elementary Flow cache、Release Intake、Package build、失败影响分析、人工审核工作簿、scope decision 和 Candidate qualification。
- Dataset Transformation 当前只有高层边界，没有已确认的加工规则或执行入口。
- Publication 当前只有高层边界，没有已确认的状态码、写入契约或执行入口。
