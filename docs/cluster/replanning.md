# Controlled Replanning & Outcome Unknown Defense (受控重新规划与副作用防线)

## 一、重新规划的核心设计原则

分布式多 Agent 执行环境下，任务重新规划是一柄双刃剑。

**绝对禁止的反模式**：
- 只要 Worker 遇到一次 `tool.failed` 就唤醒 Coordinator LLM 重新派发；
- 目标 Worker 已经开始修改代码，Coordinator 以为节点失联，盲目在另一台节点重新派发相同任务，造成**双写冲突与代码损坏**；
- 无限循环重试（Worker 失败 -> Coordinator Replan -> 再次失败 -> 再次 Replan）。

**Nash Cluster 铁律**：
1. **局部问题局部治**：普通文件语法错误、路径未找到、参数校验失败等，由 Worker 本地 AgentLoop 自主反思和自愈；
2. **全局异常受控上报**：仅当发生不可逆异常时，由 `TaskSupervisor` 协同 `RoutingFeedbackController` 介入；
3. **副作用存在时严格收敛为 Outcome Unknown**：一旦原任务已触发写副作用且状态未知，坚决拒绝自动重试！

---

## 二、Replan 触发类型与处理矩阵

| 触发类型 (Trigger) | 典型场景 | 推荐处理策略 | 是否自动换节点重试 |
| :--- | :--- | :--- | :--- |
| `NODE_OFFLINE` | 目标 Worker 在任务执行中网络中断断线 | 检查原任务是否已发生写操作；无写操作则等待重连或 Replan；有写操作则标记 `outcome_unknown` | 无写操作时允许，有写操作坚决禁止 |
| `PROJECT_UNAVAILABLE` | 项目目录在运行中被物理删除或授权撤销 | 重新检查 Catalog 并向用户告警 | 需用户确认 |
| `CAPABILITY_UNAVAILABLE` | 运行期工具依赖缺失（如找不到某个编译器） | 评估其他节点是否具备该能力并提示 | 允许规划替代环境 |
| `AUTHENTICATION_REQUIRED`| 执行中发现 MCP 需要用户配置 Cookie/Token | 阻断并提示用户完成认证 | 坚决禁止盲目换节点伪装 |
| `EXECUTION_BLOCKED` | Worker AgentLoop 上报 `InterventionRequired`（如项目中无相关模块） | 收集最新项目 Catalog，重新评估目标归属 | 允许生成 Replan Proposal |
| `REPEATED_FAILURE` | 任务执行连续多次阻断超限 | 进入阻塞状态，保护系统资源 | 停止重试，请求用户人工介入 |
| `USER_GOAL_CHANGED` | 用户在运行中输入了全新方向的诉求 | 先协调取消原 Run，按新目标重新派发 | 允许（原 Run 安全停止后） |

---

## 三、Replan 状态机与收敛流程

```text
    Running
       │
 (发生关键异常)
       ▼
 InterventionRequired
       │
 (FeedbackController 评估)
       ▼
  ReplanEvaluating
       │
 ┌─────┴─────────────────────────────────────┐
 │                                           │
 ▼                                           ▼
[存在未确认写副作用]                   [状态干净，无破坏性副作用]
 │                                           │
 ▼                                           ▼
OutcomeUnknown (人工确认)              ReplanProposed
                                             │
                                             ▼
                                  OriginalRunReconciled
                                 (向原 Worker 发送 cancel 确保停止)
                                             │
                                             ▼
                                      ReplanValidated
                                 (RoutingValidator 严格校验)
                                             │
                                             ▼
                                      DispatchNewRun
```

---

## 四、Replan 预算治理 (Replan Budget)

为杜绝死循环，系统对每个任务严格执行三层限额：
1. **单任务最大重新规划次数**：默认最多允许 2 次，超限后强制进入 `blocked` 终态；
2. **冷却时间窗口 (Cooldown)**：连续两次 Replan 间隔必须大于 5 秒；
3. **Coordinator AgentLoop 咨询预算**：单次分析最多允许 5 步推理、10 次工具调用、30 秒 Wall-Clock 硬超时。
