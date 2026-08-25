---
title: Publication Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户准备把不可变 Release Candidate 发布到 TianGong LCA 平台时
whenToUpdate:
  - 当发布选择、目标差异、状态转换、写入、审批、恢复或回读规则得到确认时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: 6c8a25b20830794c855549a4866456a5a0c6e3ea
lastReviewedNote: "Established the Publication boundary while deferring detailed state, transaction, approval, and adapter design."
related:
  - AGENTS.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Publication Workflow

## 当前定位

Publication 消费不可变 Release Candidate，在用户完成精确选择和授权后改变 TianGong LCA 平台上的发布状态，并独立确认远程终态。

```text
Release Candidate
  -> choose Unit Process / Result / Both
  -> future Publish Plan and approval
  -> remote publication
  -> independent readback
```

## 已确认方向

- 用户可以选择发布 Unit Process、Result 或 Both；
- 选择的是用户希望发布的 roots，实际发布集合仍需要满足精确引用完整性；
- 平台已存在精确 UUID + Version 时，未来发布动作转换其生命周期状态；
- 平台不存在该主键时，未来发布动作写入 Candidate 中的精确数据并进入发布态；
- Publication 只消费已经冻结并验证的 Candidate；
- Candidate 内容变化必须先返回 Release Candidate 或 Dataset Transformation 生成新 Candidate。

## 尚未设计

本阶段不定义：

- 最终发布 state code；
- 已存在内容的一致性判断和冲突处理；
- Publish Plan、approval 和 receipt schema；
- transaction、staging、promotion 和幂等策略；
- actor-scoped API、数据库 adapter 或权限模型；
- 批量失败恢复和独立 readback 的具体协议；
- workflow-local CLI。

这些规则和实现必须在后续单独跟踪的 Publication 设计任务中确认。在此之前，不执行远程发布。

## 与 Candidate 范围选择的边界

按 Unit Process、Result 或 Both 选择已经独立闭合的 Candidate component，可以由未来 Publish Plan 表达。

如果用户需要选择或剔除包内具体 dataset，内容和 hash 会发生变化，必须先回到 Release Candidate Workflow 执行依赖与反向影响分析、冻结 scope decision、重跑完整验证并生成新 Candidate。Publication 不在执行阶段临时过滤数据。
