---
title: Release Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要组织、验证、打包、审批或发布冻结的数据产品时
whenToUpdate:
  - 当包的语义、候选构建、审批、发布或回读边界变化时
checkPaths:
  - workflows/release/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined package, candidate, approval, publication, and readback semantics for confirmation."
related:
  - AGENTS.md
  - ../../README.md
---

# Release Workflow

## 目标

把精确、冻结并具备必要证据的输入组织成可审查的 Release Candidate，在人工授权后完成远程发布，并用独立回读证明远程字节与本地候选一致。

这个 Workflow 不负责产生原始计算结果、组装 Result Process/LifecycleModel，也不修复源数据。

## 可以从哪里开始

- Result Materialization Workflow 生成并验证的 canonical dataset collection；
- 对应的 dataset index、materialization manifest 和 validation report；
- 作为审计附件的 Calculation Bundle 或 Transformation Manifest；
- 已有 Package Plan 或尚未发布的 Release Candidate；
- 已发布但尚未完成独立 readback 的 release run。

## 输入契约

Release 必须消费冻结的 materialization 输出，而不是在 Package build 中临时生成或修改数据集。

输入至少包括：

- canonical dataset collection；
- dataset index；
- materialization manifest；
- identity/version plan 引用；
- TIDAS、引用闭合和 numerical parity evidence；
- 每个 dataset role、UUID、version 和 canonical content hash。

Materialization evidence 与实际 dataset bytes 不一致时，返回 Result Materialization Workflow 修复。

## 包的组织维度

Package 不应由大量互斥枚举硬编码，而是由经过验证的 recipe 组合以下维度：

- Root：Unit Process、LifecycleModel、Result Process；
- Result layer：无结果、LCI、LCI + LCIA；
- Closure：引用式或 full self-contained；
- Format：TIDAS、ILCD；
- Grouping：合并包或每个 root 独立包。

第一批候选 recipe：

1. Unit Process + 完整支持闭合，不含计算结果；
2. LifecycleModel + Unit Process 闭合；
3. LifecycleModel + Result Process + LCI + 完整闭合；
4. LifecycleModel + Result Process + LCI + LCIA + 完整闭合；
5. 独立 Calculation/Validation Evidence 包。

具体支持矩阵必须经过 TIDAS/ILCD 语义验证，不能仅因为配置可以表达就允许构建。

## 主路线

```text
选择冻结输入
  -> 选择或生成 Package Recipe
  -> 构造 Package Plan
  -> TIDAS validation
  -> ILCD conversion / validation
  -> semantic round-trip / package closure / cross-package consistency
  -> deterministic package build
  -> Release Candidate
  -> 人工确认精确 target + plan hash
  -> prepare / upload / finalize / approve / publish
  -> independent readback
```

Package build 是本 Workflow 的子过程，不是独立顶层 Workflow。

## 人工审批

审批必须绑定：

- 精确 Release Candidate；
- package hash 集合；
- release manifest 和 publish plan hash；
- target ID 和 target fingerprint；
- 决定人、理由和可选有效期。

查看候选、表示建议、作出决定、授权发布和执行发布是不同动作。

## 失败与恢复

- 本地验证失败返回到拥有错误输入或 recipe 的最早节点。
- 上传或发布失败只在同一不可变 candidate 和幂等 identity 上恢复。
- 发布成功但 readback 失败时，状态不能标记为完成。
- 远程 metadata、package bytes 或 target 漂移时 fail closed。
- 一个通过的正式发布不能通过重跑旧打包步骤被静默改变。

## 不属于本 Workflow

- 创建或修复远程源数据；
- Worker 求解；
- 未冻结的语义探索；
- 生成或修改 Result Process、LifecycleModel、identity 或 dataset version；
- 把派生数据写回 authoring tables；
- 使用 service-role 或直接 SQL 发布。

## 待确认点

1. 首版正式 Release 是否必须同时生成 TIDAS 和 ILCD？
2. 首版是否保留“固定四包”作为一个 recipe，还是立即支持上述五类独立 recipe？
3. Subset package 是否只允许本地下载，禁止成为全局公共 release？
4. Release 是否只接受完整通过的 materialization，还是允许把部分 candidate 保留为永不发布的本地预览？
