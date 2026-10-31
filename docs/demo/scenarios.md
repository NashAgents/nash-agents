# Nash Agents — 可复现的功能演示

本手册面向技术评审和项目展示。测试必须使用**明确授权的空工作区与无害文件**；不要在演示中访问生产密钥、改变真实业务数据，或重试历史 `outcome_unknown` 任务。

## 演示准备

1. 从当前构建读取 source commit、artifactSha256 和运行进程 Release ID，确保 Coordinator/Worker 版本兼容。
2. 在 Web 的 **Nodes** 中确认 Linux/Windows Worker 在线；在 **Projects** 登记一个仅用于演示的空目录。
3. 配置可进行工具调用的主模型与独立安全模型，并记录模型协议；为安全测试保留受限策略。
4. 打开 Graph、Tasks、Artifacts、Approvals、Security Audit 和 SSE 视图，准备观察真实事件而非截图模拟。

每个场景按同一模板记录：

- **前置条件**：授权目录、节点、策略与依赖。
- **用户输入**：实际提交的自然语言目标或 API 调用。
- **期望行为**：系统应产生的可观察行为。
- **检查位置**：在 Web/CLI/API/数据库中的核对点。
- **验收证据**：taskId/runId、事件、Artifact 摘要、审批/授权 ACK、截图或日志。
- **安全限制**：该场景不允许跨越的边界。
- **清理**：演示专用文件、临时 Grant 与环境恢复。

## 场景 A：单节点只读执行

- **前置条件**：一个已授权的演示项目；单个在线 Worker；受限策略。
- **用户输入**：`检查当前授权项目的目录结构，说明主要模块和依赖；保持只读，不修改文件，不访问网络。`
- **期望行为**：模型规划后调用只读工具；Coordinator 记录 Task/Attempt 与工具事件；Worker 在沙箱内执行。
- **检查位置**：Chat 工具卡片、Tasks、Graph、Security Audit。
- **验收证据**：taskId/runId、执行 Worker、工具调用序列、沙箱后端、最终报告与工具结果一致。
- **安全限制**：不得写文件或访问网络；仅有自然语言答案不算工具执行成功。
- **清理**：无需清理；确认没有创建或修改项目文件。

## 场景 B：跨节点 DAG、并行与证据合并

- **前置条件**：三个各自授权的演示目录，三个在线 Worker。
- **用户输入**：`将“跨节点演示”拆为三个独立子任务，分别在三个在线 Worker 的演示目录生成只包含 DEMO_OK 的文本文件；随后汇总每个执行节点、产物路径及 SHA-256，并根据真实结果形成报告，不得修改其他目录。`
- **期望行为**：Coordinator 生成 Graph/DAG 与依赖边，三个任务并行执行，Artifact 上报并参与 Coverage 判定，最终报告引用真实产物摘要。
- **检查位置**：Graph 依赖视图、Tasks（每个 Attempt）、Artifacts 摘要、GoalRun 最终状态、Coverage 结果。
- **验收证据**：GoalRun/Task/Run ID、依赖边、三个节点上的文件与 SHA-256 一致；若模型无法可靠创建多节点任务图，应如实报告而不是伪造。
- **安全限制**：只能写入各自演示目录；不得访问其他项目或网络。
- **清理**：删除演示文件；保留 GoalRun/Task 历史记录，不重放未知副作用任务。

## 场景 C：任务级安全授权与手动撤销

- **前置条件**：受限工作区策略；可写入演示专用工作区外路径的审批流程；管理员会话。
- **用户输入**：`把内容 probe 写入 <演示路径 A>，然后继续任务；完成后写入 <演示路径 B>。`
- **期望行为**：A 的写入触发审批且文件尚不存在；管理员临时授权后 Worker ACK、Grant 生效，A 落盘；运行中撤销 Grant 后 B 再次触发审批或拒绝。
- **检查位置**：Approvals、Security Audit（含 `system.revoke_security`）、任务事件、文件系统。
- **验收证据**：approvalId、grantId、Worker 确认（`confirmed=true, status=revoked`）、A 存在而 B 不存在；Grant 未泄漏到其他 Task/Run。
- **安全限制**：不使用敏感系统目录或破坏性命令；授权只覆盖单一 node/task/run。
- **清理**：删除 A/B 演示文件；确认 Grant 已过期或撤销。

## 场景 D：原生沙箱与 Security LLM

