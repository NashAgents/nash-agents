# Nash Cluster: 分布式图编排引擎 (Graph Orchestration)

## 1. 核心架构与职责分工

分布式任务图编排器 (`DistributedGraphOrchestrator`) 是集群协调中枢（Coordinator）的调度心脏。其主要职责包括：
1. **原子状态推进 (`advanceGraph`)**：监听 Worker 完工事件，计算前置依赖达成情况，推进就绪任务；
2. **Join Barrier 强同步屏障**：对于依赖多个前置节点的聚合任务（如设计方案或汇总报告），确保全部前置节点成功完成且产物校验通过后，仅触发一次调度；
3. **并发治理与槽位管理**：动态计算活跃执行中的任务数，若达到 `maxParallelTasks` 上限，则将新就绪任务维持在排队队列；
4. **项目写租约防护 (`ProjectWriteLease`)**：防止多个子任务同一时刻向同一个物理项目发起写操作引发 Git 冲突、构建污染或文件竞态；
5. **失败与取消传播**：依据节点的 `failurePolicy` 执行阻断（`block_dependents`）、跳过（`skip_dependents`）或全图熔断（`cancel_graph`）。

---

## 2. Join Barrier 执行与防重入机制

当 Task A 与 Task B 并发运行时，它们可能在毫秒级微小时间差内先后完成。系统通过以下确定性防线杜绝 Task C 被重复派发：

```text
    Task A (dispatched -> completed) ──┐
                                       ├──► advanceGraph() ──► 检查 Task C 所有 in-edges
    Task B (dispatched -> completed) ──┘        │
                                                ▼
                                    只有全部达成时：
                                    原子更新 Task C = 'ready'
                                    派发并立即标记 Task C = 'dispatched'
```

通过内存/数据库状态跃迁闭环，消除了并发触发产生的重复派发漏洞。

---

## 3. 项目写租约与并发安全 (`ProjectWriteLease`)

当子任务的 `operation === "execute"` 时，该任务被判定为具有文件或项目写副作用：
- 调度前检查 `activeProjectWrites.has("${targetNodeId}::${targetProjectId}")`；
- 若已被占用，保持该任务在 `ready` 状态，暂不调度，等待当前写任务完成；
- 任务完工、失败或全图取消时，自动释放写租约；
- 只读分析任务 (`operation === "analyze"` / `"verify"`) 享有无锁并发，可同时在同一项目上多路运行。
