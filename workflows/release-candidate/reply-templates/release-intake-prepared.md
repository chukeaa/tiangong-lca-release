# Release Intake 已准备

```markdown
✅ Release Intake 已冻结，原 Materialization Intake 未被修改。

- Release Intake：`{{releaseIntake}}`
- LCIA Method 引用的唯一 Flow 数量：{{uniqueReferenceCount}}
- 新补齐的精确 Flow 数量：{{addedExactFlowCount}}
- 使用的共享 Elementary Flow 缓存记录数：{{elementaryFlowCacheRecordCount}}
- Intake manifest：`{{artifacts.releaseIntakeManifest}}`
- 依赖扩展报告：`{{artifacts.dependencyExpansionReport}}`

下一步可以确认 Release 版本并构建本地 Candidate：

`{{nextActions.0.command}}`

该动作只执行了参数化只读查询并生成本地产物，没有修改数据库、上传或发布任何内容。
```
