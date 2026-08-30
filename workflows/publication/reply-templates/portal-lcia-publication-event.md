# Portal LCIA 生命周期结果

- 命令：`{{command}}`
- 结果：`{{outcome}}`
- 完整性：`{{completeness}}`
- Event：`{{artifacts}}`
- 下一步：`{{nextActions}}`

根据 `completeness` 准确说明当前是中间状态、公开验证完成还是撤回完成。回复时从 CLI JSON 选择足以识别本次结果的 exact identity 和 Event SHA-256；有下一步时逐字提供，终态时不要虚构后续动作。Package publish 后 projection 可能暂时 unavailable，finalize 后仍须独立回读，只有 verified/revoked Event 才能声明相应终态。
