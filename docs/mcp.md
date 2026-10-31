# Nash Agents 的 Model Context Protocol（MCP）

Nash Agent 原生集成了 **Model Context Protocol (MCP)** 协议（采用 `@modelcontextprotocol/client` 官方 SDK v2），使 Nash 能够连接任意本地与远程 MCP 服务，自主发现工具、资源与提示词，并无缝纳入 Nash 已有的进程沙箱、人机审批、SpillStore 大结果防爆与生命周期 Hook 体系。

---

## 核心功能与实现

| 功能维度 | 通用交互目标 | Nash 当前工程实现 | 状态 |
| :--- | :--- | :--- | :--- |
| **添加方式** | CLI 命令 / 自然语言 / JSON 导入 | `nash mcp add` / 自然语言 / `add-json` / `import` | ✅ Implemented |
| **交互式管理** | CLI 交互向导 / `/mcp` 菜单 | `nash mcp` (TTY 向导) / `/mcp` Slash 菜单 | ✅ Implemented |
| **自然语言管理** | 提示词驱动添加与管理 | `mcp_propose_add` / `mcp_register` 等 7 大工具 | ✅ Implemented |
| **配置作用域** | Local > Project > User | Local (`~/.nash-agents/projects/`) > Project (`.mcp.json`) > User (`~/.nash-agents/settings.json`) | ✅ Implemented |
| **项目级信任** | Workspace Trust (拦截恶意 stdio) | 关联物理路径与配置指纹 (SHA-256)，`nash mcp trust` 批准 | ✅ Implemented |
| **身份认证** | Bearer Token / OAuth 2.0 PKCE | `CredentialStore` 隔离存储 + `MCPOAuthHandler` PKCE 授权 | ✅ Implemented |
| **配置热更新** | 运行时变更下一轮即时生效 | `MCPManager.reload()` + `AgentLoop` 动态获取 definitions | ✅ Implemented |
| **工具发现决策** | Context Budget 自适应调度 | 基于模型上下文预算 + Server 级 `alwaysLoad` + 语义检索 | ✅ Implemented |
| **资源与模板** | `@server:uri` 引用 / `/server:prompt` | `resolveUserMessageMcpResources` + `/prompt` Slash 命令 | ✅ Implemented |
| **故障诊断** | 详细错误排查报告 | `nash mcp doctor` 全方位系统健康体检 | ✅ Implemented |
| **stdio 沙箱** | 系统隔离约束 | 接入 `SandboxService`，强制 macOS Seatbelt / Linux Bubblewrap | ✅ Implemented |
| **网络安全** | 私有网络与 SSRF 防御 | `validateMCPUrl` 阻断内网私有网段与云元数据地址 (169.254.169.254) | ✅ Implemented |

---

## 🗣️ 自然语言管理 MCP

用户无需记忆复杂的 CLI 命令参数，可以直接在对话中通过自然语言管理 MCP：

- **添加 MCP**：“帮我添加这个 MCP: https://mcp.example.com/mcp”
- **查看状态**：“帮我看看为什么 Bilibili MCP 连接不上”
- **临时禁用**：“把这个 MCP 暂时禁用”
- **删除服务**：“删除刚刚添加的 MCP”

### 运行机制流程
1. LLM 识别 MCP 管理意图；
2. 调用 `mcp_propose_add` 进行受控探测，检查协议类型、认证需求与暴露工具；
3. 向用户展示提案摘要（名称、作用域、凭据类型与安全告警）；
4. 用户确认（通过 `ApprovalService` 人机交互）；
5. 调用 `mcp_register` 完成持久化并建立连接；
6. 自动挂载至当前会话的 `ToolRegistry`，**下一轮迭代无需重启即可直接调用**。

---

## 🏛️ 作用域体系与优先级 (Local > Project > User)

1. **`Local Scope`**：
   - 存储位置：`~/.nash-agents/projects/<project-hash>/mcp.json`
   - 适用场景：个人专属开发环境、本地私有数据库，**绝对不入 Git 仓库**。
2. **`Project Scope`**：
   - 存储位置：项目根目录 `.mcp.json`（兼容 `./settings.json`）
   - 适用场景：团队共享服务，可提交至 Git。**严禁提交明文 Token**，必须使用环境变量引用（如 `${VAR}`）。
3. **`User Scope (Global)`**：
   - 存储位置：`~/.nash-agents/settings.json`
   - 适用场景：跨项目通用的通用工具（如 Bilibili 字幕、GitHub、Web Search）。

---

## 🔐 安全与凭证存储 (CredentialStore)

- **物理隔离**：Token 与凭据存储在 `~/.nash-agents/credentials.json`（受控权限 0600），配置文件中仅保留 `${VAR}` 占位。
- **OAuth 2.0 PKCE**：支持 RFC 7636 标准授权码流程，自动启动本地监听捕获 Callback，支持 Token 自动刷新与登出清理。
- **stdio 内核沙箱**：stdio 子进程通过 `SandboxService.buildExecutionSpec` 启动，macOS 下强制应用 Scheme Profile，Linux 下强制 Bubblewrap 隔离，环境变量严格清洗敏感 API Key。
- **SSRF 拦截**：针对远程端点校验，自动阻断访问 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.169.254`（云元数据）等私有 IP。
- **策略与审批边界**：远程 MCP 调用与内置工具共用 `network` / `approval` 边界
  （`deny + auto-grant` 拒绝、`never` 不弹窗直接 Fail-Closed），
  确定性硬拦截对 `mcp__*` 工具同样生效。安全机制、远程服务的权限边界与连接要求见
  [MCP 工具的安全边界](security/mcp-boundaries.md)。

---

## 🛠️ CLI 命令大全 (`nash mcp`)

```bash
# 1. 启动交互式向导 (TTY 下推荐)
nash mcp

# 2. 列出已配置服务与运行状态
nash mcp list

# 3. 添加远程服务 (Streamable HTTP)
nash mcp add bilibili-subtitles \
  --transport streamable-http \
  --url https://mcp.example.com/mcp \
  --bearer-env BILIBILI_MCP_TOKEN \
  --scope user

# 4. 通过 JSON 字符串或文件导入服务
nash mcp add-json my-tools '{"type":"http","url":"https://example.com/mcp"}'

# 5. 从 Claude Desktop 或 Cursor 导入配置
nash mcp import --from-claude-desktop
nash mcp import --from-cursor
nash mcp import --from-file ./custom-mcp.json

# 6. 系统健康度全方位诊断
nash mcp doctor

# 7. 批准信任当前项目的 .mcp.json (Workspace Trust)
nash mcp trust

# 8. OAuth 登录与登出
nash mcp login github-mcp
nash mcp logout github-mcp

# 9. 连通性测试与工具发现
nash mcp test bilibili-subtitles
nash mcp tools bilibili-subtitles

# 10. 服务生命周期控制
nash mcp enable bilibili-subtitles
nash mcp disable bilibili-subtitles
nash mcp reconnect bilibili-subtitles
nash mcp remove bilibili-subtitles
```

---

## 🖥️ REPL Slash 命令与快捷引用

- **/mcp**：在对话界面中查看状态卡片，支持 `list`、`test`、`tools`、`doctor`、`trust`、`login` 等子命令。
- **/prompt [server] [name]**：查看并调用远程 MCP 提供的提示词模板，支持参数填入。
- **@server:resource_uri**：在用户输入中直接引用远程资源（例如 `@res-srv:memo://project-notes`），Nash 自动抓取内容并作为上下文注入。