- **前置条件**：Linux 与 Windows 各一个 Worker；受限策略；可恢复的安全模型配置。
- **用户输入**：在授权目录内执行文件写入；对无害外部测试目标发起网络请求；临时注入安全模型超时。
- **期望行为**：`workspace-write` 写入成功；`network: deny` 的出站请求失败；安全模型不可用时调用转为 `REQUIRE_APPROVAL`（`SYSTEM_FAILURE`）而不是放行。
- **检查位置**：Security Audit、Approvals、工具结果、Worker 日志。
- **验收证据**：平台对应的沙箱后端、失败原因、审批记录；恢复配置后同一操作回到 `ALLOW / LLM_MONITOR`。
- **安全限制**：只测试无害目标；不得把安全模型故障注入用于生产任务。
- **清理**：恢复安全模型设置；删除测试文件。

## 场景 E：断连收敛、排空与服务恢复

- **前置条件**：可控的长任务；客户端可以主动断开；维护窗口内可停止服务实例。
- **用户输入**：发起包含 `sleep` 的任务后在工具执行中断开客户端；随后重新连接同一会话。
- **期望行为**：助手消息记录 `detached`（而非用户取消）；会话可立即复用；已派发任务继续执行；GoalRun 由 Reconciler 收敛。
- **检查位置**：会话消息、GoalRun 状态、Tasks、SSE。
- **验收证据**：断连状态、后续请求 HTTP 200、任务 `dispatchAttempt=1` 完成、GoalRun 最终状态。
- **安全限制**：断连不等于取消；不得通过断开连接绕过权限检查。
- **清理**：让任务正常结束；不删除历史事件。

## 场景 F：Admission Freeze / Drain 与服务自启动

- **前置条件**：可运行真实任务；systemd 或 Windows 计划任务已启用；备份可用。
- **用户输入**：在有任务运行时请求 `/stop`；任务结束后执行 `/drain` 并停止，再重新启动服务。
- **期望行为**：有在途工作时 `/stop` 返回 `DRAIN_REQUIRED`（HTTP 409）；排空快照在真实 settled 且连续探针通过后返回 `readyToStop=true`，停止才被允许；服务重启后自动恢复并重新注册节点。
- **检查位置**：控制端点 `/admission`、`/stop`、systemd/journal 或计划任务状态、Nodes。
- **验收证据**：409 响应与快照、`stopping=true, forced=false`、启动时间戳、节点重新 `online`、A2A 探针往返。
- **安全限制**：生产整机重启只能在明确维护窗口内执行；不得用 `force` 掩盖未排空状态。
- **清理**：恢复允许接单状态；保留日志与恢复点。

## 场景 G：MCP 调用边界

- **前置条件**：一个自控的本地 stdio MCP 测试服务；受限策略；审批可用。
- **用户输入**：让 Agent 调用 `mcp__<server>__<tool>`，分别测试拒绝、允许一次和携带 `rm -rf /` 参数。
- **期望行为**：工具调用必须先经过审批；拒绝返回 `PERMISSION_DENIED` 且服务端未执行；允许一次时真实执行并回传结果；危险参数被确定性硬拦截，不产生审批、不执行。
- **检查位置**：Approvals、Security Audit（`is_hard_block`）、MCP 服务端日志。
- **验收证据**：审批能力与 toolName、拒绝记录、执行回执、硬拦截记录。
- **安全限制**：远程 MCP Server 自身行为不受本地 OS 沙箱直接约束；不得连接不可信服务。
- **清理**：删除测试 MCP 配置与进程。

## 场景 H：SSE、Web 控制台与发布身份

- **前置条件**：已启动的产品实例；管理员登录；可读取 `/api/cluster/events/stream`。
- **用户输入**：在 Web 中运行一个任务，同时观察 SSE。
- **期望行为**：收到 `cluster.snapshot`、`goal_run.updated`、`cluster.heartbeat` 等事件；节点、任务与审批状态与 API 一致；发布身份（commit、artifact 摘要、运行进程）与磁盘产物匹配。
- **检查位置**：Web 控制台、SSE 流、`/api/cluster/status`、官方 `scripts/cluster-release-evaluator.js`。
- **验收证据**：事件样例、评估器 `RUNTIME_VERIFIED`、artifactSha256 与构建清单一致。
- **安全限制**：SSE 与 API 不得在不可信网络中直接暴露；公开仓库不包含生产地址或凭据。
- **清理**：关闭测试会话，保留真实任务记录。

## 证据与清理

每个场景记录：commit、Node OS/角色、真实运行 Release、GoalRun/Task/Run ID、工具事件、审批/授权 ACK、Artifact 摘要、SSE、实际结果、失败和跳过。清理演示专用文件及临时 Grant，不清理历史记录。

演示应在独立环境中执行，并保留可复核的真实事件记录。平台和协议适配范围见[验证矩阵](../release/verification.md)，执行细节以当前环境中的实际结果为准。
