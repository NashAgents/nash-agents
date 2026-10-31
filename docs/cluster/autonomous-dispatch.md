# Autonomous Task Dispatch (自主任务派发与全链路审计)

## 一、架构契约与复用原则

Phase 3 严格禁止重新实现任务分发协议，所有自主派发任务统一收口接入 Phase 1 已经交付并通过实机验证的 `TaskScheduler`：

```text
AutonomousDispatchService ──(调用)──> TaskScheduler.createTask(options)
                                              │
                                              ├─> 写入 PostgreSQL cluster_tasks
                                              ├─> 写入 Outbox 队列 (可靠投递)
                                              └─> 通过 WSS 协议投递至目标 Worker
```

---

## 二、强关联持久化审计 (Audit Trail)

每次自主路由派发，系统在 PostgreSQL 中自动记录四元强关联，确保随时回答“为什么选这台机器、为什么选这个项目”：

```sql
Task ID  <───>  Route ID  <───>  Run ID  <───>  Decision ID
```

### 1. `cluster_routes` 表
记录路由全生命周期元数据：
- `route_id`: 路由决策唯一标识
- `task_id`: 派发生成的分布式任务 ID
- `user_request`: 用户原始输入
- `intent`: 结构化解析出的意图 JSON
- `decision_type`: `DISPATCH` / `CLARIFICATION_REQUIRED` / `BLOCKED` 等
- `selected_node_id` & `selected_project_id`: 选定执行目标
- `reason`: 结构化决策依据

### 2. `cluster_route_candidates` 表
保存派发时刻的所有候选者快照：
- 每个候选的节点、项目、名称、相关性得分（score）、可信度（confidence）、硬约束检验状态（hard_constraints_satisfied）、未满足约束清单（unsatisfied_constraints）以及引用的事实证据快照（evidences JSONB）。

### 3. `cluster_route_events` 表
记录路由阶段事件（Search, Rank, Consult, Validate, Dispatch, Replan, Error）。

---

## 三、目标 Worker 的本地自主执行生命周期

一旦任务通过 WSS 信封（`task.dispatch`）送达目标 Worker：
1. **WorkerTaskRunner 拦截与 realpath 校验**：
   - 物理路径真实存在性校验（`resolveAndValidateProject`）；
   - 拦截跨目录符号链接欺骗与逃逸。
2. **装配本地隔离环境**：
   - 装配原生操作系统沙箱（macOS Seatbelt Scheme 或 Linux Bubblewrap 内核命名空间隔离）；
   - 装配本地 `FileSystemAccess` 与写锁边界；
   - 严格清洗子进程环境变量（剥离 `DEEPSEEK_API_KEY` 及私密 Token）。
3. **调用原生 `runAgentLoop`**：
   - 目标节点自主进行多轮 ReAct 推理、文件读取、代码编辑、测试执行；
   - 实时产生单调递增 `seq` 序号事件，通过 Outbox 可靠批量回传 Coordinator。
