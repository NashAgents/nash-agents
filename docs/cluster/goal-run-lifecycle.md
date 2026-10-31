# Nash Cluster GoalRun 生命周期与覆盖核验

GoalRun 是「一条用户消息」在集群中的持久化执行身份。它把会话轮次、任务图、Scout 探查、审批、
最终报告绑在同一个 `goalRunId` 上，并由运行时（而非模型）裁决目标是否真正完成。

## 1. 状态与阶段

```text
[planning] ──▶ [awaiting_verification] ──▶ [verifying] ──▶ 终态
                                                     ├─ completed
                                                     ├─ partially_completed
                                                     ├─ failed
                                                     ├─ cancelled
                                                     └─ outcome_unknown
```

- `status` / `executionState` 由 `resolveGoalStatus` 单点推导：`reconcileGoalRun`（后台对账）与
  `processGoalRunOnce`（报告生成）共用同一判定，杜绝两者结论互相拉扯导致状态与报告抖动。
- 终态只能由 Runtime 核验后的结构化事实产生；模型文本、工具输出的成功字符串、文件名或
  计数器都不能证明完成。
- 只有 `REPORTABLE_GOAL_STATES`（`verifying` 与所有终态）才允许重建报告；仍在推进的目标
  不会提前产出结论。

## 2. 覆盖契约 (GoalCoverageContract)

每次任务图被采纳或重规划（`recordGraphCoverage`）都会追加一版契约，记录图修订号、
根目标一致性、每个检查项的目标节点/项目、验收要求与必需的沙箱策略。

- 新修订会让上一版判定失效：`coverageEvaluation` 被清空，必须按新修订重新核验。
- 契约只描述「计划检查了什么」，不证明「目标已被完整覆盖」。

## 3. 判定等级 (GoalCoverageCheckState)

| 状态 | 含义 |
| :--- | :--- |
| `verified` | 当前修订的节点已完成，且完成证据绑定真实执行尝试 |
| `completed_unverified` | 节点完成但证据不能绑定本次尝试（例如旧 run 的收据） |
| `revision_mismatch` | 证据来自其他图修订 |
| `superseded` | 该检查已被同目标的替代检查承接，且替代项本身可核验 |
| `planned` / `dispatched` / `running` / `waiting_approval` | 尚未产出可核验结果 |
| `failed` / `inconclusive` / `unknown` / `missing` | 无有效证据、证据不足、结果未知、检查缺失 |

`verified` 必须同时满足：图修订与契约一致、节点与任务同为 `completed`、
`graphContext` 的 `graphId`/`graphNodeId` 归属一致、节点分派的 Worker 与任务记录的 Worker 一致、
计划目标（若声明）一致、任务持有 `runId`、验证记录通过、`executionSource` 为
`authenticated_worker_runtime`、证据中的 `taskId`/`runId`（以及可选的 Worker）与本次尝试一致、
必需的验收产物齐备。任何一条不满足都降级，绝不「差不多算完成」。

终态图若仍留下活跃的节点投影，说明读到的是过期投影，降级为 `inconclusive`，
避免目标卡在 `verifying` 永不收敛。

## 4. 报告生成与幂等

`processGoalRun` 的顺序固定为：对账 → 终态门禁 → 覆盖评估 → **先持久化判定** → 推导状态
→ 生成报告文本 → 落盘报告与 `reportHistory`。

- 先落判定再落文本：报告写入失败时判定不会丢失，下一轮可重建。
- 报告指纹包含状态与判定内容，重复处理不会重复产出报告版本（并发两次只提交一份）。
- 部分报告明确写出「未检查范围不能据此作出结论」，绝不把失败或未执行的分支表述为「不存在」。
- 正文行的事实（ID、时间戳、计数、耗时、哈希）经 `verifyAnswerFacts` 校验；结构性行不合规
  直接抛错，自由文本行则被剔除，避免报告包含不可核验的断言。

## 5. 轮次围栏 (GoalTurnFence)

`turnLease` 记录当前前台轮次的 `ownerId`/`turnId`/`generation` 与到期时间。

- 前台轮次在其 `fence` 下写入；`assertGoalTurnFence` 在存储锁内校验，防止被取代的轮次
  继续写入。
- 派生状态写入者（对账器、后台重规划）必须经 `ownedByForeignLiveTurn` 判断：存在他人
  持有的有效租约时，不得改写状态与报告，只允许记录新的覆盖修订。
- 租约到期后，后台对账可以重新收敛派生状态。

### 轮次中止语义

前台轮次被中止时，原因决定会话终态，三者不可混用：

| 中止原因 | 助手消息 `state` | 含义 |
| :--- | :--- | :--- |
| 用户显式取消（`User cancelled conversation`） | `cancelled` | 用户主动结束本轮 |
| 客户端断开（宽限 `NASH_TURN_DISCONNECT_GRACE_MS`，默认 60s） | `detached` | 协调器停止等待；已派发任务继续执行 |
| 轮次硬上限（`NASH_TURN_MAX_DURATION_MS`，默认 30min） | `timed_out` | 同上，按任务状态查看结果 |

客户端断开**不是**用户取消，不能提示“已由用户手动取消”。轮次结束时租约在 `finally` 中按
`ownerId + generation` 释放，会话立即可再次对话；GoalRun 由对账器按关联任务真实状态收敛
（有关联任务时保持 `running` 直到任务终态）。

## 6. 崩溃恢复与端到端不变量

- 派发先持久化 task/run 与 Outbox，重连复用原执行身份；Worker 侧 Journal 以 `taskId` 去重。
- 有副作用的任务在断线后收敛为 `outcome_unknown`，保留写租约，禁止自动重派。
- 迟到的 Scout 报告会触发重新评估并修订报告，而不是丢弃或覆盖历史结论。
- 用例 A–F 的回归位于 `test/goal-run-coverage.test.ts`（内存）与
  `test/cluster-postgres-goal-run.test.ts`（真实 PostgreSQL 隔离 schema）：
  A 完整覆盖、B 部分覆盖不得宣称不存在、C 修订后旧收据失效、D 迟到 Scout 补正、
  E 崩溃接管不重复、F 并发与乱序不产生重复报告。
