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
- Draft Plan 或 Executable Plan 准备成功不表示已经审批、写入或发布；
- 回复必须披露自动补齐的依赖和因排除而递归剪枝的数据数量；
- 不输出 credential、内部 locator 或未确认的远程状态；
- Approval 回复必须展示 exact Executable Plan 和 Approval SHA-256；
- Execution 回复必须披露独立回读仍待完成，并给出 Receipt/events；
- 只有 Readback Receipt `status=verified` 时才能回复 Publication 已完成；
- Portal LCIA projection Plan 只是未授权计划，只有 exact Plan SHA-256 确认后才能 finalize；
- Portal LCIA V3 package publish 与 projection finalize 是两个独立 exact-confirmation 边界；package-published Event 必须披露 projection 仍 pending 和可能的 unavailable 间隔；
- Projection-finalized Event 明确保留 `independentReadbackVerified=false`，只有独立回读生成 verified Event 后才能声称公开投影闭环完成；
- Projection revoke 必须展示精确 finalized Event SHA-256，且只有独立回读为 `revoked` 后才能声称已停止公开；
- Package/revoke reused 或 response-loss Event 必须展示 `reasonPersistence`，不把本次请求理由冒充远端已持久化理由；
- 失败回复使用 CLI 提供的恢复入口，不建议删除或覆盖 execution event。
