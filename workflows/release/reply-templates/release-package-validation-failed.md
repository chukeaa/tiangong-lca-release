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

需要逐个检查已生成包时：

`{{nextActions.1.command}}`

修正源数据后应使用新的 Candidate 输出路径重新构建；该失败构建只用于诊断，不能发布。
```
