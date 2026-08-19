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
lastReviewedAt: 2026-08-19
lastReviewedCommit: 30d15cbc0e59a8160162100bb6c7ae879ee78030
lastReviewedNote: "Established four-workflow navigation with Result Materialization as the canonical dataset assembly boundary."
related:
  - ../README.md
  - AGENTS.md
---

# Workflows

本目录是 Release 项目的主要入口，不是脚本集合。

| Workflow                                                   | 解决的问题                                          | 主要输出                                                   |
| ---------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| [Calculation](calculation/README.md)                       | 从 ResultSet/Closure/任务接入，完成验证、计算与下载 | Closure evidence、Calculation Bundle                       |
| [Dataset Transformation](dataset-transformation/README.md) | 从已有数据或结果产生可追溯的派生数据                | Frozen transformation spec、派生数据集/结果                |
| [Result Materialization](result-materialization/README.md) | 将冻结结果组装为标准 Process/LifecycleModel         | Canonical datasets、identity/version plan、manifest        |
| [Release](release/README.md)                               | 验证、打包并正式发布 canonical dataset collection   | Package、Release Candidate、Publication、Readback evidence |

Agent 进入具体 Workflow 前，先读取：

1. 根目录 `README.md`；
2. 本目录 `AGENTS.md`；
3. 目标 Workflow 的 `AGENTS.md`；
4. 目标 Workflow 的 `README.md`。
