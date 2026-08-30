---
title: Publication Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户准备从不可变 Release Candidate 选择并发布 Unit Process、Result 或 Both 时
  - 当需要执行目标检查、精确批准、平台发布或独立回读时
whenToUpdate:
  - 当发布选择、目标差异、状态转换、写入、审批、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-30
lastReviewedCommit: 9c3fb05a04ba7f3722ea8dd81f00179c722a6737
lastReviewedNote: "Reviewed for Release #59: Portal LCIA retains exact authorization and independent readback with a reduced Plan/Event representation."
related:
  - AGENTS.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Publication Workflow

Publication 消费不可变 Release Candidate v2，在不修改 Candidate 的前提下完成选择、精确载荷物化、目标检查、明确批准、远程发布和独立回读。它还提供一个独立、显式 opt-in 的 Portal LCIA projection recipe：先按 Database-computed exact plan hash 发布具备 prepared typed projection 的 V3 LCIA package，再 finalize、独立验证或撤回公开 projection binding。

```text
Release Candidate v2
  -> Scope Request + dependency-safe Resolution
  -> Publication Draft Plan (未授权)
  -> exact selected TIDAS payload
  -> actor-scoped Target Snapshot
  -> Publication Executable Plan (未授权)
  -> exact plan-hash Approval
  -> resumable create/state-transition execution
  -> independent content/state readback
```

Dataset Transformation 不属于本 Workflow。任何 Process/LifeCycleModel 内容修改、规则聚合、UUID/Version 改变或重新计算，都必须先产生新的 Candidate，再进入 Publication。

## 发布语义

用户首先选择 `unit-process`、`result` 或 `both`，并可用 exact identity 缩小范围。

- exact identity 格式：`<datasetType>:<uuid>@<version>`；
- `--include` 替代 component 默认 roots，并自动补齐 forward dependencies；
- `--exclude` 剔除指定数据，同时递归剔除所有因此引用不完整的 reverse dependents；
- 最终集合必须非空、完全来自 Candidate，且 required references 完整；
- 纯选择不会形成新 Candidate。

目标平台按 UUID + Version + canonical content hash 分类：

- 不存在：创建精确 Candidate 数据，然后切换到发布态；
- 已存在且内容相同、尚未发布：不覆盖内容，只切换状态；
- 已存在且内容相同、已经发布：幂等 no-op；
- 已存在但内容不同、当前 actor 无发布权、或处于不可直接发布状态：在批准前 fail closed。

当前平台 `app_dataset_publish` 固定写入 `state_code=100`。Workflow 把它绑定为 `{semantic: "published", code: 100}`；未来平台迁移到例如 `120` 时必须升级状态 adapter 和对应测试，不能只改文档或批准文件。

## CLI 完整流程

安装并查看帮助：

```bash
pnpm install --frozen-lockfile
node workflows/publication/cli.mjs --help
```

### 1. 准备范围

```bash
node workflows/publication/cli.mjs plan prepare \
  --candidate .release/candidates/<candidate> \
  --component both \
  --target tiangong-lca-platform \
  --out-dir .release/publication/<run>/plan \
  --json
```

可重复使用 `--include` / `--exclude`。输出：

```text
publication-scope-request.json
publication-scope-resolution.json
publication-draft-plan.json
```

这里使用 `publication-draft-plan.v1`，避免与平台已有、用于四个 Release ZIP 的 `tiangong.release.publish-plan.v1` 发生 schema 名称碰撞。

### 2. 物化精确载荷

```bash
node workflows/publication/cli.mjs payload materialize \
  --candidate .release/candidates/<candidate> \
  --plan-dir .release/publication/<run>/plan \
  --out-dir .release/publication/<run>/payload \
  --json
```

该命令重新验证 Candidate 与两个 TIDAS ZIP，只提取 resolution 中的精确成员；相同数据同时出现在 Unit/Result ZIP 时必须具有完全相同 bytes。输出 `publication-payload-manifest.json` 和 `datasets/`，被剪枝的数据不会进入载荷。

### 3. 检查目标并形成可执行计划

远程命令只接受 actor-scoped session：

```text
TIANGONG_LCA_API_BASE_URL
TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY
TIANGONG_LCA_ACCESS_TOKEN 或 TIANGONG_LCA_API_KEY
```

禁止使用 service-role secret。

```bash
node workflows/publication/cli.mjs target inspect \
  --plan-dir .release/publication/<run>/plan \
  --payload-dir .release/publication/<run>/payload \
  --published-state-code 100 \
  --out-dir .release/publication/<run>/inspection \
  --json
```

