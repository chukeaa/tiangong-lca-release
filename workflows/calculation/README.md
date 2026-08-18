---
title: Calculation Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户需要创建或接入 ResultSet、执行完整性验证、计算或下载结果时
whenToUpdate:
  - 当 Calculation 的入口、用户决定、远程能力或产物变化时
checkPaths:
  - workflows/calculation/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined the Calculation workflow for ResultSet, closure, calculation, and verified download."
related:
  - AGENTS.md
  - ../../README.md
---

# Calculation Workflow

## 目标

把用户的计算意图连接到现有 TianGong LCA 线上能力，并在本地留下可恢复、可验证的计算上下文和产物。

完成状态不是“所有步骤都执行过”，而是用户指定的计算结果已经由权威远程任务产生，所需产物已下载并通过完整性校验。

## 可以从哪里开始

- 只有一个新的计算意图和 ResultSet 名称；
- 已有 ResultSet；
- 已有 Closure Check；
- 已有 Closure Report/Certificate；
- 已有计算任务或 Worker Job；
- 已有 Result Package；
- 已有本地或远程 Calculation Bundle。

Workflow 首先识别当前入口，不能要求用户为了流程完整而重新创建已有对象。

## 主路线

```text
识别入口
  -> 创建或接入 ResultSet
  -> 确认 scope / LCIA methods
  -> 询问是否启动完整性验证
  -> 跟踪 Closure Check
  -> 展示报告和阻塞项
  -> 询问是否启动计算
  -> 跟踪计算任务
  -> 下载并验证 Calculation Bundle
```

每个箭头都是可恢复节点，不是强制 stage number。

## 需要用户决定的内容

- 新 ResultSet 的名称，或需要采用的精确 ResultSet；
- `global_eligible` 还是明确的数据集子集；
- LCIA 方法集；
- 是否启动线上完整性验证；
- 报告存在 warning 时是否继续处理、修复或停止；
- 是否启动线上计算；
- 下载哪些产品文件和审计证据。

## 主要产物

- ResultSet、Closure Check、Worker Job、Result Package 等远程资源引用；
- Closure 的有界摘要、完整机器结果引用和 certificate binding；
- Calculation Bundle 原始 manifest；
- manifest 声明的精确计算 artifacts；
- 下载大小、SHA-256、契约版本和来源证据；
- 当前可继续动作和阻塞原因。

## 失败与恢复

- 浏览器或终端退出不能使远程任务丢失；继续时按精确 ID 查询。
- Closure 运行失败与“Closure 发现数据问题”必须区分。
- Certificate 过期、scope 改变或依赖漂移时重新验证受影响范围。
- 计算任务失败不自动创建第二个任务；先读取权威终态和重试语义。
- 下载失败只重试下载，不重新计算；重新获取短期 URL 后再次校验。

## 不属于本 Workflow

- Worker 的矩阵构建、求解和数值算法；
- Database/Edge 的权限和任务状态实现；
- 对计算结果做加权、组合或字段重写；
- 把 Calculation Bundle 组装为 Result Process 或 LifecycleModel；
- 正式数据包发布。

三项分别进入 Dataset Transformation、Result Materialization 和 Release Workflow。

## 待确认点

1. Calculation Workflow 是否应同时支持 `global_eligible` 和用户指定 subset？
2. 新计算是否总是先创建 ResultSet，还是允许用户选择“只采用已有远程任务，不创建本地业务名称”？
3. 用户确认计算后，是默认等待完成并自动下载，还是先返回任务、由用户决定何时继续？
