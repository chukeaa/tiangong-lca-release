---
title: Calculation Workflow Agent Contract
docType: contract
scope: workflow
status: active
authoritative: true
owner: release
language: zh-CN
whenToUse:
  - 当 Agent 设计、实现或运行 Calculation Workflow 时
whenToUpdate:
  - 当入口解析、远程命令、证据绑定、恢复或确认规则变化时
checkPaths:
  - workflows/calculation/**
lastReviewedAt: 2026-08-18
lastReviewedCommit: f8d37018d898d23a51655272d129417eb9fad13a
lastReviewedNote: "Defined Calculation Agent confirmation, evidence, recovery, and external-system boundaries."
related:
  - README.md
  - ../AGENTS.md
---

# Calculation Workflow Agent Contract

## 加载顺序

1. 仓库根 `README.md`；
2. `workflows/AGENTS.md`；
3. 本文件；
4. 本目录 `README.md`；
5. 只有在实际调用某个外部能力时，才读取其最小版本契约。

## Agent 必须先做的事

- 解析用户提供的是名称、ResultSet、Closure、Job、Package 还是 Bundle。
- 如果名称对应多个对象，停止并要求精确选择。
- 读取权威远程状态，不根据本地旧摘要猜测。
- 输出当前已有证据、仍需决定的问题、允许动作和阻塞动作。

## 可自动执行的只读动作

- 查询已有对象和任务；
- 读取有界报告和 artifact metadata；
- 下载用户已经明确要求的产物；
- 校验大小、hash、版本和 manifest 引用；
- 恢复一个已有任务的状态观察。

## 需要明确确认的动作

- 创建 ResultSet；
- 启动 Closure Check；
- 启动计算任务；
- 改变 scope、方法集或有效证据绑定；
- 创建会取代已有业务对象的新计算分支。

## 硬边界

- 不实现求解器或复制 Worker 逻辑。
- 不在 Calculation Workflow 中生成 Result Process、LifecycleModel 或 package。
- 不从 mutable `latest` 推断缺失身份、版本或计算输入。
- 不把任务 transport success 当作 domain validity。
- 不把 Closure warning 自动解释为可忽略。
- 不持久化 signed URL、access token 或用户 API key。
- 不因外部能力缺失修改其他仓库。

## 完成条件

用户请求的终点已满足，并且另一位 Agent 能根据精确资源引用、当前状态和证据继续；如果用户只要求验证或启动任务，不应强制继续到下载。
