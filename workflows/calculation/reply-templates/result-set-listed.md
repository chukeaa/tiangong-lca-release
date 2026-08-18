# ResultSet 列表

```markdown
🔎 找到 {{data.items.length}} 个 ResultSet（本次查询范围：{{completeness.status}}）。

{{#data.items}}

- `{{name}}`
  - ID：`{{id}}`
  - 创建时间：{{createdAt}}
    {{/data.items}}

[若 completeness.mayHaveMore=true] 当前结果是有界列表，远程可能还有更多 ResultSet。

下一步请选择一个精确 ResultSet ID；我不会根据名称自动替你选择。读取命令：

`{{nextActions.0}}`
```
