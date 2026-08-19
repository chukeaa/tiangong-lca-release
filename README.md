---
title: TianGong LCA Release 项目说明
docType: guide
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要理解 Release 项目的当前目标、工作流边界和确认状态时
  - 当需要决定一项工作属于 Calculation、Dataset Transformation、Result Materialization 还是 Release Workflow 时
  - 当准备实现、运行或审查任一 Release Workflow 时
whenToUpdate:
  - 当项目目标、工作流划分、跨工作流关系或确认结论变化时
  - 当新增、删除或重新定义根目录 workflows 子目录时
checkPaths:
  - README.md
  - AGENTS.md
  - docs/architecture.md
  - workflows/**
  - .docpact/config.yaml
lastReviewedAt: 2026-08-19
lastReviewedCommit: 46b711949c4e91eff1a817ec4abd87615cd5a276
lastReviewedNote: "Reviewed repository workflow boundaries while reframing Result Materialization around its domain model."
related:
  - AGENTS.md
  - docs/architecture.md
  - workflows/README.md
---

# TianGong LCA Release

`tiangong-lca-release` 是一个面向人和 Agent 的本地数据产品工作台。

它帮助用户从任意已有节点继续工作，组织完整性验证、计算、数据集变换、打包和正式发布，同时保留每一步使用的精确输入、用户决定、验证证据、输出产物和恢复入口。

这个项目不是另一个前端、计算引擎或数据库服务。它不要求修改 TianGong LCA 的其他仓库，而是把其他系统已经提供的能力视为外部能力，通过适合其负载的稳定边界调用：业务控制动作使用 actor-scoped API，批量元数据使用参数化数据库数据面，大型 artifacts 使用 S3 数据面。

## 当前基线状态

四个根 Workflow 的结构已经确认。旧 20-stage runtime 的 `src/`、`scripts/`、`specs/`、`test/`、tsconfig 和 operator skill 已直接删除，不保留 legacy 副本。

当前仓库以四个 Workflow 为活动基线。Calculation 已拥有 workflow-local ResultSet
create/list/get、Closure Check 与计算任务提交、数据库优先的任务状态查询、数据库/S3 Calculation Bundle list/get/download 数据面，以及委托根 workspace_ops 查询 Worker job 日志的薄入口；外部响应经兼容 adapter 转为 Release-owned 最小引用。其余能力继续按照
Calculation、Dataset Transformation、Result Materialization、Release 的顺序逐个确认和实现。
每个 Workflow 的实现、schemas、fixtures 和测试都保留在自己的目录中。
Calculation 可直接使用仓库 `.env` 中的用户 API key bootstrap 交换进程内短期 session，无需人工复制 access token。
Calculation 当前默认 profile 是 `global_eligible`、完整的 25 个 reviewed LCIA identity，以及独立的 Climate change/GWP 默认展示类别 `6209b35f-9447-40b5-b68c-a1099e3674a0`；命令输出会披露默认值的采用情况。
Calculation 的每个已实现 CLI 节点还会返回 workflow-local、可直接填值的 Markdown 回复模板，使用克制的状态 emoji 帮助 Agent 区分已提交、已完成、委托查询和远程结果未知等用户回复语义。
异步计算以 Worker Job ID 作为最低提交身份；Result Package 尚未生成时保持正常 `job_only` 状态，不误报远程结果未知。
创建 ResultSet 未提供名称时，Calculation 会推荐 Asia/Shanghai `ResultSet-YYYYMMDD-HHmm` 并等待显式确认，不静默创建。

在任何 Workflow 明确授权之前：

- 不开始新的远程发布；
- 不修改 Next、Worker、Database、Edge、CLI、tidas-tools 或其他仓库；
- 不恢复旧 20-stage 代码作为默认实现。

## 项目的四个 Workflow

```text
workflows/
├── calculation/
├── dataset-transformation/
├── result-materialization/
└── release/
```

### 1. Calculation Workflow

负责从“我要做一次计算”到“计算结果已经可靠地下载到本地”的完整过程。

它包括：

- 创建一个有名称的远程 ResultSet，或接入已有 ResultSet；
- 从已有 Closure Check、计算任务、结果包或 Calculation Bundle 继续；
- 向用户确认数据范围和 LCIA 方法集；
- 启动并跟踪线上完整性验证；
- 展示验证报告、阻塞项和可恢复动作；
- 在有效完整性证据的基础上启动计算；
- 跟踪计算任务并下载、校验 Calculation Bundle；
- 把远程资源身份和本地产物关联到同一个本地工作上下文。

完整性验证不是独立的顶层 Workflow。它是 Calculation Workflow 中可以单独进入、重试和复用的关键节点。

详见 [Calculation Workflow](workflows/calculation/README.md)。

### 2. Dataset Transformation Workflow

负责从已有数据集或计算结果生成新的派生数据。

它包括：

- 选择精确的数据集、版本或计算产物；
- 让 Agent 帮助用户表达变换目的、权重依据和字段填写意图；
- 区分模型空间组合与结果空间聚合；
- 形成可审查的变换草案；
- 在所有语义问题解决后冻结确定性执行规格；
- 通过确定性实现执行数值和文档变换；
- 生成新的 Dataset Collection、LifecycleModel、Result Process 或其他明确产物；
- 保存输入、权重、字段来源、验证结果和派生血缘。

第一类重点案例是“选择若干数据集，按明确权重组合为一个新数据集，并声明 Process 或 LifecycleModel 字段如何填写”。

详见 [Dataset Transformation Workflow](workflows/dataset-transformation/README.md)。

### 3. Result Materialization Workflow

负责把 Calculation Bundle 或派生结果确定性地组装为标准 LCA 数据集。

它包括：

- 依次选择精确 Process 范围、最终对象（Result Process 或 LifecycleModel），以及本次生成的 Result Process 内容层（LCI 或 LCI + LCIA）；
- Result Process 只处理所选 roots；LifecycleModel 在一次动作中从 direct edges 派生依赖、冻结 Result Catalog 并生成最终 Model；
- 逐条生成 Result Process，统一冻结 Result UUID/version Catalog；
- 使用根 Unit Process、direct provider Result Processes 和精确 connections 逐条生成 resolved one-hop LifecycleModel；
- 读取上一版 manifest 并分阶段求解 Result/Model dataset version；
- 同一稳定 Result UUID lineage 下按 exact source revision 生成并引用独立 dataset versions；
- 保持 calculation-time quantitative-reference signed pivot，并为旧 Bundle 使用已校验 exact source closure 的有界兼容；
- 渲染精确 identity/version 引用；
- 验证 TIDAS schema、引用闭合、Result 数值一致性和 one-hop Model 重构一致性；
- 输出 canonical dataset collection、dataset index 和 materialization manifest。

LCI Result Process、LCI + LCIA Result Process 和 LifecycleModel 不是三个顶层 Workflow，而是同一个 Materialization Workflow 下共享身份、版本和引用约束的 recipe。LifecycleModel 本身不保存 LCI/LCIA 数值，只引用本次生成的精确 Result Process。

详见 [Result Materialization Workflow](workflows/result-materialization/README.md)。

### 4. Release Workflow

负责把已经冻结并通过必要验证的数据产品组织为正式发布候选，并完成发布与独立回读。

它包括：

- 选择已经 materialize 并验证的 canonical dataset collection；
- 决定包中包含哪些 dataset roots、result layers、closure 和 formats；
- 生成可审查的 Package Plan 和 Release Candidate；
- 执行 TIDAS/ILCD 验证、格式转换、语义 round-trip 和确定性打包；
- 将人工决定绑定到精确 plan hash 和 target fingerprint；
- 通过 actor-scoped 外部接口执行上传和发布；
- 独立下载已发布产物并验证字节数、SHA-256 和终态。

Packaging 不是独立的顶层 Workflow。它属于 Release Workflow 中发布之前的候选构建与验证阶段。

详见 [Release Workflow](workflows/release/README.md)。

## 四个 Workflow 如何组合

```text
Calculation
  ResultSet -> Closure Evidence -> Calculation Bundle
                                      |
                                      +-------------------+
                                                          |
Dataset Transformation                                    |
  Dataset / Calculation Bundle -> Derived Dataset --------+
                                                          |
Result Materialization                                    |
  Frozen result/model -> Canonical Dataset Collection ----+
                                                          |
Release                                                   |
  Frozen inputs -> Package Plan -> Candidate -> Publish <-+
```

它们没有一个共享的全局 stage number，也不要求每次从头执行。

每个 Workflow 都必须能够：

1. 识别用户给出的已有资源；
2. 判断哪些证据仍然有效；
3. 展示当前允许的动作和阻塞原因；
4. 只执行用户授权的当前动作；
5. 保存足够信息，使另一位人或 Agent 可以从该节点继续。

## Workflow 不是纯脚本目录

每个 `workflows/<name>/` 是一个完整的 Agent 工作包，至少包含：

- `README.md`：面向用户的目标、路线、产物和待确认问题；
- `AGENTS.md`：面向 Agent 的操作契约、权限边界、证据要求和完成条件；
- 后续按实际需要添加的契约、模板、示例、验证器和执行代码。

Workflow 的说明和边界先于实现。代码属于某个 Workflow，但 Workflow 不等于代码文件夹。

## 与其他仓库的解耦原则

本项目允许调用其他系统已经提供的能力，但不修改它们：

| 外部能力                     | 本项目如何使用                                           |
| ---------------------------- | -------------------------------------------------------- |
| ResultSet、Closure、计算任务 | 通过现有 actor-scoped API 或命令调用                     |
| Worker 计算                  | 只提交任务、查询状态和读取产物，不实现或修改 Worker      |
| TIDAS/ILCD 验证与转换        | 调用已有可执行工具，不导入其他仓库源码                   |
| Database / Edge              | Edge 承担控制面；数据库承担受控批量查询和 staging 数据面 |
| Object Storage               | 通过受控 S3 数据面传输大型 immutable artifacts           |
| 公共发布                     | 通过已有 actor-scoped 发布入口，不使用 service-role      |

数据库/S3 数据面 credential 只能存在于 ignored `.env` 或受保护环境中；查询必须参数化、有界，CLI 不输出连接串、secret、内部 locator 或 signed URL。Canonical 写入仍必须经过明确 Workflow 契约、用户授权以及 staging → validation → promotion 边界。

如果某项所需能力当前没有稳定入口，对应 Workflow 必须报告 `capability_unavailable`，而不是悄悄修改其他仓库或绕过权限边界。

## 人与 Agent 的分工

Agent 可以：

- 识别入口和已有产物；
- 整理范围、候选路线和缺失信息；
- 生成 Transformation 或 Package 草案；
- 调用确定性工具；
- 汇总验证证据和下一步选择。

Agent 不能替代用户决定：

- ResultSet 名称和数据范围；
- 是否启动线上完整性验证或计算；
- 加权依据、功能单位和重要字段语义；
- Release Candidate 的精确内容；
- 正式发布授权。

数值计算、格式验证、hash 校验和打包必须由确定性实现完成，不能由语言模型直接生成结果数字。

## 已确认的结构

1. 顶层保留 `calculation`、`dataset-transformation`、`result-materialization`、`release` 四个 Workflow。
2. 完整性验证属于 Calculation Workflow，但允许从 Closure Check 节点单独进入。
3. LCI Result Process、LCI + LCIA Result Process 和 LifecycleModel 属于 Result Materialization 下的 recipe，不拆成三个顶层 Workflow。
4. Packaging 属于 Release Workflow，不作为第五个顶层 Workflow。
5. Materialization 中源 Unit Process、LifecycleModel 和 Result Process 保持不同身份，不把 LCI/LCIA 写回原始 Unit Process。
6. Release 只消费已经 materialize 的 canonical datasets，不在打包过程中临时生成 Process/Model。
7. 其他仓库保持不变；缺少能力时本项目明确停止并报告，而不是跨仓补实现。
8. LifecycleModel 首版采用 resolved one-hop aggregated-background：根 instance 引用 `U(P)`，每条有效 direct provider edge 引用对应聚合 `R(Q)`，resulting Process 引用 `R(P)`。
9. 同一 Result UUID lineage 可包含多个 exact source Process revisions；每个 revision 使用独立 dataset version，Model 引用 calculation axis 对应的精确版本。
10. Quantitative reference 保持 Worker 的 raw direction/amount 与 signed normalization pivot；旧 Bundle 只从本地已校验 exact source closure 回推，不访问 mutable 远端状态。

## 仍需确认的细节

1. Dataset Transformation 的默认产物是否只保留在本地工作区，不直接写回线上 authoring tables。
2. 加权组合默认优先生成 LifecycleModel 或 Derived Result，还是每次都由用户选择输出类型。
3. Release 首版 formats、package recipes、subset 限制和本地预览边界。

## 开发状态

- 跟踪 Issue：`chukeaa/tiangong-lca-release#17`
- 当前分支：`codex/docs-issue-17-conceptual-materialization`
- 当前阶段：Result Materialization 的领域设计说明正在改写为面向用户的概念模型
- 运行时状态：Calculation 已拥有 ResultSet、Closure/计算提交、任务查询、Bundle 数据面和 Worker 日志委托；Result Materialization 已拥有本地 Result Process/LifecycleModel 生成与验证入口
