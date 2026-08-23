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
lastReviewedAt: 2026-08-23
lastReviewedCommit: 5d4fd4af0c1bd769f058551ab9a698dc55a51c00
lastReviewedNote: "Reviewed the local canonical-dataset handoff from Result Materialization into Release package assembly."
related:
  - ../AGENTS.md
  - ../README.md
  - ../workflows/README.md
---

# Architecture

## 架构单位

本项目的主要架构单位是根目录 Workflow，而不是一个跨项目 stage machine，也不是 `src/` 中的模块目录。

```text
Repository
├── README.md                 # 项目目的与四个 Workflow 的关系
├── AGENTS.md                 # 仓库契约
├── workflows/                # 主要业务与 Agent 导航单位
│   ├── calculation/
│   ├── dataset-transformation/
│   ├── result-materialization/
│   └── release/
├── docs/                     # 跨 Workflow 架构说明
├── package.json              # 当前文档基线工具与验证入口
└── .github/workflows/        # 仓库级验证
```

一个 Workflow 可以在自己的根目录下包含说明、Agent 契约、模板、schemas、fixtures、验证器和代码。不是所有 Workflow 都需要相同子目录，也不建立通用 Workflow DSL。

## 控制关系

```text
用户
  <-> Agent / Operator
        -> Calculation Workflow
        -> Dataset Transformation Workflow
        -> Result Materialization Workflow
        -> Release Workflow

Workflow
  -> release-owned adapter
  -> 已存在的 API / CLI / local executable
  -> 外部权威系统
```

Workflow 拥有意图整理、动作选择、本地证据和恢复上下文。外部系统继续拥有远程鉴权、任务状态、计算真相和发布事实。

外部访问分为三个平面：

- 控制面：actor-scoped Edge/API/RPC，负责业务动作、权限、任务、审批和原子状态转换；
- 数据库数据面：参数化、有界的批量读取，以及未来明确授权后的 staging 写入；
- artifact 数据面：S3 manifest、partition、Parquet、NDJSON 和 package 的本地传输与完整性校验。

不得为了保持“所有访问都经过 Edge”而让交互接口逐条搬运大型数据或串行签发大量 URL。数据面 adapter 仍须隐藏 credential、内部 locator 和连接细节，并由 Workflow 契约限定允许的查询、目标和写入阶段。

## Workflow 之间的关系

四个 Workflow 通过精确产物引用连接，而不是互相共享 mutable state：

```text
Calculation Bundle -----------------------+
                                          |
Dataset Transformation Manifest ----------+--> Result Materialization
                                                   |
                                                   v
                                       Canonical Dataset Collection
                                                   |
                                                   v
                                      Canonical Dataset Index
                                                   |
                                                   v
                                Release Intake Preparation
                                  /                      \
                     frozen upstream refs       exact LCIA Method Flow
                                                   supplement
                                  \                      /
                                                   v
                                           Release Intake
                                                   |
                                                   v
                                      Local TIDAS Package Build
                                                   |
                                                   v
                                           Release Candidate
```

一个 Workflow 可以建议用户进入另一个 Workflow，但不得自动把“建议下一步”解释成授权执行。

## Artifact authority

本项目需要区分：

- Remote Resource：ResultSet、Closure Check、Worker Job、Result Package、Publication；
- Local Artifact：下载的 manifest、dataset、report、package 和 readback 文件；
- Semantic Draft：用户意图、字段建议、未决问题；
- Frozen Spec：可执行的 Transformation、Package 或 Release Candidate；
- Decision Evidence：绑定精确 subject hash 和 target 的用户决定。

Remote Resource 的状态由外部系统权威持有。本地 Artifact 由内容 hash 标识。Draft 可修改；Frozen Spec 和已经执行的产物不可原地改写。

## 恢复模型

项目不保存一个全局 `currentStage`。每个 Workflow 自己保存：

- 入口资源；
- 已完成动作；
- 当前观察到的外部状态；
- 本地产物和证据；
- 等待用户回答的问题；
- 可执行动作；
- blocker 与最早返回点。

关闭终端或切换 Agent 后，通过精确资源 ID 和本地 evidence 恢复。

## 实现边界

目标确认后，运行时实现应遵守：

- 外部 API、CLI 和 executable 通过本仓库 adapter 调用；
- 外部 provider schema 只在 adapter 边界解析；Workflow、CLI 和本地恢复文件只消费 Release-owned 最小语义对象；
- adapter 接受不改变必要语义的附加字段和版本变化，不把外部 `schemaVersion` 作为 Workflow 分支条件；
- Workflow 文档拥有行为语义，adapter 不拥有业务路线；
- 确定性计算、验证和打包不得由 Agent 自行模拟；
- 共享代码只提取已被多个 Workflow 实际复用的机制；
- 不为目录对称而创建空抽象；
- 不保留与新 Workflow 无关的旧 stage、schema 或测试。

## 当前基线

四个根 Workflow 的拆分已经得到用户确认。每个可执行入口由所属 Workflow 本地拥有，不建立仓库级聚合 CLI。

Calculation 当前已经实现 ResultSet 的 actor-scoped create/list/get、Closure/Calculation 提交、数据库优先的任务状态查询，以及数据库/S3 Calculation Bundle 数据面。Bundle list/get 直接执行参数化只读 SQL；download 通过精确 Package metadata 从 S3 有界并发下载并校验 manifest/artifacts，不调用重量级 Edge 签名路径，也不把 credential、object locator 或 signed URL 放入输出。外部 payload 统一经 provider compatibility adapter 转为 Release-owned 最小引用。后续能力仍一次只优化一个 Workflow；只有当前确认的说明、契约、实现和验证进入活动结构。

Result Materialization 当前在每次成功执行后生成内容寻址的 canonical dataset index，并由 materialization manifest 绑定该索引。Release 不再把 Materialization Intake 直接视为最终分发输入：独立维护的项目级 Elementary Flow 缓存以数据库 published count 与 `MAX(modified_at)` 作为 freshness watermark，只有显式 `cache refresh` 才执行长时只读下载；常规 `intake prepare` 只消费 fresh 缓存，保持两个上游不可变，按精确版本补齐 LCIA Method characterisation Flow，并冻结独立 Release Intake。Package build 只消费该 Intake，重新验证上游和 supplement hash，形成 canonical TIDAS 输入，再委托 `tidas-tools` 完成通用精确引用闭包、TIDAS/eILCD 验证、转换、语义回读和四类 ZIP 生成。生成 ZIP 与 Candidate qualification 是独立状态：qualification 失败会保留未授权的 failed build 和诊断证据；只有最终 ZIP 全部回读通过才原子提交 `publicationAuthorized=false` 的 Release Candidate。审批、上传、发布和独立远端回读仍是后续独立动作。
