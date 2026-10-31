# Nash Cluster: 自省与动态重新规划 (Graph Replanning)

## 1. 核心定位与设计哲学

当遇到前置任务失败、产物不合格或用户中途下发调整指示（Steer）时，系统启动由 `GraphReplanner` 驱动的**动态重新规划与版本自省**机制。

### 核心铁律：
1. **历史不可篡改**：已完成（`completed`）的子任务、已执行的写副作用和历史审计记录绝对不可被覆盖或抹除；
2. **版本化提交 (Graph Revision)**：每次 Replan 生成递增的 `revision`（如 Revision 1 -> Revision 2），并在 `cluster_graph_revisions` 中持久化记录变更原因与拓扑 Diff；
3. **预算硬约束**：严格受限于 `budget.maxReplanAttempts`（默认 3 次），超出限制后强制中止并标记为 `failed`，杜绝死循环 Replan。

---

## 2. 核心自省自愈流 (Auto Self-Healing Flow)

当关键回归测试任务失败时（例如 `task_verify_and_test` 退出码非 0）：
1. `ResultVerifier` 判定该节点为 `FAILED`；
2. `GraphReplanner` 捕获该事件并进入自省：
   - 保持原失败任务的历史记录；
   - 动态增补修复任务 `task_fix`（目标：分析前置失败日志并应用代码补丁）；
   - 动态增补复测任务 `task_retest`（依赖 `task_fix` 产生的补丁产物）；
   - 递增 Graph Revision，提交拓扑并驱动 Orchestrator 继续调度。

---

## 3. 用户 Steer 动态响应

当用户在中途输入指示（如“先不要修改代码，只给我输出分析报告”）：
- Replanner 识别意图为目标裁剪；
- 自动将所有未开始执行的写任务（`operation === "execute"`）标记为 `skipped`；
- 正在运行的分析任务继续推进，并在完成后收敛全图总结，精准响应用户意图。
