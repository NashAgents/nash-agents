# Nash Cluster: 分布式任务图 (Distributed TaskGraph)

## 1. 架构定位与核心设计

在 Nash Cluster Phase 4 中，任务调度能力由 Phase 3 的“单节点/单任务自主派发”正式升级为**跨节点有向无环图 (DAG) 分布式协同编排系统**。

分布式任务图 (`Distributed TaskGraph`) 负责对复杂的工业级多阶段目标进行严谨的生命周期管理，支持：
- 严格声明式拓扑结构与持久化模型（PostgreSQL 16 驱动）；
- 毫秒级无环校验（Tarjan / DFS 3-Color 染色法）；
- 产物依赖闭环与多阶段并行发现（Kahn 算法拓扑分层）；
- 并行执行分支、串行推进阶段与 Join Barrier 强同步屏障；
- 失败阻断传播 (`block_dependents`)、跳过 (`skip_dependents`) 与全局取消 (`cancel_graph`)。

---

## 2. 状态机模型

### 2.1 Graph 整体生命周期状态机

```text
       [PLANNING]
           │
           ▼
      [VALIDATING] ──(校验不通过)──► [FAILED]
           │
           ▼
        [READY]
           │ (startGraph)
           ▼
       [RUNNING] ◄────────────────┐
       │   │   │                  │ (replanGraph)
       │   │   └───► [BLOCKED] ───┘
       │   │
       │   ├───(所有节点成功)────────► [COMPLETED]
       │   ├───(部分成功/部分失败)──► [PARTIALLY_COMPLETED]
       │   ├───(关键依赖失败)────────► [FAILED]
       │   │
       │   ▼
  [CANCELLING] ──────────────────► [CANCELLED]
```

### 2.2 Graph Node 节点执行状态机

```text
    [PENDING] ──► [WAITING_DEPENDENCIES]
                         │
                         ▼ (前置任务成功 & 产物校验通过)
                      [READY]
                         │
                         ▼ (通过 TaskScheduler 派发)
                    [DISPATCHED]
                         │
                         ▼ (目标 Worker 确认接收)
                     [ACCEPTED]
                         │
                         ▼ (启动本地 AgentLoop)
                     [RUNNING]
                     │   │   │
          ┌──────────┘   │   └──────────┐
          ▼              ▼              ▼
     [COMPLETED]      [FAILED]   [OUTCOME_UNKNOWN]
```

---

## 3. 数据库持久化实体 (`004_distributed_taskgraph_and_a2a`)

| 表名 | 职责说明 | 关键约束与索引 |
| :--- | :--- | :--- |
| `cluster_graphs` | 记录任务图元数据、整体状态、版本与全局预算 | 主键 `graph_id`，索引 `status`, `updated_at DESC` |
| `cluster_graph_nodes` | 记录任务图内各子任务节点状态、分配节点、产物需求与验收标准 | 复合主键 `(graph_id, node_id)`，外键级联 `graph_id` |
| `cluster_graph_edges` | 维护节点之间的有向依赖边、依赖类型与产物匹配 | 唯一约束 `(graph_id, from_node_id, to_node_id)` |
| `cluster_graph_revisions` | 记录任务图动态变更版本审计与增量变更摘要 | 索引 `(graph_id, revision)` |
| `cluster_graph_events` | 图级别单调递增审计事件流表 | 唯一约束 `(graph_id, seq)` |
| `cluster_graph_verifications` | 记录节点执行结果的确定性验收审计记录 | 索引 `(graph_id, graph_node_id)` |

---

## 4. 拓扑分层与并行阶段划分算法

系统复用原生单机 `TaskGraph` 的图论算法，利用 Kahn 算法计算并行执行阶段 (`parallelStages`)：

```typescript
// 拓扑分层核心逻辑
while (currentQueue.length > 0) {
  parallelStages.push([...currentQueue]); // 当前层内所有节点可完全并行
  const nextQueue: string[] = [];

  for (const curr of currentQueue) {
    topologicalOrder.push(curr);
    for (const child of dependentsMap.get(curr) ?? []) {
      const deg = inDegree.get(child)! - 1;
      inDegree.set(child, deg);
      if (deg === 0) nextQueue.push(child);
    }
  }
  currentQueue = nextQueue;
}
```

任何具有循环依赖、自依赖、孤立未知依赖的提案均被 `DagValidator` 拒绝，绝不向数据库写入非法任务状态。
