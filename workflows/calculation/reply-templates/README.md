---
title: Calculation Reply Templates
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Calculation CLI 返回 replyTemplate 时
  - 当 Agent 需要向用户回复一个任务节点的结果时
whenToUpdate:
  - 当任务节点、用户回复要求或 CLI replyTemplate registry 变化时
checkPaths:
  - workflows/calculation/reply-templates/**
  - workflows/calculation/reply-template-registry.mjs
  - workflows/calculation/cli.mjs
related:
  - ../README.md
  - ../AGENTS.md
---

# Calculation 回复模板

这些文件包含每个任务节点可直接复制、填值并发送的中文回复模板。

CLI 的 `replyTemplate` 返回稳定模板 ID、仓库相对路径和必需事实。Agent 应读取对应 Markdown，
使用 CLI 本次返回的真实数据替换 `{{fact.path}}` 占位符，再按对话语境做少量润色。

使用规则：

- 发送前必须替换所有占位符；没有值的可选行应删除；
- `[若……]` 是条件提示，不应原样发给用户；
- emoji 表达状态：✅ 完成、🚀 已提交、🔎 查询/观察、⚠️ 不确定、❌ 失败；
- 不补造未知状态，不把“已提交”说成“已完成”，不把“查询命令已生成”说成“日志已读取”；
- 可以压缩或调整语气，但必须保留模板要求的身份、状态、完整性和下一步。

模板正文可以随产品语言改进；registry 中的稳定 ID 只有在消费者迁移后才能删除或改名。
