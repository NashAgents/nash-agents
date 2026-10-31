/**
 * MCP (Model Context Protocol) 核心类型与接口定义
 */

export type MCPTransportType = "stdio" | "streamable-http" | "sse";

export type MCPConnectionStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "needs_authentication"
  | "pending_approval"
  | "configured";

export type MCPConfigScope = "local" | "project" | "user" | "global";

export type MCPTrustStatus = "pending" | "approved" | "rejected";

export interface MCPOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  redirectUri?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface MCPReconnectPolicy {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

export interface MCPServerConfig {
  /**
   * 服务唯一名称（标识符）
   */
  name?: string;

  /**
   * 传输协议类型：stdio | streamable-http | sse
   */
  transport: MCPTransportType;

  /**
   * 远程服务 URL（用于 streamable-http 或 sse）
   */
  url?: string;

  /**
   * stdio 子进程可执行命令
   */
  command?: string;

  /**
   * stdio 子进程命令行参数
   */
  args?: string[];

  /**
   * 环境变量映射（支持 ${ENV_VAR} 语法，仅向 stdio 子进程注入指定的环境变量）
   */
  env?: Record<string, string>;

  /**
   * 自定义 HTTP 请求头（支持 ${ENV_VAR} 语法，用于 Bearer Token 等鉴权）
   */
  headers?: Record<string, string>;

  /**
   * 是否启用，默认为 true
   */
  enabled?: boolean;

  /**
   * 请求超时时间（毫秒），默认 30000ms
   */
  timeoutMs?: number;

  /**
   * 重连策略
   */
  reconnect?: MCPReconnectPolicy;

  /**
   * 允许调用的工具白名单（支持通配符 "*"）
   */
  allowTools?: string[];

  /**
   * 禁止调用的工具黑名单
   */
  denyTools?: string[];

  /**
   * 是否允许非 TLS 的公网 HTTP 连接（默认仅允许 loopback）
   */
  allowInsecureHttp?: boolean;

  /**
   * 配置所在作用域: local (项目私有不入 git) | project (.mcp.json) | user (NASH_HOME/settings.json，默认 ~/.nash-agents)
   */
  scope?: MCPConfigScope;

  /**
   * 服务描述说明（可选）
   */
  description?: string;

  /**
   * 工具加载策略：true (始终直接加载全部工具 Schema) | false (按需延迟发现) | "auto" (根据上下文预算自适应)
   */
  alwaysLoad?: boolean | "auto";

  /**
   * 项目级 MCP 的安全信任状态
   */
  trustStatus?: MCPTrustStatus;

  /**
   * 配置指纹（SHA-256），用于检测命令/参数/URL 变动后重新触发信任审批
   */
  fingerprint?: string;

  /**
   * OAuth 认证配置
   */
  oauth?: MCPOAuthConfig;

  /**
   * 自动放行的工具列表（免去 HITL 审批交互）
   */
  autoApproveTools?: string[];
}

export interface MCPServerSettings {
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface MCPServerStatusInfo {
  name: string;
  transport: MCPTransportType;
  status: MCPConnectionStatus;
  scope: MCPConfigScope;
  enabled: boolean;
  endpoint?: string;
  protocolVersion?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: number;
  lastError?: string;
  latencyMs?: number;
  trustStatus?: MCPTrustStatus;
  authStatus?: "none" | "authenticated" | "needs_authentication" | "expired";
}

export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
  isSideEffecting?: boolean;
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverName: string;
}

export interface MCPTestResult {
  serverName: string;
  transport: MCPTransportType;
  success: boolean;
  latencyMs: number;
  protocolVersion?: string;
  serverInfo?: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
  toolCount: number;
  tools?: string[];
  error?: string;
}
