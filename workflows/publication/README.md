---
title: Publication Workflow
docType: workflow
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当用户准备从不可变 Release Candidate 选择本次发布范围时
  - 当需要生成依赖闭合、尚未授权的 Publish Plan 时
whenToUpdate:
  - 当发布选择、目标差异、状态转换、写入、审批、恢复或回读规则变化时
checkPaths:
  - workflows/publication/**
lastReviewedAt: 2026-08-25
lastReviewedCommit: d34113a7087e90f52e367f1cd02e166e367dc629
lastReviewedNote: "Implemented deterministic Candidate-bound scope planning while keeping remote target mutation fail closed."
related:
  - AGENTS.md
  - ../release-candidate/README.md
  - ../../README.md
---

# Publication Workflow

Publication 消费不可变 Release Candidate，负责本次发布范围、目标检查、精确授权、平台写入和独立回读。当前已实现确定性的本地范围规划；远程目标检查、审批和执行仍保持 fail closed。

```text
Release Candidate v2
  -> Publication Scope Request
  -> dependency expansion + reverse pruning
  -> Publication Scope Resolution
  -> prepared, unauthorized Publish Plan
  -> future Target Inspection
  -> future Approval
  -> future Execute + Independent Readback
```

## 当前已实现

Workflow-local CLI：

```bash
npm --prefix workflows/publication ci
node workflows/publication/cli.mjs plan prepare --help
```

`plan prepare`：

- 重新验证 Candidate manifest、Package Plan、canonical dataset index、Publication catalog 和四个 ZIP 的 hash/size；
- 接受 `unit-process`、`result` 或 `both` component；
- 可用重复的 `--include <datasetType:uuid@version>` 指定精确发布 roots；
- 可用重复的 `--exclude <datasetType:uuid@version>` 指定剔除对象；
- 从 roots 递归补齐所有 required forward dependencies；
- 从显式排除对象递归剪枝所有会因此引用不完整的 reverse dependents；
- 移除剪枝后不再从存活 roots 可达的数据；
- 对未知 identity、component mismatch、包或 catalog 漂移、缺失引用和空结果 fail closed；
- 原子写出三个不可变本地产物。

```text
publication-scope-request.json
publication-scope-resolution.json
publish-plan.json
```

Publish Plan 始终记录：

```json
{
  "status": "prepared_unapproved",
  "publicationAuthorized": false,
  "target": {
    "inspectionStatus": "pending_contract",
    "publishedState": { "semantic": "published", "code": null }
  },
  "execution": { "status": "unavailable" }
}
```

这表示范围规划完成，不表示批准、上传、写入或发布完成。

## 范围语义

Candidate 保持原样；Publication Plan 只引用其中的精确数据子集。

- 未提供 `--include` 时，component 的全部 roots 是请求 roots；
- 提供 `--include` 时，它替代 component 默认 roots；
- forward dependency expansion 自动加入解释所选 roots 所需的精确数据；
- 显式排除一个数据集时，所有直接或间接依赖它的已选数据集都被剪枝；
- 最终集合必须非空且 required references 完整；
- request、resolution 和 effective set 都以 canonical hash 绑定 Candidate。

纯选择、补齐和剪枝不产生新 Candidate。以下动作会改变数据内容，必须返回 Dataset Transformation、Result Materialization 或 Release Candidate：

- 修改 Process/LifecycleModel 字段或数值；
- 聚合、重算或改变 provider/quantitative reference；
- 改变 UUID、Version 或 dataset bytes；
- 修复 Candidate 数据；
- 重新生成新的分发包。

## Candidate handoff

Release Candidate v2 新增 hash-bound `publication-catalog.json`。它在 Candidate 构建仍持有 canonical bytes 时生成，记录：

- 每个 dataset 的 exact identity、role、path 和内容 hash；
- required closure references；
- Unit Process 和 Result component 的 roots/effective set；
- catalog set hash 和 canonical index hash。

Publication 不依赖上游 mutable 路径，也不从 ZIP 文件名或 `latest` 猜测闭包。旧 Candidate v1 没有此证据，必须重新构建为 v2 才能进入 `plan prepare`。

## 下一阶段待设计

本轮尚不定义或执行：

- target snapshot/fingerprint 的 actor-scoped 读取协议；
- UUID + Version 已存在且内容一致、缺失、内容冲突的分类 adapter；
- 实际 published state code；领域契约只使用语义状态 `published`；
- approval artifact、批准人和撤销/过期规则；
- staging、事务、原子 promotion、幂等和恢复；
- 正式 Publication Receipt 和 independent readback；
- 任何远程写入或状态转换。

下一阶段必须先冻结 Target Inspection 与冲突分类契约，再让 prepared Publish Plan 晋升为可审批执行计划。

## 示例

```bash
node workflows/publication/cli.mjs plan prepare \
  --candidate .release/candidates/<candidate> \
  --component both \
  --target tiangong-lca-platform \
  --out-dir .release/publication/plans/<plan> \
  --json
```

选择一个 Result root 并排除一个精确依赖：

```bash
node workflows/publication/cli.mjs plan prepare \
  --candidate .release/candidates/<candidate> \
  --component result \
  --target tiangong-lca-platform \
  --include lifecyclemodel:<uuid>@01.00.000 \
  --exclude process:<uuid>@01.00.000 \
  --out-dir .release/publication/plans/<plan> \
  --json
```
