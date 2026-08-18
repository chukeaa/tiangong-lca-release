# 可用的 Calculation Bundle 已列出

```markdown
✅ 已从数据库任务投影发现候选 Package，并逐一验证当前 actor 是否可以读取对应的 Calculation Bundle。

- 可用 Bundle 数量：`{{completeness.returned}}`
- 扫描 Calculation 任务数：`{{completeness.lookup.tasksScanned}}`
- 候选 Package 数：`{{completeness.lookup.candidatePackages}}`
- 排除 Package 数：`{{completeness.lookup.excludedPackages}}`
- 列表完整性：`{{completeness.status}}`

可用 Bundle：

{{data.items}}

[若存在 warnings] 注意：`{{warnings}}`

下一步：

`{{nextActions.0}}`

选择 Bundle 时使用精确 `packageId`；列表未输出或持久化短期 signed URL。
```
