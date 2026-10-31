# MCP 工具的安全边界（本地 stdio 与远程传输）

本文说明 Nash 对 MCP（Model Context Protocol）工具调用能保证什么、不能保证什么。
它描述的是**当前实现**，任何「Nash 的沙箱会限制远端 MCP Server」的说法都是错误的。

## 1. 调用链

```
模型 tool_call
  → agent-loop（构建 SecurityContext）
  → PreToolSecurityMonitor（确定性硬拦截 + 独立安全模型审查，Fail-Closed）
  → ToolRegistry → ToolExecutor
  → MCPToolAdapter.execute()（allow/deny 名单 → 策略与审批门禁）
  → MCPConnectionManager.callTool()
  → Transport（stdio 子进程 / streamable-http / sse）
  → MCP Server（本地进程 或 外部主机）
  → MCPResultAdapter（裁剪 / 落盘）→ tool result
```

安全审查发生在适配器之前，对内置工具与 MCP 工具**一视同仁**：不存在按工具名前缀跳过审查的分支。

## 2. 本地 stdio 服务

- 子进程通过 `SandboxService.buildExecutionSpec()` 包装（Linux bwrap / macOS Seatbelt / Windows helper），
  继承 `network` 与 `filesystem` 策略。
- 环境变量经过 `buildSanitizedStdioEnv()` 白名单清洗，**不继承** `DEEPSEEK_API_KEY` 等密钥。
- 沙箱策略在**建立连接时**从 `SandboxService.getPolicy()` 读取：
  - 任务级全访问授权之后新建/重连的连接，会按授权后的策略启动；
  - 已经启动的 MCP 进程**不会被追溯提权**（`affectsRunningProcesses: false`）；
  - 授权撤销后新建的连接恢复受限策略。
- 本地 MCP 调用本身是进程间通信，不产生新的网络出口；它的网络能力由子进程的 OS 沙箱约束。
- 本地 stdio 调用需要人工审批时，capability 为 `mcp-local`（不是 `network`），reason 明确标注 stdio 与 OS 沙箱；远程调用才使用 `network`。

## 3. 远程服务（streamable-http / sse）

- 远程调用是一个**真实的网络出口**，因此遵守与 bash 相同的 `network` + `approval` 边界：

| network | approval | 远程 MCP 调用行为 |
| --- | --- | --- |
| allow | ask | 逐次人工审批 |
| allow | auto-grant | 无需审批（策略已允许网络） |
| allow | never | Fail-Closed（never 不询问） |
| deny | ask | 逐次人工审批，文案标注 `network: deny 需逐次授权` |
| deny | auto-grant | **Fail-Closed**：auto-grant 不能放宽显式 deny |
| deny | never | Fail-Closed，不弹窗 |
| deny | 无审批通道 | Fail-Closed，不因「无人可问」而放行 |

- URL 在配置阶段做语法校验与私有网段/云元数据 SSRF 阻断；探测使用 `resolveAndValidateHostIps()` 做真实 DNS 校验。
- **无法保证**：远端主机上的实际副作用。Nash 只能控制「是否发起调用」与「调用参数」，
  不能限制外部服务在其主机上读写文件、访问网络或创建子进程。
- 远端返回的内容属于**不可信输入**：可能包含诱导模型的文本（prompt injection）。
  结果超过阈值时优先落盘；没有落盘存储时强制截断，绝不整体注入上下文。

## 4. 任务级全访问授权（TaskSecurityGrant）

- 授权按 `nodeId + taskId + runId` 生效，写入的是该 Task 的 `SandboxService` 与 `FileSystemAccess`。
- MCP 适配器每次调用实时读取 `SandboxService.getPolicy()`，因此：
  - 授权后，同一 Task 的后续 MCP 调用立即按新策略判定；
  - 其他 Task 的 MCP 适配器持有各自的 `SandboxService`，不会串权；
  - 撤销后，后续调用立即恢复受限，已发生的远端副作用不回滚。
- `mcp_register` / `mcp_remove` 等管理工具**始终**要求人工审批，auto-grant 不适用；
  无审批通道时 Fail-Closed。
- 远程凭证必须显式声明 `bearerEnv`（环境变量引用）或 `credentialRef`（本地安全句柄）。
  实现**不会**再根据模型给出的服务名去猜测 `<NAME>_TOKEN` 之类的环境变量——
  否则模型只要把服务命名成某个机密变量的前缀、再填自己控制的 URL，就能借一次人工审批把密钥送出。

## 5. 确定性硬拦截

- `rm -rf /`、`chmod -R 777 /`、`/etc/shadow`、`/etc/sudoers`、fork bomb 等规则对
  `bash` **以及所有 `mcp__*` 工具**生效；工具名与参数包装不能绕过。
- 硬拦截不可被任何人工审批放行（`isHardBlock` 先于 `REQUIRE_APPROVAL` 生效）。

## 6. 安全边界与连接要求

1. 远程 MCP 的实际副作用不可观测，也无法由本地沙箱约束。
2. 运行时传输复用配置阶段的 URL，连接建立后不再做 DNS 重绑定校验（配置阶段已校验）。
3. MCP 工具结果可能与内置工具结果一样携带诱导性文本；安全审查只覆盖**调用前**的参数，
   不覆盖调用后的结果内容。
4. 长生命周期 MCP Server 的沙箱策略固定在启动时刻；需要新策略时必须重连。

## 7. 验证方式

```bash
node scripts/run-tests.js unit   # 含 test/mcp-security-boundary.test.ts
```

该套件使用**真实 MCP Server**（`test/fixtures/mock-http-server.ts`，走真实 MCP 协议与真实连接管理器），
覆盖：`deny+ask` 放行/拒绝、`deny+auto-grant` 拒绝、`never` 拒绝、`allow+auto-grant` 放行、
无审批通道拒绝、授权/撤销实时生效、Task A/B 隔离、取消时 Outcome Unknown、硬拦截别名绕过、结果截断。
