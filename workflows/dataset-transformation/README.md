---
title: Dataset Transformation Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要基于 Release Candidate 中的精确数据进行再加工时
whenToUpdate:
  - 当支持的加工机制、输入输出契约、验证或返回路径得到确认时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Positioned Dataset Transformation as a deferred Candidate-derived refinement loop without predefining processing rules."
related:
  - AGENTS.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Dataset Transformation Workflow

## 当前定位

Dataset Transformation 是 Release Candidate 完成后的可选再加工入口。它用于从 Candidate 中选择精确 Process、LifecycleModel、Result 或其支持数据，经过后续确认的规则生成新的 canonical data，再构建新 Candidate。

```text
Release Candidate
  -> exact dataset selection
  -> Dataset Transformation
  -> transformed canonical data + lineage
  -> Release Candidate
```

如果变换使原有计算或 Result evidence 失效，返回路径改为：

```text
Dataset Transformation
  -> Calculation
  -> Result Materialization
  -> Release Candidate
```

## 已确认边界

- 原 Candidate 不可修改；
- 输入必须绑定父 Candidate hash 和精确 dataset identity/version/hash；
- 输出必须保存父 Candidate、选择范围和变换血缘；
- 输出必须经过与其语义影响匹配的确定性验证；
- 输出进入新的 Candidate，不替换或覆盖父 Candidate；
- 是否需要重新 Calculation/Result Materialization 必须由变换对模型和结果证据的影响决定。

## 尚未设计

本阶段不定义：

- 支持哪些 Process/LifecycleModel 修改；
- 支持哪些聚合或权重规则；
- 字段继承、冲突和缺失策略；
- Transformation Draft/Frozen Spec 的最终 schema；
- 数值执行器和 validator；
- workflow-local CLI；
- 哪些变换可以安全复用既有 Result evidence。

这些内容需要在后续单独跟踪的设计与实现任务中确认。在此之前，本 Workflow 不提供可执行变换能力。

## 预期产物边界

后续至少需要形成：

- 绑定父 Candidate 的 Transformation Intake；
- 可审查的变换需求和未决问题；
- 冻结后的确定性变换规格；
- transformed canonical datasets；
- validation 和 lineage evidence；
- 返回 Release Candidate 或 Calculation/Result Materialization 的明确判断。
