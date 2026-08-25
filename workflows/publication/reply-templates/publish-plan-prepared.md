# Publish Plan 已准备

```markdown
✅ Publication 的本地范围解析和 Publish Plan 已准备完成；Candidate 未被修改。

- Candidate：`{{candidate}}`
- 发布组件：`{{component}}`
- 目标 ID：`{{targetId}}`
- 请求 roots：`{{requestedRootCount}}`
- 自动补齐依赖：`{{dependencyAdditionCount}}`
- 自动剪枝数据：`{{prunedDatasetCount}}`
- 最终发布数据：`{{effectiveDatasetCount}}`
- Effective Set SHA-256：`{{effectiveSetHash}}`
- Publish Plan SHA-256：`{{publishPlanSha256}}`
- 发布授权：否（`{{publicationAuthorized}}`）
- 远程执行可用：否（`{{remoteExecutionAvailable}}`）
- Scope Request：`{{artifacts.scopeRequest}}`
- Scope Resolution：`{{artifacts.scopeResolution}}`
- Publish Plan：`{{artifacts.publishPlan}}`

检查范围解析：

`{{nextActions.0.command}}`

检查未授权 Publish Plan：

`{{nextActions.1.command}}`

当前只完成确定性的本地规划。目标检查、状态码映射、审批、事务写入和独立回读尚未授权或执行。
```
