# 主模型、安全模型与网关

Coordinator 需要配置默认主模型。每个模型配置独立选择 Base URL、模型名、API Key、协议、超时、流式与工具调用选项。不要把凭据放在 Base URL 的用户名、查询参数或路径中。

| 协议 | 配置值 | 标准端点 |
| --- | --- | --- |
| Chat Completions | `completions` | `/v1/chat/completions` |
| Responses | `responses` | `/v1/responses` |
| Anthropic Messages | `messages` | `/v1/messages` |

Base URL 按 Provider 的实际前缀填写；部分兼容服务使用不同路径，测试连接时核对实际端点，避免重复附加 `/v1`。协议格式相似不等于行为完全兼容。

## 安全模型关系

- **跟随主模型**（`follow-main`）：保存关系引用。主模型调整后，新请求解析到新版本，不是初始化时复制一次。
- **同 Provider 不同模型**（`same-provider`）：复用主模型服务与凭据，单独指定安全模型名称。
- **完全独立**（`independent`）：使用自己的协议、服务、模型和凭据。
- Worker 可以选择本节点主模型关系或 Coordinator 安全模型（`coordinator`）。

即使使用同一个模型，安全审查使用独立上下文和权限约束。不能通过关闭安全审查换取任务成功。

## Worker 继承

默认通过认证的 Model Gateway 调用 Coordinator 配置，Node Identity 只用于节点身份认证。Coordinator 不向 Worker 下发 Provider API Key。选择本地独立模型意味着该 Worker 使用其明确配置的 Provider 与凭据，需要相应网络权限。

新请求使用当前配置版本；进行中的模型请求应保留启动时的版本。API Key 在后台受保护存储，公开配置只显示是否已设置，不回显原文。备份需同时包含数据库和匹配的 `master.key`。

## 兼容性验收

每个真实 Provider/Model/协议组合分别验证：文本、流式增量、工具调用及参数、多轮工具结果、取消、错误、超时、Usage；随后验证主模型和安全模型、继承与节点覆盖。单次文本响应或 `/models` 成功不能作为 AgentLoop 全兼容证明。测试结果应记录配置版本和脱敏请求 ID，不记录 API Key。

未经真实请求验证的组合保持“未验证”，不能因为其他协议通过而沿用结论。
