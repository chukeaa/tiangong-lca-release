---
title: Release Workflows Shared Contract
docType: contract
scope: workflows
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 在 workflows 下设计、实现或运行任一 Workflow 时
whenToUpdate:
  - 当所有 Workflow 共享的证据、权限、恢复或文档规则变化时
checkPaths:
  - workflows/**
lastReviewedAt: 2026-08-19
lastReviewedCommit: b20ff41073d09a1fa914eb88bf600d7cf277ab2e
lastReviewedNote: "Established shared Agent boundaries for root-level workflow packages."
related:
  - ../AGENTS.md
  - ../README.md
---

# Workflows 共享契约

## Workflow 的定义

一个 Workflow 是面向人和 Agent 的完整工作包。它同时拥有：

- 目标和适用入口；
- 输入、输出和血缘；
- 用户需要回答的问题；
- 确定性验证和证据；
- 外部能力调用边界；
- 失败、重试和继续方式；
- 后续实现、模板、示例和测试。

不得把 Workflow 简化成 `src/` 中的一个函数、类或状态机。

## 共享执行原则

- 先 `inspect`，再提出可执行动作；不默认从第一步开始。
- 精确资源 ID、版本、hash 和 target 优先于名称或 `latest`。
- 已有证据只有在覆盖范围、依赖和有效期匹配时才能复用。
- 一个 Workflow 的失败不得自动使无依赖关系的其他 Workflow 失效。
- 重试必须发生在同一个可恢复节点，或基于新增信息创建新节点。
- 大型产物写入文件或对象存储；stdout 只返回有界摘要和引用。
- 远程状态由外部系统权威持有；本地只保存观察、引用和证据。

## 人工决定

以下动作不得通过默认值或 Agent 推断代替用户决定：

- 创建或采用哪个业务工作对象；
- 启动可能耗时或产生远程副作用的验证和计算；
- 变换的语义、权重、功能单位和重要字段；
- Release Candidate 内容与正式发布授权。

观察、建议、决定、发布授权和执行必须在语义上保持区分。

## 外部系统边界

- 不修改其他仓库。
- 不导入其他仓库的内部源码。
- Workflow 可在自己的明确数据面 adapter 中使用 ignored `.env` 的数据库/S3 凭据执行参数化、有界、可审计的批量读写；控制面动作仍使用 actor-scoped API。
- 未经 Workflow 契约和用户明确授权，不得直接修改 canonical 业务表；写入应使用 staging、验证和原子提升边界。
- 不记录、打印或把数据库/S3/Supabase secret 放入命令参数。
- 不记录、打印或持久化用户凭据和 signed URL。
- 只通过现有 actor-scoped API、CLI 或本地确定性工具调用外部能力。
- 能力不存在时返回明确 blocker，不扩大任务范围。

## Workflow 文档要求

每个 Workflow 至少维护：

- `README.md`：用户可理解的当前路线和开放问题；
- `AGENTS.md`：Agent 可执行的当前契约。

实现开始后，新增文件必须放在最能表达其职责的位置，不预设所有 Workflow 使用相同代码布局。
