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

Release 先从冻结的 Materialization Intake 和 materialization 输出准备独立的 Release Intake，再由 Package build 只消费这个 Release Intake。两个 Intake 语义不同：前者证明结果生成时使用的输入，后者补齐独立分发所需的依赖；任何阶段都不得原地修改已冻结 manifest。

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

## 当前可执行入口

首个本地 Release Intake 与 Package route 已实现为 Workflow-local 薄 CLI：

```bash
cd workflows/release
npm install

node cli.mjs cache status --json

# 仅在状态为 missing/stale/invalid 且用户确认后显式刷新
node cli.mjs cache refresh --json

node cli.mjs intake prepare \
  --materialization /path/to/materialized-lifecycle-model \
  --source-intake /path/to/verified-materialization-intake \
  --out-dir /path/to/release-intake \
  --json

node cli.mjs package build \
  --release-intake /path/to/release-intake \
  --profile standalone-lifecyclemodel-result-full-closure.v1 \
  --release-version 2026.08.0 \
  --out-dir /path/to/release-candidate \
  --tidas-bin /path/to/tidas \
  --json
```

`--tidas-bin` 可省略，此时读取 `TIDAS_BIN`，再回退到 `PATH` 中的 `tidas`。命令先生成本地 package build，再用最终 ZIP 做 qualification；只有全部通过才形成 Candidate。整个动作不上传、不批准、也不发布。

如果省略 `--release-version`，命令不会开始构建，而是以 `release_version_confirmation_required` 返回按 Asia/Shanghai 当前年月生成的推荐版本（例如 `2026.08.0`）、四个预期文件名和专用回复模板。Agent 必须先请用户确认或替换版本号，再使用返回的 argv 带上 `--release-version` 重跑；显式传入版本号即表示该前置确认已经完成。

CLI 同时面向人和 Agent：默认输出简洁的 `Summary / Next / Reply using template`；`--json` 输出一个有界对象，包含 `outcome`、`completeness`、精确 artifact 路径、结构化 `nextActions[]` 和 workflow-local `replyTemplate`。未知或重复参数会被拒绝，失败时使用非零退出码，并提供错误代码、恢复动作和对应回复模板。

CLI 返回的自身命令以及返回 Result Materialization 的命令均使用绝对脚本入口，可从任意工作目录
执行。Release Intake 准备成功后会给出确定的本地 Candidate 目录；随后省略版本号的 `package build`
只触发版本确认，不开始构建。缓存模板直接引用 `nextActions.0.command`，不会把结构化对象原样展示给用户。

回复模板位于 `reply-templates/`，目前覆盖：

- ✅ 本地 Candidate 已构建并验证；
- ⚠️ ZIP 已生成但 qualification 未通过，失败构建已保留用于诊断；
- ⚠️ frozen input 与当前字节发生漂移；
- ❌ 参数、依赖、profile 或工具执行失败。

Agent 使用 CLI 返回的模板路径和 `requiredFacts` 填写回复。模板中的“成功”只表示本地候选构建完成，永远不表示已经批准、上传或发布。

`cache refresh` 是独立且需要显式执行的维护动作：通过 `CONN` 建立只读 repeatable-read snapshot，以单 SQL cursor 顺序下载全部已发布 Flow，在 Node 本地识别 Elementary Flow，并流式写入项目级共享缓存。缓存 manifest 记录内容 SHA-256、记录数以及数据库 watermark（已发布 Flow 数量与 `MAX(modified_at)`）。`cache status` 用一次轻量查询比较 watermark，并验证本地 artifact；因此能够区分 `fresh`、`missing`、`stale` 与 `invalid`。

`intake prepare` 不再隐式执行长时数据库下载。它只接受 fresh 缓存，扫描 source closure 中 LCIA Method 的 `characterisationFactors`，提取带精确 UUID/version 的 `referenceToFlowDataSet`，并从缓存匹配缺失的精确版本后冻结 dependency supplement。缓存缺失或过期会 fail closed，同时输出显式刷新命令。该过程不修改 Materialization Intake，也不把新增 Flow 误记为参与了原始计算。Release Intake manifest 只记录内容 hash；本地绝对路径单独保存在权限受限的 runtime locator 中，不进入可移植计划语义。

