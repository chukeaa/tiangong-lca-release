# Portal LCIA V3 Package 发布计划已准备

- Package：`{{packageId}}` / `{{packageVersion}}`
- Package Result SHA-256：`{{packageResultHash}}`
- Projection：`{{projectionId}}`
- Projection Content SHA-256：`{{projectionContentHash}}`
- 网格：`{{processCount}} × {{impactCount}} = {{valueCount}}`
- Database Publish Plan SHA-256：`{{databasePublishPlanHash}}`
- Display Default Impact：`{{displayDefaultImpactCategory}}`
- 请求理由：`{{requestedReason}}`
- 当前 publication 前置条件：`{{currentPublicationPrecondition}}`
- Local Plan SHA-256：`{{packagePublicationPlanSha256}}`
- 已授权 publish：`{{packagePublicationAuthorized}}`
- Plan：`{{artifacts.packagePublicationPlan}}`

Plan 已绑定 locator-free package/projection/artifact hash、Process-set 和 current-publication 前置条件。下一步只执行 CLI 返回的 exact-confirm 命令：

`{{nextActions.0.command}}`
