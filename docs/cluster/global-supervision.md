# Nash Cluster: 全局监督与状态投影 (Global Supervision)

## 1. 架构定位

在 Phase 4 中，任务图的长期运行由 `GlobalGraphSupervisor` 全局监督器与 `GraphStateProjection` 状态投影器共同维护：
- `GlobalGraphSupervisor`：负责时间周期维度的超时巡检、Worker 断线状态收敛与全局熔断保护；
- `GraphStateProjection`：负责纯确定性事件聚合状态机计算，为 CLI、TUI、API 与 Phase 5 Web Dashboard 提供零延迟状态快照。

---

## 2. Worker 离线与 Outcome Unknown 保守收敛

### 核心安全底线：
当 Worker 在执行具有写副作用的任务中途发生网络断线或离线时：
- **绝对严禁自动将任务派发给其他 Worker 重试**！
- 如果自动重试，会导致旧节点恢复后发生灾难性的**双写冲突**；
- 系统自动将该任务节点状态收敛为 `outcome_unknown`，记录断线上下文并向 Supervisor 告警，等待节点重连自愈或人工介入确认。

---

## 3. 毫秒级状态投影 (`GraphStateSnapshot`)

系统杜绝每次用户查询状态都唤起 LLM 进行语义推理。所有状态均由物理数据库记录和事件流确定性生成：

```typescript
export interface GraphStateSnapshot {
  graphId: string;
  parentGoal: string;
  status: GraphStatus;
  revision: number;
  totalNodes: number;
  completedNodes: number;
  runningNodes: number;
  waitingNodes: number;
  blockedNodes: number;
  failedNodes: number;
  currentPhase: string;
  activeNodesByHost: Record<string, string[]>;
  pendingApprovalsCount: number;
  artifactsCount: number;
  updatedAt: number;
}
```
