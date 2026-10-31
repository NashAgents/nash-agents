# Nash Cluster 任务生命周期与持久化模型

## 1. 任务状态机流转 (Task State Machine)

```text
       [Created]
           │
           ▼
        [Queued] ──(Outbox 轮询投递)──▶ [Dispatched]
                                            │
                                  ┌─────────┴─────────┐
                                  │ (Worker 拒绝)      │ (Worker 接收)
                                  ▼                   ▼
                              [Failed]            [Accepted]
                                                      │
                                                      ▼
                                                  [Running] ◀──────────────┐
                                                      │                    │
                                     ┌────────────────┼────────────────┐   │
                        (触发提权审批) │                │ (Steer 注入)    │   │ (审批放行)
                                     ▼                ▼                ▼   │
                            [WaitingApproval] ──▶ [Steered] ───────────────┘
                                     │                │
                                     │ (审批拒绝)      │ (任务正常完成)
                                     ▼                ▼
                                 [Failed]        [Completed]
                                     ▲
                                     │ (超时/异常)
                                [Interrupting] ──▶ [Interrupted] / [Cancelled]
```

### 关键异常状态：`OutcomeUnknown`
当 Worker 在执行包含副作用（文件写、命令运行等）的任务中途发生网络断开或宿主关闭，Coordinator 的 `TaskSupervisor` 会将该任务收敛标记为 `outcome_unknown`。**绝对禁止自动对有副作用的任务盲目重新执行**，必须保留执行点与事件证据，等待人工核验或节点重连同步。

---

## 2. PostgreSQL 数据持久化结构

在生产 Coordinator 上，所有状态均依托 PostgreSQL 数据库严格落盘：
- **`cluster_nodes`**：记录所有节点唯一 Node ID、硬件架构、Token 哈希、在线状态与元数据；
- **`cluster_node_connections`**：记录连接代际（Generation）与连接时间；
- **`cluster_tasks`**：记录任务目标（Goal）、状态流转、最终答案（Final Answer）、产物元数据（Deliverables）；
- **`cluster_events`**：记录带单调递增 `seq` 序号的执行日志，通过 `UNIQUE(task_id, seq)` 约束实现物理级幂等去重；
- **`cluster_approvals`**：记录待决议与已决议的审批历史；
- **`cluster_outbox` / `cluster_inbox`**：提供分布式消息的至少一次可靠投递与防重放去重。
