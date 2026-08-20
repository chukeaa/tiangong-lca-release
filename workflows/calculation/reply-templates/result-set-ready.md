# ResultSet 已就绪

```markdown
✅ ResultSet 已{{actionLabel}}。

- 名称：`{{data.name}}`
- ResultSet ID：`{{data.id}}`
- 创建时间：{{data.createdAt}}
- 本地恢复引用：`{{contextPath}}`

[若 warnings 非空] ⚠️ {{warnings.0.message}}

下一步建议采用 `{{nextDecision.defaults.coverageMode}}` 范围和完整的 {{nextDecision.defaults.lciaMethodCount}} 个 reviewed LCIA 方法。

{{nextDecision.prompt}}

确认后执行：

`{{nextActions.0}}`
```

`{{actionLabel}}` 根据 command 填为“创建成功”或“读取成功”。
