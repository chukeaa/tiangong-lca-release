---
title: Publication Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Candidate-bound Publication 时
whenToUpdate:
  - 当 Publication 的范围、状态、授权、写入、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: 1a9c21f4e66b4a3a8e949dde88404cc9fc562e98
lastReviewedNote: "Established complete Candidate-bound planning, approval, resumable execution, and independent readback contracts."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

## 职责

- 只消费不可变、未授权且带 hash-bound Publication catalog 的 Release Candidate v2；
- 解析 Unit Process、Result、Both 和 exact include/exclude；
- 计算 forward dependency closure 与 reverse-dependent pruning；
- 从 Candidate TIDAS ZIP 物化且仅物化最终选中数据；
- 以 actor-scoped session 检查 exact UUID + Version、canonical content、owner 和 state；
- 只允许用户批准精确 Executable Plan SHA-256；
- 对缺失 row 创建，对同内容 draft 切换状态，对已发布 row 幂等跳过；
- 用哈希链事件实现安全恢复，并用独立查询生成 Readback Receipt。

## Representation Decision

- Scope Request：F2；
- Scope Resolution、Payload Manifest、Target Snapshot：F3；
- Draft Plan、Executable Plan、Approval、Execution Intent/Event/Receipt、Readback Receipt：F4。

F4 artifact 必须拒绝未知字段、绑定所有上游 hash，并保存在新的输出目录。Execution events 是唯一例外：同一 execution 目录中只追加有序、前向 hash-linked 文件，不修改旧 event。

## 自动执行边界

- Candidate、catalog、package 和 payload 校验是只读操作；
- Target Inspection 和 Readback 是 actor-scoped 只读远程操作；
- 只有未过期 Approval 严格绑定当前 Plan/Payload/Snapshot 且 target precondition 通过后，才可调用远程写接口；
- 远程执行只使用 `app_dataset_create`、`save_lifecycle_model_bundle` 和 `app_dataset_publish`；
- 不接受、读取或建议 service-role secret。

## 必须 fail closed

- Candidate、plan、payload、snapshot、approval 或 event chain hash 漂移；
- unknown identity、component mismatch、引用缺失、剪枝后空集合；
- TIDAS ZIP 缺少选中 member、重复 member bytes 不一致或 payload content hash 不符；
- target 同 UUID + Version 内容冲突、不可见 owner、不可直接发布 state；
- Approval confirm hash 不匹配、过期、actor/target 改变；
- execute 前 target drift，或 create/publish 后 exact readback 不一致；
- 当前 execute adapter 收到非 `100` 的 published state code；
- independent readback 任一 identity 的 content/state 不一致。

## 禁止

- 修改 Candidate 或把纯选择解释为新 Candidate；
- 在 Publication 内修改、聚合或重算 dataset；
- 把平台四 ZIP release control-plane `tiangong.release.publish-plan.v1` 与本 Workflow Draft/Executable Plan 混用；
- 绕过 exact plan-hash confirmation；
- 在失败后删除或覆盖 event 以伪造整洁历史；
- 声称多请求远程写入具有平台未提供的全局事务原子性；
- 把 execute transport success 当作独立回读成功。

## 完成条件

Publication 只有在以下条件全部满足时完成：

- effective set 引用完整且 payload 只含该集合；
- target inspection 无 blocker；
- Approval 精确绑定 Executable Plan 且执行时有效；
- 每个 approved identity 有 completed event；
- Execution Receipt 覆盖全部 identities；
- 新的一轮 actor-scoped 查询验证全部 canonical content hash 和 published state；
- Readback Receipt `status=verified`。
