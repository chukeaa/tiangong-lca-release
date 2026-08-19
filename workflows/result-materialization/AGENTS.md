---
title: Result Materialization Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Result Materialization Workflow 时
whenToUpdate:
  - 当 recipe、identity/version、metadata、reference、validation 或输出契约变化时
checkPaths:
  - workflows/result-materialization/**
lastReviewedAt: 2026-08-19
lastReviewedCommit: 9adfbf11942428fba306360c264e9a39d27a4f3e
lastReviewedNote: "Reviewed the executable contract against the conceptual Result Process and LifecycleModel design."
related:
  - README.md
  - design/result-process-and-lifecycle-model.md
  - ../AGENTS.md
---

# Result Materialization Workflow Agent Contract

## 本地验证

运行 `npm --prefix workflows/result-materialization test` 验证本 Workflow；仓库根目录的 `npm test` 已包含该命令。

## Agent 的职责

- 识别 Calculation Bundle、Derived Result 或已有 materialization artifact。
- 展示可用 recipe、已有证据和必须由用户决定的模型/metadata 问题。
- 冻结精确 Materialization Request。
- 冻结 requested roots、最终输出类型、Result layer、required Result set 和 direct-edge evidence。
- 调用确定性 identity、version、materializer 和 validator 实现。
- 先冻结 Result Catalog，再使用精确 provider Result references 组合 LifecycleModel。
- 保存 dataset collection、manifest、报告和血缘。
- 只把通过验证的 canonical dataset collection 交给 Release Workflow。
- Worker Calculation Bundle v2 的 content hash 必须在原始 canonical manifest bytes 上移除顶层 `bundleContentHash` 后验证；不得先把任意 JSON number 转成 JavaScript `number` 再重序列化，因为超出安全整数范围时会改变证据字节。

## 输入最低要求

- 精确输入 identity 和内容 hash；
- Calculation Bundle 或等价的 graph/LCI/LCIA/source closure evidence；
- recipe ID/version；
- quantitative reference evidence；
- metadata completion policy；
- previous Release Manifest 或显式首次生成决定。

缺少上述任一项时，不得从远程 mutable `latest` 或相似数据集猜测。

## Recipe 规则

- LCI Result Process、LCI + LCIA Result Process、LifecycleModel 是同一 Workflow 的 recipe；LifecycleModel 本身不含 LCI/LCIA 数值，`resultProcessLayer` 只控制它引用的 resulting/dependency Result Process。
- Recipe 必须声明输出 role、依赖、必需证据和 validator。
- 公开入口必须先收敛 `scope + outputType + resultProcessLayer`；内部 Result/Model 两阶段不得要求用户手动串联。
- `materialize-result` 和 `compose-model` 只是一个 `materialize` 请求内的执行节点，不得作为需要用户先后运行的公开工作流呈现。
- `result-process` 只物化 requested roots，不自动扩展 provider；`lifecycle-model` 才扩展 direct provider Results 并在同一次动作中生成 Model。
- `lifecycle-model` 的主要对象是 requested-root `M(P)`；内部 `R(P)` 标记为 resulting、`R(Q)` 标记为 dependency，且不得自动生成 provider `M(Q)`。
- 主数据集、resulting Result 和 dependency Result 必须分别标记并分别计数。
- LCIA recipe 必须包含或引用同一 Result Process 的完整 LCI 层。
- LifecycleModel recipe 必须同时绑定精确 Result Process identity/version。
- 首版 LifecycleModel recipe 使用 `resolved-one-hop-aggregated-background.v1` 组合 profile，并遵守 `design/result-process-and-lifecycle-model.md`。
- 每条有效 direct provider edge 对应一个引用聚合 `R(Q)` 的 provider process instance；不得只用 root `U(P)` 包装聚合 `R(P)`。
- one-hop 是 LifecycleModel recipe 的显式 profile，不得被隐式套用到不生成 LifecycleModel 的 Result-only recipe。

## 身份与版本

- Identity 由稳定语义输入和 recipe profile 派生，不使用随机 UUID。
- Generated `R(P)` UUIDv5 name 只包含 `U(P)` UUID 和 reference flow UUID，不包含 schema/version 字段，也不依赖 `M(P)` UUID、Result profile、方法集或结果内容；算法与 namespace 只保存在外层 identity evidence。
- 版本规划必须考虑 semantic hash、version-significant hash 和引用版本。
- 先统一解析并冻结 Result UUID/version set，再生成绑定精确 `R(Q)`/`R(P)` references 的 Model version set。
- 同一 Result UUID lineage 可以包含多个 exact source Process revisions；每个 revision 必须获得独立 dataset version，并由 process index/source provenance 精确绑定，不能按 UUID 折叠。
- previous manifest 按 exact source Process UUID@version 匹配 Result variant；新增 revision 按确定性顺序使用未占用的 major version。
- 相互引用的数据集作为集合求解版本，不能分别生成后查询 mutable `latest` 补引用。
- 相同 identity/version 的 canonical content 冲突必须 fail closed。
- 同一 exact source revision 重复出现、Result version 碰撞或同一 identity/version 内容冲突必须 fail closed。
- 输入或 recipe 改变时，不得静默复用无效 materialization evidence。

## Quantitative-reference pivot

- 不得假设 quantitative reference 为 Output；Input/Output、正负 amount 都必须保持 Worker 的 signed normalization 语义。
- 新 Calculation Bundle 必须从 process-axis v2 读取 raw direction/amount、signed coefficient、normalization scale 和 normalized coefficient，并与 exact source closure 交叉验证。
- 旧 Bundle 只允许从 intake 已校验的 exact source-closure Process 回推 pivot；不得查询数据库、mutable latest 或相似版本，并必须在 descriptor 中记录 legacy fallback evidence。
- `R(P)` reference exchange 保留 raw direction、使用 normalized amount；`M(P)` 根 `U(P)` instance 使用 normalization scale。

## 可由 Agent 提出的内容

- 候选 recipe；
- metadata 字段草案；
- 缺失信息和可选来源；
- 版本变化解释；
- 验证失败的最早返回点。

Agent 提议不能替代用户对模型结构、重要 metadata 和首次 lineage 的决定。

## 硬边界

- 不重新求解 LCI/LCIA。
- 不执行用户业务加权或模型语义变换。
- 不改写源 Unit Process。
- 不生成只有 LCIA、没有有效 LCI/reference basis 的 Result Process。
- 不让 LifecycleModel 引用另一次 materialization 的未验证 Result Process。
- 不忽略有效 direct provider edge，也不从源 Process 文本猜测 provider connection 或 factor。
- 不跳过 TIDAS、引用闭合和数值一致性验证。
- 不打包或远程发布。
- 不写入远程 authoring tables。

## 完成条件

完成的 materialization 必须产生冻结的 selection、Result Catalog、canonical dataset collection、dataset index、materialization manifest 和验证报告。每个输出都能追溯到精确输入、recipe、direct edge、identity/version 决策和 validator evidence；每个 one-hop Model 必须在冻结容差内重构对应 Result Process。
