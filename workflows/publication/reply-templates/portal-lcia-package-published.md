# Portal LCIA V3 Package 已发布并回读

- Publication：`{{publicationId}}`
- Package：`{{packageId}}` / `{{packageVersion}}`
- Package Result SHA-256：`{{packageResultHash}}`
- Projection：`{{projectionId}}`
- Projection Content SHA-256：`{{projectionContentHash}}`
- 网格：`{{processCount}} × {{impactCount}} = {{valueCount}}`
- 结果：`{{disposition}}`
- 请求理由持久化语义：`{{reasonPersistence}}`
- 已完成独立回读：`{{independentlyReadBack}}`
- Package-published Event SHA-256：`{{packagePublishedEventSha256}}`
- Event：`{{artifacts.packagePublishedEvent}}`

Package publication 已由 exact Database publish-plan hash 约束并通过 projection prepare 独立回读。下一步：

当前是 durable partial state：旧 publication 已 supersede，而新 projection 尚未 finalize；Portal LCIA 数值可以暂时 unavailable。

`{{nextActions.0.command}}`