输出 `publication-target-snapshot.json` 和 `publication-executable-plan.json`。Snapshot 绑定 actor、目标 endpoint 指纹、每个 UUID + Version 的内容/状态分类和整体 fingerprint；Executable Plan 仍记录 `publicationAuthorized=false`。

### 4. 批准精确计划

```bash
node workflows/publication/cli.mjs approval create \
  --inspection-dir .release/publication/<run>/inspection \
  --confirm <executable-plan-sha256> \
  --approved-by <stable-actor-id> \
  --expires-at 2026-08-25T10:00:00Z \
  --reason "approved release scope" \
  --out-dir .release/publication/<run>/approval \
  --json
```

`--confirm` 必须逐字符等于 CLI 返回的 Executable Plan SHA-256。Approval 绑定 Draft Plan、payload、target snapshot、fingerprint、状态 mapping、批准人和过期时间；任一上游 artifact 漂移都会失效。

### 5. 执行发布

```bash
node workflows/publication/cli.mjs publish execute \
  --approval-dir .release/publication/<run>/approval \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/execution \
  --json
```

执行前会重新检查目标。第一次执行要求和批准快照一致；恢复执行允许已经由同一执行产生、内容正确的 draft/published row。执行使用平台 `app_dataset_create`、`save_lifecycle_model_bundle` 和 `app_dataset_publish`，每个 identity 完成后重新读取内容和状态。

平台没有跨多个 Edge Function 请求的一次性事务，因此 Workflow 不声称全局 atomic。它使用：

- 固定 Approval/Plan/Payload hash；
- `publication-execution-intent.json` 防止目录被其他计划复用；
- `events/000001.json...` 哈希链记录 started/success/failure；
- 每次恢复重新读取远端，只跳过已经验证完成的 identity；
- `publication-execution-receipt.json` 只在全部 identities 完成后生成。

如果失败，保留同一个 `--out-dir` 重试即可。CLI 会报告已完成和失败 identity，不会扩大范围或删除远端数据。

### 6. 独立回读

```bash
node workflows/publication/cli.mjs readback verify \
  --execution-dir .release/publication/<run>/execution \
  --payload-dir .release/publication/<run>/payload \
  --out-dir .release/publication/<run>/readback \
  --json
```

该命令发起一轮新的 exact REST 查询，不复用 execute 的响应。每个 UUID + Version 都必须同时满足 canonical content hash 和 published state code；全部通过后写出不可变 `publication-readback-receipt.json`，此时 Publication 才完整结束。

## 权限和可见性边界

- `app_dataset_publish` 当前只允许 dataset owner 直接发布；目标检查会对可见 draft 校验 owner。
- Actor-scoped REST 可能看不到其他用户的私有同键数据。此时检查会把它视为 absent，创建时平台唯一约束仍会 fail closed；已经完成的其他 identity 会保留在执行事件中并可恢复，不做破坏性回滚。
- 当前状态 adapter 只执行 code `100`；传入其他 code 可以用于检查/计划，但 execute 会在任何写入前拒绝，直到平台写接口正式支持该 code。
- Transport `ok` 不代表完成；只有独立 Readback Receipt 的 `status=verified` 表示 Publication 完成。

## 主要契约

- Scope Request：F2 用户选择投影；
- Scope Resolution、Payload Manifest、Target Snapshot：F3 稳定、hash-bound 证据；
- Draft Plan、Executable Plan、Approval、Execution Intent/Event/Receipt、Readback Receipt：F4 严格审计与授权边界；
- 所有计划、批准和终态 receipt 都不可原地覆盖；Execution event 只追加。

## Portal LCIA projection recipe

这个显式 opt-in recipe 不属于 Candidate dataset create/publish 链，也不改变 V1/V2 请求、artifact、signed download 或回读行为。它只编排 Database-owned actor RPC，使用 publishable key + actor session；不接受 service-role，不读取 private artifact，也不把 URL、bucket、object path 或 locator 写入本地产物。

Database publication/projection 状态是远程权威真相。Release 只拥有三个本地契约：

- Package Publication Plan：F4，绑定 Database `publishPlanHash`、exact package/projection/artifact evidence、当前 Process set、current-publication 前置条件和请求理由；
- Projection Plan：F4，在 package publish 后绑定 exact publication、projection evidence、source `publishedAt` 和 idempotency key；
- Lifecycle Event：严格、只追加的恢复/终态观察，统一表达 `package_published`、`projection_finalized`、`projection_verified`、`projection_revoked`。

