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
lastReviewedAt: 2026-08-29
lastReviewedCommit: 67a61471502eed31af70358f86dd22be0e350d8a
lastReviewedNote: "Reviewed full-closure selection and payload behavior under the root pnpm 11.24 workspace without changing publication authority."
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

这个 recipe 不属于上面的 Candidate dataset create/publish 执行链，也不会改变其 V1/V2 请求、artifact、signed download 或回读行为。它只编排 Database-owned actor RPC，并继续使用同一组 publishable-key + actor-session 环境变量；不接受 service-role，不读取或下载 private artifact，也不把 URL、bucket、object path 或 locator 写入 Plan/Receipt。

```text
ready V3 LCIA package + Worker prepared typed projection
  -> package publish prepare (read-only exact evidence/precondition)
  -> immutable Package Publication Plan + exact SHA-256 confirmation
  -> idempotent package publish + independent projection-prepare readback
  -> projection prepare from the verified Package Publication Receipt
  -> immutable Projection Plan + exact SHA-256 confirmation
  -> idempotent projection finalize
  -> immutable Finalization Receipt (readback still pending)
  -> independent projection verify
  -> current + publicly-visible Readback Receipt
```

### 1. 准备 exact V3 package publication plan

```bash
node workflows/publication/cli.mjs projection package-plan \
  --package-id <package-uuid> \
  --default-impact-category <impact-category-id> \
  --reason "publish Portal LCIA projection" \
  --out-dir .release/publication/<run>/package-publication-plan \
  --json
```

Database prepare 返回 locator-free exact evidence：package version/result/input/certificate/snapshot hash、projection ID/content/axis/grid/relation hash、五项 artifact hash、process/impact/value count、current Process-set hash、display default 和 current-publication 前置条件。Database 用同一 framing contract 计算 `publishPlanHash`。CLI 将完整响应、请求理由、actor 和 endpoint fingerprint 固定到 `portal-lcia-package-publication-plan.json`；Plan 明确记录 `packagePublicationAuthorized=false`。

### 2. exact confirmation 后发布 package 并独立回读

```bash
node workflows/publication/cli.mjs projection package-publish \
  --package-plan-dir .release/publication/<run>/package-publication-plan \
  --confirm <exact-local-package-publication-plan-sha256> \
  --out-dir .release/publication/<run>/package-publication \
  --json
```

CLI 写入前重新读取 prepare evidence；Database command 在 publication lock 内再次计算并要求 exact `publishPlanHash`。只有 exact audited success 可以幂等复用；已存在 non-current publication history、Process-set/current-publication/evidence drift 都是终态 conflict，不标记 `safeRetry`。若 response 在 commit 后丢失，CLI 只用相同 expected hash 做一次 idempotent retry，再通过 `api.qry_portal_lcia_projection_prepare_v1` 独立核对 publication/package/projection。Receipt 的 actor 与 reason 分别表示本次执行者和请求理由；`reasonPersistence` 明确区分首次记录、reused 未重写和 response-loss 后未知，不冒充远端原始审计值。

Package publish 会立即 supersede 旧 current publication，而新 projection 必须经过后续独立 confirmation/finalize/readback 才公开，两次远程写入没有跨 RPC 原子事务。两步之间 Portal LCIA 数值可以暂时 unavailable；绝不能让旧 projection 冒充新 publication。`package publication current / projection pending` 是由 Package Publication Receipt 表示的 durable partial state，CLI 返回 exact continuation。Workflow 不自动 unpublish 或回滚 package；若不能继续 finalize，必须由 operator 对精确 publication 做单独的恢复决定。

### 3. 从 verified package publication 准备 projection plan

```bash
node workflows/publication/cli.mjs projection prepare \
  --package-publication-dir .release/publication/<run>/package-publication \
  --out-dir .release/publication/<run>/projection-plan \
  --json
```

CLI 验证 Package Publication Plan/Receipt hash 链后重新调用 Database prepare。exact publication/package version/result hash、projection content/axis/grid/relation hash、count 和保留微秒精度的 source `publishedAt` 必须全部一致。Projection Plan 绑定 Package Publication Receipt SHA-256，并记录 `projectionFinalizationAuthorized=false`。

### 4. exact confirmation 后 finalize

```bash
node workflows/publication/cli.mjs projection finalize \
  --plan-dir .release/publication/<run>/projection-plan \
  --confirm <exact-projection-plan-sha256> \
  --out-dir .release/publication/<run>/projection-finalization \
  --json
```

CLI 在远程写入前重新执行 prepare 并逐项比较 evidence；publication/package/projection 任一漂移都会拒绝 finalize。幂等键由 exact projection/publication/package/content evidence 确定性生成，同一 Plan 可以安全重试。若 finalize 响应丢失，CLI 只在一轮新的 exact readback 已证明同一 binding 为 current/finalized 时生成 `reconciled_after_response_loss` Receipt；无法调和时返回 `safeRetry=true`，不猜测结果。

Finalization Receipt 固定 `independentReadbackVerified=false`，所以此时仍不能声称 Portal LCIA projection 闭环完成。

### 5. 独立验证公开终态

```bash
node workflows/publication/cli.mjs projection verify \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --out-dir .release/publication/<run>/projection-readback \
  --json
```

新的 actor-scoped readback 必须同时匹配 projection/publication/package identity、package version、projection content/evidence hash、process/impact/value count、finalized timestamp，并且 `status=finalized`、`isCurrent=true`、`isPubliclyVisible=true`。后两个布尔值都由匿名 RLS 使用的完整 public-visibility predicate 计算。Source publication 被 supersede/unpublish、projection 已 revoked、package/artifact/V3 invariant 漂移或 public predicate 失败时均 fail closed。

### 6. 精确撤回

```bash
node workflows/publication/cli.mjs projection revoke \
  --finalization-dir .release/publication/<run>/projection-finalization \
  --confirm <exact-finalization-receipt-sha256> \
  --reason "withdraw public projection" \
  --out-dir .release/publication/<run>/projection-revocation \
  --json
```

Revoke 只作用于 Receipt 绑定的 exact publication + projection content hash。命令本身幂等；成功响应或响应丢失后都必须再做独立 readback，只有 `status=revoked`、`isCurrent=false`、`isPubliclyVisible=false` 才生成 Revocation Receipt。Receipt 中的 `requestedReason` 是本次请求理由，`reasonPersistence` 明示 reused/response-loss 限制；Database audit 继续是远程权威记录。

### Projection 完成和非回归边界

- Package Publication Plan/Receipt 与 Projection Plan/Finalization/Readback/Revocation Receipt 全部使用 Draft 2020-12 strict schema，未知字段被拒绝；
- package publish 只新增 current public LCIA result publication，projection finalize 只新增 projection-publication binding；两者都不改 package/artifact bytes 或 Candidate dataset publication；
- supersession/unpublish 通过 Database current publication 事实即时使 projection 不再可验证/可见，不在本地伪造状态；
- transport success 不代表完成；只有 Projection Readback Receipt `status=verified` 才证明 current projection，只有 Revocation Receipt `status=revoked` 才证明撤回；
- 所有输出目录不可覆盖，Receipt locator-free，stdout 只返回有界 identity/hash/count 和本地 artifact path。
- 所有 Database RPC 通过 PostgREST `api` exposed schema 调用，并显式发送 `Content-Profile: api`；不依赖默认 `public` schema。
