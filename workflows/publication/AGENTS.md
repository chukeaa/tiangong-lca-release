---
title: Publication Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 评估或设计 Release Candidate 的远程发布时
whenToUpdate:
  - 当 Publication 的状态、授权、写入、恢复或回读规则得到确认时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: 6c8a25b20830794c855549a4866456a5a0c6e3ea
lastReviewedNote: "Kept remote publication fail closed while its detailed contract and implementation remain deferred."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

## 当前阶段

本 Workflow 只有高层产品边界，没有已确认的 Publish Plan、approval、状态码、写入 adapter、事务、恢复或 readback 契约，也没有可执行 CLI。

## 当前允许的动作

- 只读检查 Candidate identity、hash、components 和已有本地验证证据；
- 帮助用户表达希望发布 Unit Process、Result 或 Both；
- 识别 dataset-level 范围变化并返回 Release Candidate Workflow；
- 整理后续 Publication 设计需要解决的问题。

## 当前硬边界

- 不执行任何远程发布或数据库状态修改；
- 不把 Candidate 构建成功解释为发布授权；
- 不在 Publication 中修改、删除或补写 Candidate 内容；
- 不猜测最终 state code、target、写入接口或事务语义；
- 不把 transport success 当作 publication 或 independent readback success；
- 不根据名称或 mutable `latest` 选择发布对象。

## 进入实现的前提

必须通过单独跟踪的设计任务确认 Publish Plan、精确授权、目标差异分类、状态转换、缺失数据写入、幂等、失败恢复和独立回读契约，才能增加远程执行代码。