Lifecycle Event 只记录 immutable parent artifact SHA-256、target、actor、精确 subject 和该阶段新增 observation。它不复制完整上游 package/projection/artifact evidence，也不保存临时 prepare/publish/readback response body hash。

```text
ready V3 LCIA package + Worker prepared typed projection
  -> Package Publication Plan + exact confirmation
  -> idempotent package publish + independent projection-prepare readback
  -> package_published Event
  -> Projection Plan + exact confirmation
  -> idempotent finalize
  -> projection_finalized Event
  -> independent current + publicly-visible readback
  -> projection_verified Event
```

### 1. 准备并确认 V3 package publication

```bash
node workflows/publication/cli.mjs projection package-plan \
  --package-id <package-uuid> \
  --default-impact-category <impact-category-id> \
  --reason "publish Portal LCIA projection" \
  --out-dir .release/publication/<run>/package-publication-plan \
  --json

node workflows/publication/cli.mjs projection package-publish \
  --package-plan-dir .release/publication/<run>/package-publication-plan \
  --confirm <exact-local-package-publication-plan-sha256> \
  --out-dir .release/publication/<run>/package-publication \
  --json
```

Prepare 是只读操作。写入前 CLI 重新读取 exact evidence；Database 在 publication lock 内重新计算并要求相同 `publishPlanHash`。Commit 后 response 丢失时，只允许相同 expected hash 的幂等 retry，再以 `api.qry_portal_lcia_projection_prepare_v1` 独立核对 publication/package/projection。

Package publish 会立即 supersede 旧 current publication，而新 projection 尚未 finalize。这个 durable partial state 由 `package_published` Event 表示；两步之间 Portal LCIA 数值可以暂时 unavailable，但旧 projection 不能冒充新 publication。

### 2. 准备并确认 projection finalize

```bash
node workflows/publication/cli.mjs projection prepare \
  --package-publication-dir .release/publication/<run>/package-publication \
  --out-dir .release/publication/<run>/projection-plan \
  --json

node workflows/publication/cli.mjs projection finalize \
  --plan-dir .release/publication/<run>/projection-plan \
  --confirm <exact-projection-plan-sha256> \
  --out-dir .release/publication/<run>/projection-finalization \
  --json
```

Projection Plan 绑定 `package_published` Event SHA-256，并冻结 Database 返回的 exact publication/package/projection evidence。Finalize 前重新 prepare；任一 identity、version、content/evidence/axis/count 或 source timestamp 漂移都会拒绝写入。Finalize response 丢失时，只有新的 exact readback 已证明同一 binding 为 current/finalized，才生成 `projection_finalized` Event；否则返回可重试状态，不猜测结果。

`projection_finalized` 仍记录 `independentReadbackVerified=false`，所以此时不能声称公开投影闭环完成。

### 3. 独立验证公开终态

```bash
node workflows/publication/cli.mjs projection verify \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --out-dir .release/publication/<run>/projection-readback \
  --json
```

新的 actor-scoped readback 必须匹配 exact projection/publication/package identity、package version、projection content/evidence hash、process/impact/value count 和 finalized timestamp，并同时满足 `status=finalized`、`isCurrent=true`、`isPubliclyVisible=true`。只有成功写出的 `projection_verified` Event 表示 Portal LCIA projection publication 完成。

### 4. 精确撤回

```bash
node workflows/publication/cli.mjs projection revoke \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --confirm <exact-finalized-event-sha256> \
  --reason "withdraw public projection" \
  --out-dir .release/publication/<run>/projection-revocation \
  --json
```

Revoke 只作用于 finalized Event 绑定的 exact publication + projection content hash。成功响应或 response loss 后都必须独立回读；只有 `status=revoked`、`isCurrent=false`、`isPubliclyVisible=false` 才生成 `projection_revoked` Event。请求理由的 `reasonPersistence` 区分首次记录、reused 未重写和 response-loss 后未知，Database audit 继续是理由持久化的权威记录。

### 完成和非回归边界

- 三个契约均使用 Draft 2020-12 strict schema，未知字段被拒绝；
- package publish 和 projection finalize 是两个独立远程写入，不虚构跨 RPC 事务；
- supersession/unpublish 通过 Database current-publication 事实即时使旧 projection 不再可验证/可见；
- transport success 不代表完成；verified/revoked Event 必须来自独立 readback；
- 所有输出目录不可覆盖，Plan/Event locator-free，stdout 只返回有界 identity/hash/count 和本地 artifact path；
- 所有 RPC 显式发送 `Content-Profile: api`，不依赖默认 `public` schema；
- recipe 不改 package/artifact bytes、Candidate dataset publication 或 private artifact ACL。
