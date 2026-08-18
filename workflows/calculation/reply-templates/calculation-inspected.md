# 计算任务状态已读取

```markdown
🔎 已从数据库任务投影读取 Job `{{data.jobId}}` 的权威状态。

- Worker 状态：`{{data.workerStatus}}`
- Domain 状态：`{{data.domainStatus}}`
- Domain validity：`{{data.domainValidity}}`
- 当前阶段：`{{data.phase}}`
- 进度：`{{data.progressFraction}}`
- Result Package：`{{data.resultPackageId}}`
- 是否终态：`{{data.terminal}}`
- 是否建议查询 Worker 日志：`{{data.diagnosticsRecommended}}`

下一步：

`{{nextActions.0}}`

当“是否建议查询 Worker 日志”为 `false` 时，不需要把 Worker 日志作为常规状态来源；继续读取数据库任务状态即可。
```
