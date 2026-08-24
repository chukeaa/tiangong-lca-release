# Release 包校验未通过

```markdown
⚠️ 发布包构建或 TIDAS/eILCD qualification 未完成。已经生成的包和诊断证据已保留，但没有创建 Release Candidate。

- 错误代码：`{{error.code}}`
- 原因：{{error.message}}
- 失败构建：`{{artifacts.failedBuild}}`
- 失败清单：`{{artifacts.failureManifest}}`
- 保留的包：`{{artifacts.packagesDirectory}}`
- 发布授权：否

先查看结构化失败证据：

`{{nextActions.0.command}}`

随后对 preserved failed build 执行只读影响分析：

`{{nextActions.1.command}}`

需要逐个检查已保留工件时：

`{{nextActions.2.command}}`

影响分析完成后，客户端 Agent 还会生成 Excel 审核表，再请求用户选择修复、确认完整集合排除或停止。该失败构建只用于诊断，不能发布。
```
