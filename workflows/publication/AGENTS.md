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
  - 当 Agent 发布 Portal LCIA V3 package 或 finalize/verify/revoke public projection 时
whenToUpdate:
  - 当 Publication 的范围、状态、授权、写入、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-30
lastReviewedCommit: a45cd93413f2459fd5eaacf6b24643859b033206
lastReviewedNote: "Reviewed for Release #59: Portal LCIA keeps strict Plan/Event artifacts while Agent reply guidance is grouped into three F1 communication semantics."
related:
  - README.md
  - ../AGENTS.md
---

# Publication Workflow Agent Contract

## 职责

- Candidate dataset recipe 只消费不可变、未授权且带 hash-bound Publication catalog 的 Release Candidate v2；
- 解析 Unit Process、Result、Both 和 exact include/exclude；
- 计算 forward dependency closure 与 reverse-dependent pruning；
- 从 Candidate TIDAS ZIP 物化且仅物化最终选中数据；
- 以 actor-scoped session 检查 exact UUID + Version、canonical content、owner 和 state；
- 只允许用户批准精确 Executable Plan SHA-256；
- 对缺失 row 创建，对同内容 draft 切换状态，对已发布 row 幂等跳过；
- 用哈希链事件实现安全恢复，并用独立查询生成 Readback Receipt。
- 通过显式 opt-in 的 Portal LCIA projection recipe，先按 exact Database publish-plan hash 发布具备 Worker prepared typed projection 的 V3 LCIA package，再绑定、独立回读或撤回 public projection；不读取 private artifact locator。

## Representation Decision

- Scope Request：F2；
- Scope Resolution、Payload Manifest、Target Snapshot：F3；
- Draft Plan、Executable Plan、Approval、Execution Intent/Event/Receipt、Readback Receipt：F4。
- Portal LCIA Package Publication Plan 与 Projection Plan：F4 授权边界；统一 Portal LCIA Lifecycle Event：F3/F4 严格、只追加的恢复与终态观察。Event 只保存 immutable parent hash、目标、actor、精确主体和该阶段新增观察，不复制完整上游 evidence，不保存临时 RPC response hash、远端 URL 或 artifact locator；Database publication/projection 状态仍是权威真相。
- Portal LCIA 回复模板：F1 Agent 表达指导，只按 Plan prepared、Lifecycle result、Command failed 三种沟通语义分组；exact truth 继续来自 CLI JSON 与 Plan/Event artifact，不为每个命令复制字段契约。

F4 artifact 必须拒绝未知字段、绑定所有上游 hash，并保存在新的输出目录。Execution events 是唯一例外：同一 execution 目录中只追加有序、前向 hash-linked 文件，不修改旧 event。

## 自动执行边界

- Candidate、catalog、package 和 payload 校验是只读操作；
- Target Inspection 和 Readback 是 actor-scoped 只读远程操作；
- 只有未过期 Approval 严格绑定当前 Plan/Payload/Snapshot 且 target precondition 通过后，才可调用远程写接口；
- 远程执行只使用 `app_dataset_create`、`save_lifecycle_model_bundle` 和 `app_dataset_publish`；
- Portal LCIA projection 只调用 Database-owned `api.qry_portal_lcia_result_package_publish_prepare_v1`、`api.cmd_portal_lcia_result_package_publish_v1`、`api.qry_portal_lcia_projection_prepare_v1`、`api.cmd_portal_lcia_projection_finalize_publication_v1`、`api.qry_portal_lcia_projection_publication_readback_v1` 和 `api.cmd_portal_lcia_projection_revoke_publication_v1`；所有 PostgREST RPC 请求显式选择 `Content-Profile: api`；package publish、projection finalize、revoke 分别要求 exact Package Plan、Projection Plan、finalized Event SHA-256 confirmation；
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
- Projection prepare/finalize/readback 的 exact publication、package version/result hash、projection content/evidence/axis hash、row count 或 source published timestamp 不一致；
- Package publication 的 exact package/projection/artifact hash、Process-set、display default、current-publication 前置条件或 Database `publishPlanHash` 漂移；
- Projection source publication 已 supersede/unpublish、binding 已 revoked，或 finalize 后缺少一轮新的 current readback；
- Projection readback 不是同时 `isCurrent=true` 与 `isPubliclyVisible=true`；
- finalize/revoke transport outcome 不确定且 exact readback 不能安全调和。

## 禁止

- 修改 Candidate 或把纯选择解释为新 Candidate；
- 在 Publication 内修改、聚合或重算 dataset；
- 把平台四 ZIP release control-plane `tiangong.release.publish-plan.v1` 与本 Workflow Draft/Executable Plan 混用；
- 绕过 exact plan-hash confirmation；
- 在失败后删除或覆盖 event 以伪造整洁历史；
- 声称多请求远程写入具有平台未提供的全局事务原子性；
- 把 execute transport success 当作独立回读成功。
- 从 private Storage/S3 下载 projection artifact、持久化 locator，或让 Portal projection recipe 改写既有 Candidate Publication payload/state。

## 完成条件

Publication 只有在以下条件全部满足时完成：

- effective set 引用完整且 payload 只含该集合；
- target inspection 无 blocker；
- Approval 精确绑定 Executable Plan 且执行时有效；
- 每个 approved identity 有 completed event；
- Execution Receipt 覆盖全部 identities；
- 新的一轮 actor-scoped 查询验证全部 canonical content hash 和 published state；
- Readback Receipt `status=verified`。

Portal LCIA projection recipe 只有在 exact Package Publication Plan 已确认且 package-published Event 已通过独立 prepare 回读、exact Projection Plan 已确认、idempotent finalize 成功、projection-verified Event 来自独立 readback 且同时验证 publication/package/content/evidence/count、`isCurrent=true` 和 `isPubliclyVisible=true` 后完成。Revoke 只有在 exact finalized Event 已确认且 revoked Event 来自独立 `revoked`、`isPubliclyVisible=false` 回读后完成。Supersede/unpublish 必须使后续 verification fail closed。
