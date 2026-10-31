# 安全配置

产品初始化默认使用**受限模式**：`workspace-write` + `network: deny` + `approval: ask`，同时开启 Security Monitor 与独立 Security LLM。完全访问自主模式（`danger-full-access` + `network: allow` + `approval: auto-grant`）必须显式选择：交互向导会展示风险并要求确认；非交互产品初始化必须在配置中同时提供这三个值并设置 `confirmFullAccess: true`。产品初始化后通过 **Web → Security** 修改安全配置；产品 CLI 的 `config` 仅支持查看、校验和版本回滚，不提供 `config set security`。开发者 REPL 的 `NASH_INIT_ACCESS_MODE` / `nash config set security` 属于另一套开发配置，不改变产品 `NASH_HOME` 的默认值。既有安装的配置永不迁移或覆盖。

`auto-grant` 的语义是「安全审查通过后自动执行」，不是「跳过检查」：

- 确定性硬拦截（破坏性删除、特权路径篡改、保留设备名、凭据外泄管道）任何人工审批都不能放行；
- Security LLM 不可用或输出不可解析时按 Fail-Closed 拒绝，绝不静默放行；
- 关闭审查模型不会关闭确定性硬拦截，放行结论会标注 `SYSTEM_FAILURE` 并写入审计；
- 完全访问只扩大授权范围，**该模式下不再有完整的文件系统隔离保证**。

每个节点独立探测原生沙箱；缺少 helper、内核能力不足或策略无法执行时仍然 Fail-Closed。

| 模式 | 用途 |
| --- | --- |
| read-only | 授权范围内只读检查 |
| workspace-write | 在明确授权工作区内修改文件 |
| danger-full-access | 用户明确确认后的完全访问，隔离保障相应降低 |

不要把完全访问当成处理安装失败的方法。文件访问基于 realpath 和项目授权，不能用符号链接把授权扩展到任意目录。网络、审批和工具授权属于独立维度。

Web Security 修改后核对保存结果、配置版本与生效范围。权限撤销应及时传递到 Worker；离线节点重连前必须重新同步，不能因离线沿用已撤销权限。

审批仅允许一次具体操作，不能把一次批准变成持久授权。保留批准/拒绝、操作者、时间、任务及配置版本。禁止通过自动同意或禁用 Security Monitor 使验收通过。

产品目录包含管理员记录、模型凭据密文、密钥、节点身份与会话数据。限制文件/目录访问；Windows 应使用当前用户 ACL，不能仅依赖 POSIX 权限位的表现。数据库和同目录主密钥一起被窃取时，磁盘加密本身不足以保护 API Key。

跨不可信网络使用可信 HTTPS/WSS，并限制控制台入口。默认 HTTP 本地地址不是互联网部署方案。

当前产品初始化和启动流程尚未配置协调器的 TLS 证书；直接绑定局域网地址时，HTTP/WebSocket 通信是明文，可能暴露登录信息、邀请和节点凭据。跨机器使用前需要部署并验证可信的 TLS 终止及受保护的后端链路（推荐方案：前端反向代理 Nginx/Caddy 终结 TLS 并代理到 127.0.0.1，或使用 WireGuard/Tailscale 点对点内核加密网络）；禁止将当前明文服务直接暴露到公网。此部署方式及证书验证仍需真实环境验收。

macOS 钥匙串 MCP 凭据服务名称已升级为 `nash-agents-mcp-credentials` 独立命名空间，并保留对 Legacy 服务名 `nash-mcp-credentials` 的向下平滑迁移与自动写入能力。
