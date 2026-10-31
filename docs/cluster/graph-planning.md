# Nash Cluster: 自主任务规划 (Graph Planning)

## 1. 核心定位与职责划分

在 Phase 4 中，任务规划中枢由 `AutonomousPlanner` 统管。其核心职责是：
1. **意图深度解析**：识别自然语言目标是单节点简单任务还是多阶段协同工程；
2. **Single Task Fast Path**：对于简单无依赖任务，自动绕过分布式图编排开销，交由 Phase 3 Autonomous Dispatch 毫秒级执行；
3. **复杂工业 DAG 解构**：将跨节点、跨模块复合目标解构为具备并行探索、产物生成、方案合成与验收回归的标准任务图；
4. **规划预算治理 (Planning Budget)**：设定最大节点数 (`maxNodes`)、最大深度 (`maxDepth`) 与并发上限 (`maxParallelTasks`)，防止生成无限无意义 Agent。

---

## 2. 规划决策流

```text
               User Natural Language Goal
                           │
                           ▼
            AutonomousPlanner.planGoal()
                           │
                 [Single Task Fast Path?]
                 ├── 是 ──► [单任务直派 (0 额外 Agent 开销)]
                 └── 否
                      │
                      ▼
            Cluster Catalog 联合检索
            (发现 Project, Skills, MCP, 联邦记忆)
                      │
                      ▼
               任务解构与依赖图推导
                      │
                      ▼
                DagValidator 校验
         ┌────────────┴────────────┐
         ▼                         ▼
      [VALID]                  [INVALID]
         │                         │
         ▼                         ▼
   GraphProposal             抛出校验错误并拒绝
```

---

## 3. 预算控制参数 (`GraphBudget`)

为防止在 4GB RAM 的腾讯云节点上由于失控生成几十个 Agent 导致内存耗尽，系统严格受控于以下预算：

| 参数 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `maxNodes` | 10 | 单张图允许包含的最大子任务数量，防止任务图无限爆炸 |
| `maxDepth` | 6 | 依赖图最大深度层级，超出时拒绝执行 |
| `maxParallelTasks` | 5 | 全局并发调度槽位上限，多余就绪节点保持在排队队列 |
| `maxReplanAttempts` | 3 | 最大允许重新规划代数（Revision 上限为 4），杜绝死循环 Replan |
| `totalTimeoutMs` | 1800000 (30m) | 整张任务图的最大执行总耗时 |
| `perTaskTimeoutMs` | 600000 (10m) | 单个子任务在 Worker 上允许运行的硬超时 |
