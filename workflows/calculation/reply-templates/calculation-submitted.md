# 计算任务已提交

```markdown
🚀 计算任务已提交，计算结果尚未确认生成。

- Worker Job ID：`{{data.jobId}}`
- 身份完整性：`{{data.identityCompleteness}}`
  [若 data.resourceId 非空] - Build/Package 资源 ID：`{{data.resourceId}}`
  [若 data.resourceId 为空] - Result Package：尚未 materialize
- 当前状态：`{{data.status}}`
- 是否复用已有任务：{{data.reused}}
- 计算范围：`{{data.effectiveInput.coverageMode}}`
- LCIA 方法：`{{data.effectiveInput.lciaMethods.0.id}}@{{data.effectiveInput.lciaMethods.0.version}}`

🔎 下一步可以观察任务状态，或从 workspace 根目录查询 Worker 日志：

`{{nextActions.0}}`
```
