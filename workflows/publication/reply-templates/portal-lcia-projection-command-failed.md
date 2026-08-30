# Portal LCIA 投影命令失败

- 命令：`{{command}}`
- 错误代码：`{{error.code}}`
- 错误：{{error.message}}

下一步：

`{{nextActions.0.command}}`

不要删除或覆盖已有 Plan/Event。若错误详情标记 `safeRetry=true`，使用同一 exact Plan、confirmation 和幂等键重试；若未标记，先检查 publication/current/evidence 状态。网络失败可能发生在远程提交之后，不能仅凭 transport error 断言没有远程变化。
