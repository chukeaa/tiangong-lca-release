## ⚠️ Release 排除影响审核材料已准备

- 权威 JSON 报告：[查看报告]({{impactReport}})
- 报告 SHA-256：`{{impactReportSha256}}`
- Excel 审核表：[查看审核表]({{reviewWorkbook}})
- Excel SHA-256：`{{reviewWorkbookSha256}}`
- 初始错误数据集：`{{invalidDatasetCount}}`
- 受影响 Process roots：`{{affectedRootCount}}`
- 连带 Result/LifecycleModel：`{{affectedMaterializedDatasetCount}}`
- 失去可达性的 support datasets：`{{newlyUnreachableSupportDatasetCount}}`
- 完整建议排除集合：`{{excludedDatasetCount}}`
- 数据集数量：`{{originalDatasetCount}}` → `{{resultingDatasetCount}}`
- 剩余引用冲突：`{{remainingReferenceConflictCount}}`
- 当前是否允许排除：`{{safeToExclude}}`

请先查看 Excel 的 `Complete Exclusion Set` 工作表，然后选择：

1. **修复后重建（推荐）**：修复或重新选择精确上游版本，重新 Materialize 和构建。
2. **确认完整集合排除**：仅当 `safeToExclude=true` 时可选；必须确认 Excel 中的完整集合和上述报告 SHA-256，不能只跳过最初报错的文件。
3. **停止本次 Release**：保留 failed build 和审核证据，不创建 Candidate。

请明确回复选择及原因；在收到选择前，Agent 不记录范围决定，也不构建新的 Candidate。
