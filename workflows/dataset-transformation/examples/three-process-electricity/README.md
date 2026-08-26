# 三个相近 Process 的真实聚合试验

该试验使用本机已有、已通过 Release Candidate `2026.08.0` 验证的三个 Unit Process。三个数据集都是 2019 年、35–330 kV 的交流电生产组合，共享精确参考 Flow `890a70b7-b677-4e2a-8a1b-7d017e0a10ae@01.01.004`，参考 amount 均为 `3.6 MJ`：

| Process                                          | Geography | Weight |
| ------------------------------------------------ | --------- | -----: |
| `012fc8f6-9a30-4d98-9b03-34ddec3a6f10@01.01.002` | CN-HB     |    0.5 |
| `0277e7da-78c5-456d-b902-39a6aabd52fe@01.01.002` | CN-SN     |    0.3 |
| `03ae7e51-0820-4c7c-82aa-785c1fe2afd8@01.01.003` | CN-JS     |    0.2 |

第一次 inspect 返回 `needs_decision`，提出七组业务差异：`name`、`geography`、`technology`、`mathematicalRelations`、`dataSourcesAndRepresentativeness`、`commissionerAndGoal`、`annualVolume`。试验决定：

- 名称重写为“加权交流电生产”；
- geography 重写为 `CN`，并注明只是三省试验性组合；
- technology 重写为明确的 0.5/0.3/0.2 聚合说明；
- 空 mathematical relations 删除；
- 共同来源和委托信息从具有完整双语引用的湖北 Process 继承；
- 显式权重不能证明总年产量，因此 output annual volume 删除；
- review、uncertainty 和 allocations 重置。

第二次 inspect 为 `ready`，随后 Frozen Spec、执行和 TIDAS 完整验证均成功；从同一 Frozen Spec 重复执行还得到完全相同的 receipt、输出 bytes 和 canonical content hash。输出参考 amount 为 `1`，五类输入归一化聚合结果为：

| Flow UUID                              |    Amount |
| -------------------------------------- | --------: |
| `2a297e9f-2c81-4273-9a52-89eaa3f56693` | 0.0311245 |
| `2d1d284e-b0ec-498e-8691-4aa107cac2fe` | 0.2484457 |
| `3c8f0942-49e6-4a85-8acd-0c6653d21386` | 0.0286129 |
| `55c35512-7167-4889-9e37-5199d9646f32` | 0.0127352 |
| `b4eb7d84-c7f3-4a55-92f6-256777553b49` | 0.6790814 |

输出 identity 是 `process:7f1fbe5a-2f9c-4bb1-8d2d-f138e9cb7c8e@01.00.000`。完整、可重算的 hash 和验证摘要保存在 [`experiment-evidence.json`](experiment-evidence.json)。原 Candidate 和大体积 Process bytes 不进入 Git；试验输出保存在 ignored `.release/dataset-transformation/three-process-electricity/`。

现有数据中只有湖北 Process 记录了 `3.6 MJ/year`，另外两个为空。因此改用 annual-production 时会正常进入 `needs_decision`，要求用户补充有 evidence 的 override、改回显式权重、排除或拆分，而不会失败。
