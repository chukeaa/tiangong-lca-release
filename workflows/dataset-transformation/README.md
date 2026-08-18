---
title: Dataset Transformation Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要从已有数据集或计算结果生成新的派生数据时
whenToUpdate:
  - 当支持的变换机制、字段声明、验证或输出类型变化时
checkPaths:
  - workflows/dataset-transformation/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined model-space and result-space transformation semantics for confirmation."
related:
  - AGENTS.md
  - ../../README.md
---

# Dataset Transformation Workflow

## 目标

帮助用户把一个仍然模糊的变换意图逐步变成可审查、可复现、可验证的派生数据，而不是让语言模型直接修改 JSON 或计算数值。

第一批重点场景是：选择多个数据集，按用户声明的权重形成一个新数据集，并说明新 Process、LifecycleModel 或 Result 中的重要字段如何产生。

## 两种不同机制

### 模型空间组合

输入 Unit Process 或 LifecycleModel，形成新的模型结构。

```text
输入数据集 + 权重 + 功能单位 + 模型边界
  -> 新 LifecycleModel，或经过额外证明的新 Unit Process
  -> 重新验证引用闭合
  -> 如需结果，再进入 Calculation Workflow
```

它会改变模型和引用关系，不能只对已有 LCIA 数值做平均。

### 结果空间聚合

输入已完成计算且兼容的 LCI/LCIA 结果，执行线性组合。

```text
兼容的 Calculation Result + 权重
  -> Derived Result
```

它要求功能单位、Flow identity、direction、unit、方法 ID/version 和缺失因子政策兼容。它不能冒充原始 Unit Process。

## 主路线

```text
选择精确输入
  -> 记录自然语言意图
  -> Agent 提出候选机制和待确认问题
  -> 用户确认权重依据、功能单位和输出类型
  -> 声明重要字段的来源与填写方式
  -> 冻结 Transformation Spec
  -> 确定性执行
  -> TIDAS/引用/数值验证
  -> 生成派生产物和血缘报告
```

## 字段声明

每个重要字段都应说明：

- 目标字段；
- 值或生成规则；
- 来源是用户声明、从输入继承还是确定性派生；
- 多个输入冲突时的处理方式；
- 为什么该值适合新数据集；
- 哪项验证能够发现错误。

第一版不提供任意 JSON Patch。字段声明应经过目标 TIDAS schema 和领域规则验证。

## 主要产物

- Transformation Draft：允许自然语言、假设和未决问题；
- Frozen Transformation Spec：精确输入、权重、规则、字段声明和输出身份；
- Derived Dataset Collection 或 Derived Result；
- transformation manifest；
- 输入/输出 hash、数值检查、schema 检查和血缘关系。

## 默认发布边界

派生数据默认只保存在 Release 本地工作区中，不自动写回远程 authoring tables，也不自动成为公共数据。

需要形成标准 Result Process/LifecycleModel 时，把冻结的派生产物交给 Result Materialization Workflow；经过 materialization 和验证后，canonical dataset collection 才进入 Release Workflow。未来如果确实需要“promote to authoring”，应作为单独设计，不隐藏在本 Workflow 中。

## 不属于本 Workflow

- 任意用户脚本或插件执行；
- LLM 直接生成最终数值；
- 修改远程源数据；
- 绕过 TIDAS 或引用验证；
- 将计算结果组装为正式 Result Process/LifecycleModel；
- 正式发布授权。

## 待确认点

1. 第一版是否只实现模型空间的加权组合，并把结果空间聚合留到第二步？
2. 加权组合默认应输出 LifecycleModel，还是由用户每次选择 LifecycleModel/Unit Process？
3. 多语言名称、地理、时间、技术和来源字段，哪些必须逐项人工确认？
