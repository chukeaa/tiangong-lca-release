---
title: tiangong-lca-release Repository Contract
docType: contract
scope: repo
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当任务可能改变 Release 项目目标、根 Workflow、运行时、契约或验证时
  - 当从 lca-workspace 路由工作到本仓库时
  - 当需要决定一项能力属于本仓库还是外部系统时
whenToUpdate:
  - 当项目目标、Workflow 边界、所有权、分支策略或验证门变化时
  - 当 Docpact ownership、coverage、routing 或 rules 变化时
checkPaths:
  - AGENTS.md
  - README.md
  - .docpact/config.yaml
  - docs/architecture.md
  - workflows/**
  - package.json
  - .github/workflows/ci.yml
lastReviewedAt: 2026-08-20
lastReviewedCommit: d9f2088e7945660dc98f53a8f63af200d8e24d90
lastReviewedNote: "Reviewed the repository contract for the local Release package-build route and its canonical artifact handoff."
related:
  - README.md
  - .docpact/config.yaml
  - docs/architecture.md
  - workflows/README.md
---

# Repository Contract

`tiangong-lca-release` 是面向人和 Agent 的本地数据产品工作台。它通过根目录 Workflow 组织 Calculation、Dataset Transformation、Result Materialization 和 Release，调用其他系统已经存在的能力，但不要求修改其他仓库。

## 当前实施基线

旧 `src/`、`scripts/`、`specs/`、`test/`、tsconfig 和 operator skill 已删除。不得恢复旧 20-stage runtime、默认兼容层或长期 legacy 目录。

后续工作一次只优化一个根 Workflow。新增实现、schema、fixture 或测试必须放在对应 `workflows/<name>/` 下，并遵守该目录的 README/AGENTS。Calculation 的 ResultSet create/list/get 已按此结构实现；不得把它重新聚合到仓库级 CLI。

## 加载顺序

1. `AGENTS.md`：仓库所有权、硬边界和确认状态；
2. `README.md`：项目目标、四个 Workflow 和待确认点；
3. `.docpact/config.yaml`：机器可读 ownership、routing、coverage 和 rules；
4. `workflows/AGENTS.md`：所有 Workflow 的共享契约；
5. 目标 `workflows/<name>/AGENTS.md`；
6. 目标 `workflows/<name>/README.md`；
7. 只有在目标 Workflow 开始实现后，才读取该目录新增的源码、规格和测试。

## Workflow 结构

本仓库当前有四个顶层 Workflow：

- `workflows/calculation`：ResultSet、Closure、计算任务和 Calculation Bundle；
- `workflows/dataset-transformation`：模型空间组合、结果聚合和字段声明；
- `workflows/result-materialization`：Result Process、LifecycleModel、identity/version 和 canonical dataset collection；
- `workflows/release`：package、candidate、approval、publish 和 readback。

完整性验证属于 Calculation；LCI/LCIA Result Process 生成和 LifecycleModel 组合属于 Result Materialization；Packaging 属于 Release。它们可以作为独立恢复节点或 recipe，但不是额外顶层 Workflow。

## 所有权

本仓库拥有：

- 根目录 Workflow 的说明、Agent 契约、产物、恢复和实现；
- 本地工作上下文、外部资源引用和 artifact lineage；
- Agent 对用户意图的整理、候选方案和待确认问题；
- 确定性 Transformation/Package spec 的本地实现；
- Result Process、LifecycleModel、identity/version 和 canonical dataset collection 的确定性 materialization；
- Release Candidate、精确审批、发布编排和独立回读；
- `tiangong-release` 操作入口及其有界 JSON 输出。
- 面向批量、非常规数据处理的受控数据库/S3 数据面 adapter，包括参数化只读查询、本地 artifact 传输、完整性验证，以及后续明确授权的 staging 写入。

本仓库不拥有：

- Next 页面行为；
- Worker 求解器和远程任务生命周期；
- Database schema、RLS、权限和发布事实；
- Edge Function 业务实现；
- 其他仓库的 CLI、TIDAS schema、SDK 或打包算法源码。

其他系统只作为外部能力被调用。缺少能力时停止并报告，不扩大修改范围。

## 硬边界

- 不把数据库连接串、S3 credential、Supabase service-role 或其他 secret 放入源码、stdout、命令参数或恢复产物。
- 允许所属 Workflow 通过 ignored `.env` 使用受控数据库/S3 数据面；SQL 必须参数化、有界并声明读写模式。未经 Workflow 契约和用户明确授权，不得直接修改 canonical 业务表；批量写入应采用 staging、验证和原子提升边界。
- 不导入其他 workspace 子仓的内部源码。
- 不解码、打印、持久化或放入命令参数的用户凭据。
- 不持久化 signed URL；本地批量 artifact 传输优先使用受控 S3 数据面，避免逐 artifact 签名。
- 不从 mutable `latest` 推断缺失的 identity、version、graph 或 method。
- 不让 LLM 直接生成最终数值、hash 或发布证据。
- 不把 transport success 当作 domain validity、publication 或 readback success。
- 不把派生数据自动写入普通 authoring tables。
- 大型 artifacts 写入文件或对象存储，stdout 只返回有界摘要和引用。
- 未经精确内容和 target 审批不得远程发布。

## Runtime 与分支事实

- Node：`>=24 <25`
- package manager：`npm`
- branch model：M1
- daily trunk / routine PR base：`main`
- 当前工作分支：`codex/feature-issue-31-release-intake`
- 跟踪 Issue：`chukeaa/tiangong-lca-release#31`
- 本地运行产物根目录：`.release/`，必须 gitignored
- 当前文档基线验证门：`npm run prepush:gate`

## 文档规则

- 根 `README.md` 只描述当前项目目标和跨 Workflow 关系。
- `workflows/README.md` 只做 Workflow 导航。
- `workflows/AGENTS.md` 只拥有共享规则。
- 每个子 Workflow 的 `README.md` 和 `AGENTS.md` 只描述该 Workflow。
- 不把旧 20-stage 的纠正说明、事故或迁移叙事重新加入活动文档。
- 只有仍有用的安全原则可以转写为当前 Workflow 规则。

## 当前完成条件

- 旧 runtime 和耦合配置已删除；
- 根 README 清楚表达项目目标和四个 Workflow；
- 每个 Workflow 有 README 和 AGENTS；
- Docpact 能覆盖和路由 `workflows/**`；
- Calculation 的 ResultSet create/list/get、Closure/计算提交、数据库/S3 Bundle list/get/download 和 Worker 日志委托保持 workflow-local，确认、provider compatibility、参数化只读 SQL、artifact 完整性、内部最小引用、恢复和错误路径测试通过；
- Result Materialization 通过一个 workflow-local `materialize` 入口冻结 scope、最终对象和 Result Process 内容层；Result-only 不扩展 provider，LifecycleModel 在内部完成 Result Catalog 与 Model 收敛，并对多 exact axes 的 Result lineage 冲突 fail closed；
- Result Materialization 输出并由 manifest hash 绑定 canonical dataset index；Release 从不可变的 Materialization Intake 准备独立 Release Intake，按精确版本补齐 LCIA Method characterisation Flow，再组装本地 TIDAS 输入并委托 `tidas-tools` 验证、转换和生成四个 ZIP；
- Release Candidate 显式保持 `publicationAuthorized=false`，本地 package build 不构成审批或发布授权；
- 当前变更通过仓库门禁并形成独立 Git commit。
