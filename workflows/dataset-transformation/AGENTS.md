---
title: Dataset Transformation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 评估或设计 Candidate-derived Dataset Transformation 时
whenToUpdate:
  - 当 Transformation 的规则、契约、执行器、验证或返回路径得到确认时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Kept the Workflow fail closed while detailed Candidate-derived transformation rules remain deferred."
related:
  - README.md
  - ../AGENTS.md
---

# Dataset Transformation Workflow Agent Contract

## 当前阶段

本 Workflow 只有高层边界，没有已确认的加工规则、Frozen Spec schema、执行器或 CLI。Agent 可以检查 Candidate、整理用户目标和列出设计问题，但不得声称已经能够执行数据变换。

## 当前允许的动作

- 只读检查父 Candidate 和精确 dataset identity/version/hash；
- 帮助用户选择需要再加工的数据；
- 记录自然语言目标、来源证据和未决问题；
- 判断拟议变换是否可能使既有 Result evidence 失效；
- 建议后续进入专门的 Transformation 设计任务。

## 当前硬边界

- 不原地修改 Candidate；
- 不直接编辑 Candidate ZIP 或 canonical dataset bytes；
- 不让 Agent 自行生成最终数值、聚合结果或发布数据；
- 不在规则尚未确认时执行任意脚本、表达式或字段 patch；
- 不把修改后的 Process/LifecycleModel 与旧 Result evidence 重新打包，除非后续确定性验证明确证明仍然有效；
- 不写入远程 authoring 或 published tables。

## 进入实现的前提

必须通过单独跟踪的设计任务确认输入输出契约、支持的变换、结果有效性判断、验证器、恢复和用户确认边界，才能增加执行代码。
