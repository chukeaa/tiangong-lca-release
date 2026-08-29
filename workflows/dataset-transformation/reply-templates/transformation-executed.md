所选层级的加权 Process 已生成并通过确定性验证。

输出：{{artifacts.transformedProcess}}

下一步进入 {{nextWorkflow}}。Unit Process 路线重新计算 Result evidence；Result Process 路线物化 Derived Result，且不会隐式聚合 LifecycleModel。最终都生成新的 Candidate。