CLI 会自动加载 Release 仓根目录 ignored `.env` 中已有的 `CONN`。如尚未同步，先使用 Calculation Workflow 的 `environment sync` 将 workspace 根 `.env` 中允许的数据面变量补入 Release `.env`；Release Intake 不直接读取 workspace 根配置，也不会在输出中披露连接串。

执行过程：

```text
验证 Materialization Manifest + canonical-dataset-index
  -> 验证精确 Materialization Intake identity/hash
  -> 准备 Release Intake 并补齐 LCIA Method -> exact Flow
  -> 冻结 dependency expansion report
  -> Package build 重新验证 Release Intake 及两个上游 hash
  -> 从 source_closure + dependency supplement 组装数据集
  -> 生成完整 canonical-dataset-index
  -> 冻结 Package Plan
  -> 调用 tidas release build-packages
  -> 以正式数据库发行名称保存四个确定性 ZIP
  -> 逐包重新读取 ZIP member、隔离解压并执行 TIDAS/eILCD validation
  -> 保存 tidas report + package-verification-report
  -> 全部通过：冻结 publicationAuthorized=false 的 Release Candidate
  -> 任一失败：保留 failed build，不创建 Candidate
```

Release 只实现当前产品契约明确要求的 LCIA Method characterisation Flow 扩展，不复制通用闭包遍历。完整引用闭合、TIDAS/eILCD validation、schema-ordered conversion 和 semantic round-trip 仍由 `tidas-tools` 权威实现。Node 层验证交接证据、准备 Release Intake、组装本地 canonical input、执行有界 subprocess、核对四个 ZIP 并保存候选证据。

当前只支持 `standalone-lifecyclemodel-result-full-closure.v1`。Result Process-only materialization 会以 `package_profile_unsupported` 停止；只有未来 `tidas-tools` 增加并验证对应 profile 后才扩展。

内部 profile ID 用于闭包求解和机器验证，不作为独立分发文件名。外部产品名称按 LCA 数据库内容区分：`UnitProcessDatabase` 表示可继续建模的单元过程数据库，`ResultDatabase` 表示包含 LifecycleModel、LCI/LCIA Result Process 及其自包含依赖的结果数据库。显式 `--release-version` 同时进入 Package Plan、Candidate 和四个文件名，禁止 mutable `latest`。

打包完成后的验证以最终 ZIP 字节为输入，而不是复用 staging 结论。Workflow 先读取完整 member catalog 并拒绝空包、绝对路径和 `..` 路径，再隔离解压；两个 `.tidas.zip` 分别调用 `tidas release validate-tidas`，两个 `.ilcd.zip` 分别调用 `tidas release validate-ilcd`。任一归档无法读取、解压或验证时都不会冻结 Candidate，但已经生成的包和诊断证据不会删除。

Package build 与 Candidate qualification 是两个明确边界：生成 ZIP 只说明构建产物存在；TIDAS/eILCD 回读全部通过后，它们才具备成为 Candidate 的资格。失败时，用户请求的 Candidate 目录保持不存在，Workflow 将 staging 原子保留到同级唯一目录 `<candidate>.failed-<run-suffix>/`。该目录包含 `failed-package-build.json`、已有的四个 ZIP、`package-verification-report.json`（若已进入逐包验证）以及 `validation-readback/`。CLI 返回这些精确路径和查看命令，便于定位 schema、转换或数据字段问题；失败构建始终记录 `candidateCreated=false` 和 `publicationAuthorized=false`。

Candidate 目录包含：

```text
package-plan.json
canonical-dataset-index.json
tidas-release-report.json
package-verification-report.json
release-candidate.json
packages/                              # exactly four deterministic ZIPs
  TiangongLCA-<version>-UnitProcessDatabase.tidas.zip
  TiangongLCA-<version>-UnitProcessDatabase.ilcd.zip
  TiangongLCA-<version>-ResultDatabase.tidas.zip
  TiangongLCA-<version>-ResultDatabase.ilcd.zip
```

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
- 包已生成但 TIDAS/eILCD qualification 失败时，先检查 CLI 返回的 `failed-package-build.json` 和保留包，不要盲目重跑；修正数据后使用新的 Candidate 输出路径重新构建。
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

## 后续待确认点

1. 首版正式 Release 是否必须同时生成 TIDAS 和 ILCD？
2. Subset package 是否只允许本地下载，禁止成为全局公共 release？
3. Release 是否只接受完整通过的 materialization，还是允许把部分 candidate 保留为永不发布的本地预览？
