# Nash Agents 架构与执行边界

> 本页概括已实现的 TypeScript/Node.js 系统。历史生产验收记录不等于所有环境的通用认证。参阅[验证矩阵](../release/verification.md)。

## 总体结构

```text
Browser / CLI
   | HTTPS / REST / SSE
Coordinator — Auth / Projects / Node Registry / GoalRun
   |          Graph / Scout / Task Scheduler / Approval
   |          Security Audit / Model Gateway
   |          PostgreSQL (tasks / graph / events / audit)
   |          SQLite (administrator / versioned config)
   +-- authenticated WSS / A2A ----------------+
       |                   |                   |
  Worker node0         Worker node1        Worker node2
     Linux                Linux               Windows
       |                   |                   |
    AgentLoop / tools / file access / MCP / local OS sandbox
       |                   |                   |
          Journal / Artifact / Event sequence + ACK
```

Coordinator 负责目标状态、确定性调度、节点身份、任务图、审批和最终验证；Worker 在本机组装 AgentLoop 和权限边界。任务通信不是 SSH 远程执行。一个节点可以兼任 Coordinator 与 Worker。

## 职责划分

| 角色 | 职责 | 不负责 |
| --- | --- | --- |
| 模型（经 Model Gateway） | 理解目标、生成计划、选择工具与撰写结果文本 | 不写状态、不决定完成、不绕过安全策略 |
| Coordinator 运行时 | GoalRun/Graph 状态机、任务调度、租约、事件序列与 ACK、Node Registry、完成判定、SSE | 不代替 Worker 执行本机工具 |
| Worker 运行时 | 组装 AgentLoop、执行工具、FileSystemAccess、Worker Journal、Artifact 上报 | 不推断全局完成状态 |
| 安全层 | Security Monitor、独立 Security LLM、确定性硬拦截、审批、TaskSecurityGrant、OS 沙箱 | 不以模型自述作为放行依据 |
| 证据层 | Journal 事件、Artifact 摘要、Coverage 指纹 | 不接受未经执行记录的“已完成”声明 |

## 目标执行链路

1. 用户提出目标并建立持久化 GoalRun、配置版本和轮次租约。
2. Planner 决定单任务或 Graph/DAG；Scout 可采集证据；Scheduler 依据项目授权、节点能力和并发约束派发。
3. Worker 以 taskId/runId 执行工具，经过 Security Monitor、独立安全模型、审批、FileSystemAccess 和相应 OS 原生沙箱。
4. Worker Journal 保存序列化事件；网络中断后重连，Coordinator ACK 后才清理待发送事件。具有未知副作用的任务保留 outcome_unknown，不自动重试。
5. Coverage 按 Graph 修订、Task/Attempt、Node、Artifact 和证据指纹核对完成状态，不以模型声称作为完成证明。
6. SSE 和 Web 展示真实状态；客户端断连收敛为 detached 或由 Reconciler 处理，不等同于显式取消。

[GoalRun 与 Coverage 详解](../cluster/goal-run-lifecycle.md) · [Graph 编排](../cluster/graph-orchestration.md) · [分布式 A2A](../cluster/distributed-a2a.md)

## 安全与授权

- Linux：Bubblewrap / Landlock / Helper；Windows：AppContainer / ACL / Job Object；macOS：Seatbelt。所需后端缺失时依策略 Fail-Closed。
- 临时完整授权绑定到 nodeId + taskId + runId，Coordinator 持久化并等待 Worker ACK 才生效；手动撤销需 Worker ACK，任务结束时过期，其他任务不能继承。
- 确定性硬拦截独立于安全模型，不能靠 auto-grant 绕过。完全访问模式扩大权限，不能宣称保持完整文件隔离。
- 本地 MCP 受调用路径策略与审计约束；远程 MCP Server 自身的行为不受本地 OS 沙箱直接约束。
- 跨节点接入采用认证 TLS/WSS；本地默认 HTTP 不应直接暴露在不可信网络中。

[安全策略](security.md) · [MCP 边界](../security/mcp-boundaries.md)

## 持久化与升级

NASH_HOME 包含配置密文、master.key、节点身份、本地状态和 Journal。PostgreSQL 承载分布式任务与审计数据，SQLite 配置库与 PostgreSQL 不能混称。升级前需建立跨组件一致性恢复点，并确认 admission freeze/drain 的真实 settled / readyToStop；不能仅依据任务计数为零。

发布检查记录 Commit、Artifact SHA-256 和进程启动时 Release。Linux systemd 与 Windows Task Scheduler 接管产品服务。停止服务前必须取得真实的 admission settled / readyToStop 证明，而不是依据任务计数。

数据库结构升级后，回滚应以向前修复为主；恢复旧快照可能丢失快照之后的写入。生产环境建议使用专用低权限账户运行服务。

[架构分层](../cluster/architecture.md) · [可复现演示](../demo/scenarios.md) · [验证矩阵](../release/verification.md)
