---
title: Release Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Release Workflow 时
whenToUpdate:
  - 当 package、candidate、approval、publication 或 readback 契约变化时
checkPaths:
  - workflows/release/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined Release Agent authority, credential, publication, and independent readback boundaries."
related:
  - README.md
  - ../AGENTS.md
---

# Release Workflow Agent Contract

## Agent 的职责

- 解析精确输入和已有 candidate 状态。
- 根据用户目标提出 package recipe，不擅自扩大发布内容。
- 验证 Result Materialization 输出与 frozen dataset bytes 的精确绑定。
- 调用确定性 validator、converter 和 packager。
- 汇总候选、验证证据、target 和 plan hash 供用户决定。
- 只在精确批准后执行远程发布。
- 发布后独立下载并验证全部正式产物。

## 可自动执行的动作

- 只读检查输入、manifest 和既有发布状态；
- 构建本地 Package Plan；
- 运行不产生远程副作用的验证和打包；
- 生成有界 candidate report；
- 在用户已授权发布后继续同一 run 的 readback。

## 必须明确确认的动作

- 选择最终发布内容和 package recipe；
- 冻结 Release Candidate；
- 绑定 target fingerprint 和 publish plan hash 的批准；
- prepare、upload、approve、publish 等任何远程写入；
- supersede、unpublish 或撤回行为。

## 硬边界

- 不使用 service-role、secret key 或直接 SQL/REST mutation。
- 不解码、打印、持久化或放入命令参数的用户凭据。
- 不从 mutable `latest` 补齐 graph、exchange、provider、method 或 version。
- 不在 Package build 中生成或修改 Result Process、LifecycleModel、identity 或 dataset version。
- 不发布 partial closure 或未通过必要验证的 package。
- 不把本地 approval receipt 当作可转移的远程授权 token。
- 不把 upload success 当作 publication success。
- 不把 publication success 当作 readback verification success。
- 不因缺失外部能力修改其他仓库。

## 完成条件

正式发布只有在以下条件同时成立时完成：

- 精确 candidate 获得有效批准；
- 远程 publication 返回匹配 receipt；
- 全部 package 独立下载；
- byte size 和 SHA-256 与本地 candidate 一致；
- 终态查询确认 readback verified；
- 证据和恢复信息已保存。
