---
title: Publication Reply Templates
docType: reference
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Publication CLI 返回 replyTemplate 时
whenToUpdate:
  - 当 Publication CLI outcome、artifact 或恢复动作变化时
checkPaths:
  - workflows/publication/reply-templates/**
  - workflows/publication/reply-template-registry.mjs
  - workflows/publication/cli.mjs
related:
  - ../README.md
  - ../AGENTS.md
---

# Publication 回复模板

- 只使用 CLI 返回的真实事实替换占位符；
- Publish Plan 准备成功不表示已经审批、写入或发布；
- 回复必须披露自动补齐的依赖和因排除而递归剪枝的数据数量；
- 不输出 credential、内部 locator 或未确认的远程状态；
- 远程执行入口尚不可用时必须明确说明，不提供伪命令。
