# Nash Agents 分布式架构

本页取代以特定云厂商、Mac 开发机和早期实施阶段为核心的历史设计示意。当前系统使用 TypeScript/Node.js、Coordinator/Worker 角色和认证 WSS/A2A；运行平台可为 Linux、Windows 或 macOS，取决于本机原生沙箱能力。

## 核心设计

1. **控制与执行分离**：Coordinator 管理规划、节点目录、任务、Graph、GoalRun、审批、Artifact 证据和恢复；Worker 在本机执行 AgentLoop，不以 SSH 命令替代任务通信。
2. **真实节点权限**：每个 Worker 只对明确授权的项目和任务执行，使用本地 FileSystemAccess、Security Monitor、Security LLM 和 OS Sandbox，权限不足时拒绝。
3. **可靠事件与不重复副作用**：Journal、序列号和 ACK 确保断连恢复；结果不明的外部副作用保持 outcome_unknown，不盲目重入。
4. **证据先于报告**：Graph 修订、Task/Attempt 身份、Artifact SHA-256、Coverage 验证是 GoalRun 完成判断依据。
5. **受控服务升级**：Admission Freeze/Drain、备份恢复点、发布身份哈希、systemd/Windows Task Scheduler 和原生回归共同构成发布流程。

## 分层

| 层 | 组件 | 功能 |
| --- | --- | --- |
| 入口 | Web/CLI、REST、SSE | 人机交互、审批与实时进度 |
| 控制 | Coordinator、NodeRegistry、Scheduler、Supervisor、GoalRun | 调度、状态、恢复与排空 |
| 通信 | WSS Gateway、CoordinatorClient、Journal、ACK | 认证、双向消息、断连恢复 |
| 执行 | WorkerRuntime、AgentLoop、Tool Adapter、MCP | 本地项目与工具执行 |
| 安全 | Approval、TaskSecurityGrant、Security Monitor、Security LLM、Sandbox | 策略审查、临时授权与撤销 |
| 存储 | PostgreSQL、SQLite、NASH_HOME、Artifact | 持久化、机密、发布身份与恢复 |

## 深入阅读

- [完整架构与执行边界](../operations/architecture.md)
- [GoalRun 与 Coverage](goal-run-lifecycle.md)
- [A2A 协议](distributed-a2a.md)
- [Graph 编排](graph-orchestration.md)
- [安全](security.md)
- [功能演示](../demo/scenarios.md)
- [验证矩阵](../release/verification.md)

该设计不承诺所有 OS、模型或远程 MCP Server 具备相同的安全行为，依平台验收和具体策略为准。
