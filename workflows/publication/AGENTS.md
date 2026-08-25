---
title: Publication Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Candidate-bound Publication 规划时
whenToUpdate:
  - 当 Publication 的范围、状态、授权、写入、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: d34113a7087e90f52e367f1cd02e166e367dc629
lastReviewedNote: "Established deterministic local scope planning and retained a fail-closed remote execution boundary."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

## 当前职责

- 只消费不可变、未授权且带 hash-bound Publication catalog 的 Release Candidate v2；
- 帮助用户选择 Unit Process、Result、Both 或精确 dataset roots；
- 用 Candidate catalog 确定性计算 forward dependency closure；
- 对显式排除递归计算 reverse dependents，并把所有剪枝原因写入 resolution；
- 冻结 request、resolution 和 `publicationAuthorized=false` 的 prepared Publish Plan；
- 明确披露远程 target inspection、approval、execution 和 readback 尚不可用。

## Representation Decision

- Publication Scope Request：F2 半结构化用户投影，可在生成计划前重新表达；
- Publication Scope Resolution：F3 稳定确定性证据，生成后不可原地修改；
- prepared Publish Plan：F4 审计边界，绑定 Candidate/request/resolution/target intent，始终未授权；
- future approval、execution receipt、independent readback：F4，只有平台契约确认后才实现。

任何重新选择都生成新的输出目录和新的 artifacts，不覆盖已有计划。

## 可自动执行

- 只读核对 Candidate manifest、index、catalog 和 package bytes；
- 解析 component preset 和 exact include/exclude；
- 计算正向闭包、反向剪枝和最终集合；
- 写出本地 immutable planning artifacts；
- 返回有界 JSON、人类摘要、恢复动作和 workflow-local reply template。

## 必须 fail closed

- Candidate 不是 v2、已授权或缺少 Publication catalog；
- Candidate、Package Plan、index、catalog 或 ZIP hash/size 漂移；
- exact identity 不存在或不属于所选 component；
- required reference target 缺失；
- exclude 不属于当前请求闭包；
- include/exclude 冲突；
- 剪枝后集合为空或仍有不完整 required references；
- 输出目录已经存在。

## 当前禁止

- 修改、删除、补写或重新打包 Candidate；
- 把纯 Publication scope 选择解释为新 Candidate；
- 修改 dataset content、UUID 或 Version；
- 猜测 target fingerprint、平台现状或 published state code；
- 生成 approval、调用远程写接口、转换状态或声称发布完成；
- 把 transport success 当作 Publication 或 independent readback success；
- 使用 service-role、secret、mutable `latest` 或未验证的远程 identity。

## 下一实现门槛

增加 target inspection 或 remote execution 之前，必须单独确认并测试：

- actor-scoped target read/write interface；
- UUID + Version 的 exact-content 一致、缺失和冲突分类；
- semantic `published` 到具体 state code 的 adapter mapping；
- mixed insert/state-transition 的事务和原子性；
- approval subject hash、expiry、actor 和 replay protection；
- retry/idempotency、partial failure recovery 和 independent readback。

## 完成条件

本地 Publication planning 只有在以下条件同时成立时完成：

- Candidate 全部绑定证据重新验证；
- effective set 非空且 required-reference complete；
- 自动 additions/pruning 及原因完整保存；
- request、resolution 和 plan 原子写入新目录；
- plan 明确 `publicationAuthorized=false`、target inspection pending、execution unavailable；
- 用户回复没有暗示远程发布已经发生。
