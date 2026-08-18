---
title: Result Materialization Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Result Materialization Workflow 时
whenToUpdate:
  - 当 recipe、identity/version、metadata、reference、validation 或输出契约变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined the Agent contract for deterministic Process/LifecycleModel result materialization."
related:
  - README.md
  - ../AGENTS.md
---

# Result Materialization Workflow Agent Contract

## Agent 的职责

- 识别 Calculation Bundle、Derived Result 或已有 materialization artifact。
- 展示可用 recipe、已有证据和必须由用户决定的模型/metadata 问题。
- 冻结精确 Materialization Request。
- 调用确定性 identity、version、materializer 和 validator 实现。
- 保存 dataset collection、manifest、报告和血缘。
- 只把通过验证的 canonical dataset collection 交给 Release Workflow。

## 输入最低要求

- 精确输入 identity 和内容 hash；
- Calculation Bundle 或等价的 graph/LCI/LCIA/source closure evidence；
- recipe ID/version；
- quantitative reference evidence；
- metadata completion policy；
- previous Release Manifest 或显式首次生成决定。

缺少上述任一项时，不得从远程 mutable `latest` 或相似数据集猜测。

## Recipe 规则

- LCI Result Process、LCI + LCIA Result Process、LifecycleModel 是同一 Workflow 的 recipe。
- Recipe 必须声明输出 role、依赖、必需证据和 validator。
- LCIA recipe 必须包含或引用同一 Result Process 的完整 LCI 层。
- LifecycleModel recipe 必须同时绑定精确 Result Process identity/version。
- one-hop 只能作为显式 recipe，不能作为仓库全局默认。

## 身份与版本

- Identity 由稳定语义输入和 recipe profile 派生，不使用随机 UUID。
- 版本规划必须考虑 semantic hash、version-significant hash 和引用版本。
- 相互引用的数据集作为集合求解版本，不能分别生成后补引用。
- 相同 identity/version 的 canonical content 冲突必须 fail closed。
- 输入或 recipe 改变时，不得静默复用无效 materialization evidence。

## 可由 Agent 提出的内容

- 候选 recipe；
- metadata 字段草案；
- 缺失信息和可选来源；
- 版本变化解释；
- 验证失败的最早返回点。

Agent 提议不能替代用户对模型结构、重要 metadata 和首次 lineage 的决定。

## 硬边界

- 不重新求解 LCI/LCIA。
- 不执行用户业务加权或模型语义变换。
- 不改写源 Unit Process。
- 不生成只有 LCIA、没有有效 LCI/reference basis 的 Result Process。
- 不让 LifecycleModel 引用另一次 materialization 的未验证 Result Process。
- 不跳过 TIDAS、引用闭合和数值一致性验证。
- 不打包或远程发布。
- 不写入远程 authoring tables。

## 完成条件

完成的 materialization 必须产生冻结的 canonical dataset collection、dataset index、materialization manifest 和验证报告。每个输出都能追溯到精确输入、recipe、identity/version 决策和 validator evidence。
