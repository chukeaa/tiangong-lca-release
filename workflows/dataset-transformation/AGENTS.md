---
title: Dataset Transformation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Dataset Transformation Workflow 时
whenToUpdate:
  - 当变换机制、用户决定、执行器、验证或输出边界变化时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined Transformation Agent draft, freeze, execution, and validation boundaries."
related:
  - README.md
  - ../AGENTS.md
---

# Dataset Transformation Workflow Agent Contract

## Agent 的职责

- 帮助用户澄清“组合模型”还是“聚合结果”。
- 保留假设、未决问题和字段来源，不把它们压缩成一个模糊配置。
- 只在精确输入和用户决定齐备后冻结执行规格。
- 把数值和文档变换交给确定性实现。
- 输出验证证据、派生血缘和后续可用动作。
- 将需要标准 Process/LifecycleModel 的冻结输出交给 Result Materialization Workflow。

## 草案与执行规格

- Draft 可以使用自然语言，必须标明 source refs 和 unresolved questions。
- Frozen Spec 必须版本化，并绑定精确输入 identity/version/hash。
- Frozen Spec 改变后产生新 revision；不得悄悄覆盖已执行规格。
- 用户批准 Draft 不等于授权公共发布。

## 加权组合最低要求

- 至少两个精确输入；
- 每个输入有有限、非负且有依据的权重；
- 明确 normalization；
- 明确功能单位或结果 reference basis；
- 明确输出类型；
- 明确字段冲突和缺失策略；
- 明确 identity/version 规则；
- 数值、unit、Flow 和方法兼容性通过确定性检查。

## 硬边界

- 不执行任意 shell、JavaScript、Python 或用户表达式。
- 不使用任意 JSON Patch 作为领域变换契约。
- 不把 result aggregation 输出描述为原始 Unit Process。
- 不在没有功能单位和 reference flow 的情况下生成 Unit Process。
- 不自动写入远程 authoring tables。
- 不在 Transformation 执行中临时生成发布用 Result Process 或 LifecycleModel。
- 不让同一个 Agent 输出的解释充当数值正确性证明。

## 完成条件

用户请求的派生数据已经生成并验证，或 Workflow 留下明确 blocker。输出必须能够追溯到每个输入、权重、字段决定、执行器版本和验证报告。
