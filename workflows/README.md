---
title: Release Workflows 导航
docType: index
scope: workflows
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当需要选择或组合一个 Release Workflow 时
whenToUpdate:
  - 当顶层 Workflow 新增、删除、重命名或重新划分时
checkPaths:
  - workflows/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: ae317c02e73e9e3d14e6aa5e8aa4685b80d1cb8a
lastReviewedNote: "Reframed candidate preparation and publication as separate top-level Workflow boundaries."
related:
  - ../README.md
  - AGENTS.md
---

# Workflows

本目录是 Release 项目的主要入口，不是脚本集合。

| Workflow                                                   | 解决的问题                                                 | 主要输出                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| [Calculation](calculation/README.md)                       | 从 ResultSet/Closure/任务接入，完成验证、计算与下载        | Closure evidence、Calculation Bundle                              |
| [Result Materialization](result-materialization/README.md) | 将冻结结果组装为标准 Process/LifecycleModel                | Canonical datasets、identity/version plan、manifest               |
| [Release Candidate](release-candidate/README.md)           | 准备闭合输入，验证、打包并冻结不可变 Candidate             | Release Intake、Package Plan、Scope Decision、Candidate           |
| [Dataset Transformation](dataset-transformation/README.md) | 对 Candidate 中的精确数据执行后续定义的可追溯再加工        | Transformation evidence、transformed canonical datasets           |
| [Publication](publication/README.md)                       | 消费不可变 Candidate，经过精确授权后写入平台并确认发布终态 | Publish Plan、approval、publication receipt、independent readback |

默认主线是 `Calculation -> Result Materialization -> Release Candidate`。Candidate 完成后可以直接进入 Publication，也可以经依赖闭合的范围收缩生成新 Candidate，或进入 Dataset Transformation 再加工后生成新 Candidate。任何分支都不得原地修改已有 Candidate。

Agent 进入具体 Workflow 前，先读取：

1. 根目录 `README.md`；
2. 本目录 `AGENTS.md`；
3. 目标 Workflow 的 `AGENTS.md`；
4. 目标 Workflow 的 `README.md`。
