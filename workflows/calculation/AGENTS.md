---
title: Calculation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Calculation Workflow 时
whenToUpdate:
  - 当入口解析、远程命令、证据绑定、恢复或确认规则变化时
checkPaths:
  - workflows/calculation/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Required provider-compatible ResultSet adapters and a stable Release-owned internal reference."
related:
  - README.md
  - ../AGENTS.md
---

# Calculation Workflow Agent Contract

## 加载顺序

1. 仓库根 `README.md`；
2. `workflows/AGENTS.md`；
3. 本文件；
4. 本目录 `README.md`；
5. 只有在实际调用某个外部能力时，才读取其最小版本契约。

## Agent 必须先做的事

- 解析用户提供的是名称、ResultSet、Closure、Job、Package 还是 Bundle。
- 如果名称对应多个对象，停止并要求精确选择。
- 读取权威远程状态，不根据本地旧摘要猜测。
- 输出当前已有证据、仍需决定的问题、允许动作和阻塞动作。

## 可自动执行的只读动作

- 查询已有对象和任务；
- 读取有界报告和 artifact metadata；
- 下载用户已经明确要求的产物；
- 校验大小、hash、版本和 manifest 引用；
- 恢复一个已有任务的状态观察。

## ResultSet 操作入口

- 使用 `npm --prefix workflows/calculation run --silent cli -- result-set ...`；CLI script 和命令实现都由本目录拥有，不得提升为仓库级 `tiangong-release` CLI。
- `list` 默认最多返回 20 条，最大 200 条，并把无 cursor 的结果标记为 bounded。
- `get` 必须使用精确 `resultSetId`；不得按名称隐式选择。
- `create` 必须在用户确认精确名称后使用 `--confirm-create`。
- JSON stdout 必须保持 `tiangong.calculation-cli-result.v1` 可解析；诊断不得混入 stdout。
- 每个 CLI 结果必须返回 `replyTemplate` 的稳定 ID、路径、Markdown 格式、占位符语法和 required facts。Agent 应从可复制正文模板开始，用真实结果替换全部占位符、删除不适用条件行，不让模板覆盖 CLI/远程事实。
- provider payload 只在 adapter 中解析；外部新增字段或非破坏性版本变化不得使 Workflow 失败。
- Workflow、CLI 和恢复文件只使用 `id`、`name`、nullable `createdAt` 和来源元数据组成的内部 ResultSet 引用。
- 外部 `schemaVersion` 只作为可选观察信息，不得成为 Workflow 分支条件。
- 创建或读取成功后保存最小本地恢复引用，不保存凭据或 signed URL。
- 创建请求发生 transport failure 或远程 5xx 时返回 `remote_outcome_unknown`，先查询远程状态，不自动重试。
- Closure/Calculation `start` 必须显式确认并携带幂等 token/key；内部只投影稳定 job/resource identity，不以 provider `schemaVersion` 分支。
- Calculation 提交只要有稳定 Worker Job ID 即视为 `submitted`；结果资源未 materialize 时使用 nullable `resourceId` 与 `identityCompleteness=job_only`。Closure 仍要求 Closure/Job 双身份；不得因异步结果 ID 暂缺误报 `remote_outcome_unknown`。
- 未显式选择时使用当前 Calculation profile：`global_eligible` 与 Climate change/GWP `6209b35f-9447-40b5-b68c-a1099e3674a0@01.00.000`；输出必须披露 defaulted inputs，显式参数优先。
- Worker job 日志必须委托给根 workspace 的 `python -m workspace_ops.cli worker job`；本 Workflow 只输出精确命令，不复制服务器配置、SSH 或 journal 逻辑。
- `workspace_ops qualification` 只用于生产等价发布资格门禁，不得当作线上 Closure Check 提交能力。

## 需要明确确认的动作

- 创建 ResultSet；
- 启动 Closure Check；
- 启动计算任务；
- 改变 scope、方法集或有效证据绑定；
- 创建会取代已有业务对象的新计算分支。

## 硬边界

- 不实现求解器或复制 Worker 逻辑。
- 不在 Calculation Workflow 中生成 Result Process、LifecycleModel 或 package。
- 不从 mutable `latest` 推断缺失身份、版本或计算输入。
- 不把任务 transport success 当作 domain validity。
- 不把 Closure warning 自动解释为可忽略。
- 不持久化 signed URL、access token 或用户 API key。
- 认证优先使用显式 actor JWT；否则从 `TIANGONG_LCA_API_KEY` 交换进程内短期 session。不得把 user API key 直接当 bearer、输出 token、建立第二套持久 session cache，或在不同 API key 间静默回退。
- 不因外部能力缺失修改其他仓库。

## 完成条件

用户请求的终点已满足，并且另一位 Agent 能根据精确资源引用、当前状态和证据继续；如果用户只要求验证或启动任务，不应强制继续到下载。
