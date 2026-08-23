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
lastReviewedAt: 2026-08-23
lastReviewedCommit: 04faf325d1f33912b0a92a511d0cb0fc2bb0fce1
lastReviewedNote: "Defined the default remote Elementary Flow cache transfer, credential, validation, and cleanup boundaries."
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

## 当前本地 Package 契约

- `intake prepare` 从不可变的 Materialization Intake 和完整 LifecycleModel materialization 生成独立 Release Intake；不得原地修改任一上游 manifest。
- Release Intake 按精确 UUID/version 补齐 LCIA Method characterisation factor 引用但 source closure 缺失的 Flow。常规 Intake 只消费项目级 Elementary Flow 缓存；以 published count 和 `MAX(modified_at)` 判断缓存 freshness，缺失或过期时 fail closed，并只提示显式刷新命令。缓存刷新必须使用有界、只读 snapshot，不得由 Intake 隐式触发。显式 `cache refresh` 默认把导出放到受管 Worker EC2 上执行：Release 通过 SSH stdin 传递本次进程内数据面配置，远端不落凭据文件；远端向同一 Supabase project 的 Storage 写入一小时有效的临时 gzip artifact，本地下载并逐条校验后先删除临时对象，再原子替换共享缓存。数据库与 Storage project binding 无法一致验证时必须 fail closed。
- 慢速本机数据库流式刷新只可通过显式 `--execution local` 使用；远端路径失败时不得静默降级。
- `package build` 只接受已准备并重新验证上游 hash 的 Release Intake，以及 `standalone-lifecyclemodel-result-full-closure.v1`。
- Result Materialization 的 Index 只描述新生成数据集；Release 从 source closure 与冻结的 dependency supplement 加入 Unit Process 和支持数据集，生成供 `tidas-tools` 使用的完整 Index。
- source closure artifact hash、record count、每条 document canonical hash，以及 materialized dataset bytes 必须在调用外部工具前重新验证。
- Package Plan 不记录机器绝对路径；它只绑定 manifest/index/bundle hashes 和 canonical input summary，保证换目录重放不改变计划语义。
- Release 只遍历当前契约明确声明的 LCIA Method -> Flow 依赖；通用引用闭合、TIDAS/eILCD validation、conversion、round-trip 和四包构建必须委托 `tidas-tools release build-packages`，不得在本 Workflow 重写。
- 委托前必须对所选 `TIDAS_BIN` 执行 `version` 与 `validate --describe` 握手，并精确要求已治理的 `tidas v0.2.0` 与 `document-validation-batch.v1`；不得用 PATH 中的旧二进制静默降级。
- Candidate 必须正好包含四个 ZIP、每个文件的 byte size/SHA-256、完整工具报告，并显式记录 `publicationAuthorized=false`。
- 四个分发包必须使用显式 release version 和产品级数据库名称；内部 profile ID 只保留在机器证据中。每个最终 ZIP 必须在候选冻结前重新列举、隔离解压，并分别通过 TIDAS 或 eILCD validation。
- 用户未提供 release version 时，Agent 必须使用 CLI 返回的推荐版本和专用回复模板请求确认；确认前不得启动构建。不得把年月推荐值或 mutable `latest` 当作用户已确认。
- 输出目录不可覆盖。只有四包回读校验全部通过才能原子提交可见 Candidate；包已经生成但 qualification 失败时，必须把 ZIP、结构化失败清单、已有验证报告和逐包回读目录保留为唯一 sibling failed build，并明确 `candidateCreated=false`、`publicationAuthorized=false`。它是诊断产物，不是 Candidate，也不得被发布。
- `tidas release build-packages --format json` 非零退出时，必须把有界 stdout 解析为结构化 operation report 并写入 failed-build diagnostics；只有 stdout 不是有效 JSON 时才保留有界文本尾部。不得只保留 stderr 而丢失字段级 validation evidence。
- CLI 的人类输出必须包含有界 `Summary / Next / Reply using template`；JSON 输出必须保持单对象、可解析，并携带 `outcome`、`completeness`、artifact 引用、`nextActions[]` 和 `replyTemplate`。
- cache refresh 的 CLI 输出和错误不得包含连接串、S3 secret 或 presigned URL。成功结果可以披露 execution mode 与 SSH host，但不能披露临时 object locator。
- CLI 返回的自身命令和跨 Result Materialization 命令必须使用由 `import.meta.url` 生成的绝对入口，确保从任意 cwd 可复制执行。Release Intake 准备成功后应返回确定的 Candidate 输出目录，不把 `<CANDIDATE_DIR>` 留给 Agent 猜测。
- CLI 必须拒绝未知和重复参数。失败使用非零退出码，并区分人类可读 stderr 与 `--json` 结构化 stderr。
- Agent 回复必须读取 CLI 指定的 workflow-local 模板，以真实字段替换占位符；不得把 Candidate build 回复成批准、上传或发布完成。

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
