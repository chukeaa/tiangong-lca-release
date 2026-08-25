---
title: Release Workflow Architecture
docType: architecture
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要理解根 Workflow、外部系统、产物血缘和执行实现之间的关系时
  - 当决定新文件、契约或代码属于哪个 Workflow 时
whenToUpdate:
  - 当 Workflow 拓扑、外部能力边界、artifact authority 或运行结构变化时
checkPaths:
  - docs/architecture.md
  - AGENTS.md
  - README.md
  - .docpact/config.yaml
  - workflows/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: ae317c02e73e9e3d14e6aa5e8aa4685b80d1cb8a
lastReviewedNote: "Separated immutable Candidate construction from future Publication and added Candidate-derived scope and transformation loops."
related:
  - ../AGENTS.md
  - ../README.md
  - ../workflows/README.md
---

# Architecture

## 架构单位

本项目的主要架构单位是根目录 Workflow，而不是跨项目 stage machine，也不是 `src/` 中的模块目录。

```text
Repository
├── README.md
├── AGENTS.md
├── workflows/
│   ├── calculation/
│   ├── result-materialization/
│   ├── release-candidate/
│   ├── dataset-transformation/
│   └── publication/
├── docs/
├── package.json
└── .github/workflows/
```

一个 Workflow 可以在自己的目录下包含说明、Agent 契约、模板、schemas、fixtures、验证器和代码。不是所有 Workflow 都需要相同子目录，也不建立通用 Workflow DSL。

## Workflow 拓扑

默认生产路径是：

```text
ResultSet / Closure / Worker Job
              |
              v
         Calculation
              |
              v
      Calculation Bundle
              |
              v
   Result Materialization
              |
              v
Canonical Dataset Collection
              |
              v
      Release Candidate
```

Candidate 冻结后形成三个恢复方向：

```text
Release Candidate
  |
  +--> Publication
  |      direct publish of an immutable Candidate/component
  |
  +--> Scope refinement
  |      dependency + reverse-impact analysis
  |      -> Scope Decision -> new Package Plan -> new Candidate
  |
  +--> Dataset Transformation
         exact Candidate data -> transformed canonical data
         -> new Candidate
         or -> Calculation / Result Materialization when prior Result evidence is invalid
```

这些路径不共享 mutable `currentStage`。每个节点通过精确 identity、version、hash、artifact 和决定证据恢复。

## 控制关系

```text
用户
  <-> Agent / Operator
        -> Calculation Workflow
        -> Result Materialization Workflow
        -> Release Candidate Workflow
        -> Dataset Transformation Workflow
        -> Publication Workflow

Workflow
  -> release-owned adapter
  -> existing API / CLI / deterministic executable
  -> external authoritative system
```

Workflow 拥有意图整理、动作选择、本地证据和恢复上下文。外部系统继续拥有远程鉴权、任务状态、计算真相、数据库状态和发布事实。

外部访问分为三个平面：

- 控制面：actor-scoped Edge/API/RPC，负责业务动作、权限、任务、审批和原子状态转换；
- 数据库数据面：参数化、有界的批量读取，以及未来明确授权后的 staging 写入；
- artifact 数据面：S3 manifest、partition、Parquet、NDJSON 和 package 的本地传输与完整性校验。

## Artifact authority

本项目区分：

- Remote Resource：ResultSet、Closure Check、Worker Job、Result Package、Publication；
- Local Artifact：下载的 manifest、dataset、report、package 和 readback 文件；
- Semantic Draft：用户意图、字段建议和未决问题；
- Frozen Spec：可执行的 Transformation、Package 或 Candidate 输入规格；
- Release Candidate：通过完整资格验证、`publicationAuthorized=false` 的不可变发布输入；
- Decision Evidence：绑定精确 subject hash、target 和决定人的范围或授权证据。

Remote Resource 的状态由外部系统权威持有。本地 artifact 由内容 hash 标识。Draft 可以修改；Frozen Spec、Candidate 和已执行产物不得原地改写。

## Release Candidate 边界

Release Candidate Workflow 拥有：

- Release Intake 和依赖补齐；
- Package Plan；
- TIDAS/eILCD validation、conversion、round-trip 和 package build；
- Candidate qualification；
- failed build evidence；
- exclusion impact report、人工审核视图和 scope decision；
- 派生 Candidate 的完整重建与验证。

Candidate 内容发生 dataset-level 变化时，必须创建新 Package Plan 和新 Candidate。原 Candidate 不被部分删除、覆盖或重新解释。

从完整 Candidate 选择已经独立闭合的 Unit Process、Result 或 Both component，可以由未来 Publish Plan 表达；选择或排除包内具体 dataset 则先返回 Candidate Workflow。

## Dataset Transformation 边界

Dataset Transformation 以父 Candidate 和精确 dataset identity/version/hash 为输入，输出带变换血缘的新 canonical data。当前不冻结支持的加工类型、字段策略、聚合算法或执行入口。

任何实现都必须先判断旧 Result evidence 是否仍有效。改变模型、定量基准、provider、权重或结果语义的变换不能直接复用旧 Result；它必须返回 Calculation/Result Materialization。

## Publication 边界

Publication 只消费不可变 Candidate。当前确认的产品方向是让用户选择 Unit Process、Result 或 Both，并对目标平台执行精确的已存在状态转换或缺失数据写入。具体 state code、事务、审批 artifact、adapter 和恢复语义尚未设计。

在 Publication 契约和实现完成前，任何远程发布动作都保持 fail closed。Publication 不拥有内容变换、依赖猜测、Candidate 过滤或包重建。

## 恢复模型

每个 Workflow 自己保存：

- 入口资源；
- 已完成动作；
- 当前观察到的外部状态；
- 本地产物和证据；
- 等待用户回答的问题；
- 可执行动作；
- blocker 与最早返回点。

关闭终端或切换 Agent 后，通过精确资源 ID 和本地 evidence 恢复。一个 Workflow 可以建议进入另一个 Workflow，但不得把建议解释成授权执行。

## 实现边界

- 外部 API、CLI 和 executable 通过本仓库 adapter 调用；
- 外部 provider schema 只在 adapter 边界解析；
- Workflow 文档拥有行为语义，adapter 不拥有业务路线；
- 确定性计算、验证和打包不得由 Agent 模拟；
- 共享代码只提取已被多个 Workflow 实际复用的机制；
- 不为目录对称创建空运行时抽象；
- Publication 与 Dataset Transformation 在详细设计完成前只保留文档边界，不添加推测性执行代码。

## 当前实现基线

- Calculation 已实现 ResultSet、Closure/Calculation 提交、任务查询和数据库/S3 Calculation Bundle 数据面。
- Result Materialization 已实现 intake、Result Process/LifecycleModel 生成、验证和本地后台 Job。
- Release Candidate 已实现 Elementary Flow cache、Release Intake、Package build、失败影响分析、人工审核和 Candidate qualification。
- Dataset Transformation 和 Publication 当前尚无执行入口。
