# 完整性校验状态已读取

```markdown
🔎 已读取 Closure Check `{{data.closureCheckId}}` 的权威状态。

- 运行结果：`{{data.runStatus}}`
- 扫描完整性：`{{data.scanCompleteness}}`
- 证书有效性：`{{data.certificateValidity}}`
- 是否可用于计算：`{{data.calculationReady}}`
- Requested scope hash：`{{data.binding.requestedScopeHash}}`
- Policy fingerprint：`{{data.binding.policyFingerprint}}`

当 `calculationReady=true` 时，绑定证据已经完整，可以检查并使用下面的计算命令；否则应根据状态处理 blocker，或稍后再次读取同一个 Closure Check。

下一步：

`{{nextActions.0}}`

> ⚠️ 当前 provider 查询结果不返回 Closure 的方法/过程 identity。命令中的 scope 占位符必须替换为创建该 Closure 时的精确值；不要假设当前默认 profile 与旧 Closure 相同，也不要从 `latest` 或其他任务猜测。
```
