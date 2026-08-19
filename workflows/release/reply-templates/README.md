---
title: Release Reply Templates
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Release CLI 返回 replyTemplate 时
  - 当 Agent 需要向用户回复候选构建或失败结果时
whenToUpdate:
  - 当 Release CLI outcome、错误恢复方式或 replyTemplate registry 变化时
checkPaths:
  - workflows/release/reply-templates/**
  - workflows/release/reply-template-registry.mjs
  - workflows/release/cli.mjs
related:
  - ../README.md
  - ../AGENTS.md
---

# Release 回复模板

这些模板用于把 Release CLI 的结构化结果转换成简洁、准确的用户回复。

使用规则：

- 使用 CLI 返回的真实事实替换全部 `{{...}}`，删除不适用的条件行；
- ✅ 只表示本地候选已构建和验证，不表示已批准、上传或发布；
- ⚠️ 表示输入证据发生漂移，需要回到上游冻结输入，不自动重试；
- ❌ 表示命令失败，回复中必须保留错误代码和至少一个恢复动作；
- 不输出 credential、内部 locator、signed URL 或未确认的远程状态；
- 模板可以按对话语气压缩，但不能改变授权边界或完成状态。

模板 ID 是稳定的 Agent-facing 接口；正文可以改进，ID 只有在消费者迁移后才能删除或改名。
