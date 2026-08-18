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

这些模板定义每个任务节点回复用户时应覆盖的事实和下一步，不是固定文案生成器。

CLI 的 `replyTemplate` 返回稳定模板 ID、仓库相对路径和必需事实。Agent 应读取对应 Markdown，
使用 CLI 本次返回的真实数据自然回复；不得照抄占位符、补造未知状态或把“已提交”说成“已完成”。

模板正文可以随产品语言改进；registry 中的稳定 ID 只有在消费者迁移后才能删除或改名。
