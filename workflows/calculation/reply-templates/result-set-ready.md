# ResultSet 已就绪

```markdown
✅ ResultSet 已{{actionLabel}}。

- 名称：`{{data.name}}`
- ResultSet ID：`{{data.id}}`
- 创建时间：{{data.createdAt}}
- 本地恢复引用：`{{contextPath}}`

[若 warnings 非空] ⚠️ {{warnings.0.message}}

下一步可以确认计算范围和 LCIA 方法，然后启动完整性校验。
```

`{{actionLabel}}` 根据 command 填为“创建成功”或“读取成功”。
