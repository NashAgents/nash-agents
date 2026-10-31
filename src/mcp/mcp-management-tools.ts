import type { Tool } from "../tools/tool.js";
import type { ToolResult } from "../tools/executor.js";
import type { MCPManager } from "./mcp-manager.js";
import type { MCPServerConfig, MCPConfigScope } from "./types.js";
import {
  validateMCPUrl,
  safeProbeEndpoint,
  MCPSecurityError,
  redactHeaders,
} from "./mcp-security.js";
import type { ApprovalService } from "../approval/approval-service.js";
import crypto from "node:crypto";

/**
 * 暂存的添加提案缓存（用于确认校验）
 */
interface PendingProposal {
  id: string;
  name: string;
  config: MCPServerConfig;
  scope: MCPConfigScope;
  requiresAuth: boolean;
  authType: "none" | "bearer" | "oauth";
  discoveredTools?: string[];
  expiresAt: number;
}

const activeProposals = new Map<string, PendingProposal>();

/**
 * 清理过期的提案
 */
function cleanupExpiredProposals(): void {
  const now = Date.now();
  for (const [id, prop] of activeProposals.entries()) {
    if (prop.expiresAt < now) {
      activeProposals.delete(id);
    }
  }
}

// ==========================================
// 1. mcp_list_servers
// ==========================================
export class MCPListServersTool implements Tool {
  public readonly name = "mcp_list_servers";
  public readonly description =
    "查看当前已注册的全部 MCP (Model Context Protocol) 外部服务及其连接状态、作用域与工具数量。";

  public readonly parameters = {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["local", "project", "user", "global"],
        description: "可选：按配置作用域过滤",
      },
    },
  };

  constructor(private readonly mcpManager: MCPManager) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    try {
      const scopeFilter = args?.scope as MCPConfigScope | undefined;
      const statuses = this.mcpManager.listStatuses();

      const filtered = scopeFilter
        ? statuses.filter((s) => s.scope === scopeFilter || (scopeFilter === "user" && s.scope === "global"))
        : statuses;

      if (filtered.length === 0) {
        return {
          output: "当前未配置任何 MCP 服务。",
          success: true,
        };
      }

      const summary = filtered.map((s) => ({
        name: s.name,
        transport: s.transport,
        status: s.status,
        scope: s.scope,
        enabled: s.enabled,
        toolCount: s.toolCount,
        endpoint: s.endpoint,
        protocolVersion: s.protocolVersion,
        error: s.lastError,
      }));

      return {
        output: JSON.stringify(summary, null, 2),
        success: true,
      };
    } catch (err: unknown) {
      return {
        output: `查询 MCP 服务列表失败: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ==========================================
// 2. mcp_inspect_server
// ==========================================
export class MCPInspectServerTool implements Tool {
  public readonly name = "mcp_inspect_server";
  public readonly description =
    "查看指定 MCP 服务的详细连接信息、服务端协议能力、可用工具、Resources 与 Prompts。";

  public readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "MCP 服务名称 (例如 'bilibili-subtitles')",
      },
    },
    required: ["name"],
  };

  constructor(private readonly mcpManager: MCPManager) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args?.name ?? "").trim();
    if (!name) {
      return { output: "必须提供要查看的 MCP 服务名称 'name'。", success: false };
    }

    const status = this.mcpManager.getStatus(name);
    if (!status) {
      return { output: `未找到名为 '${name}' 的 MCP 服务。`, success: false };
    }

    const tools = this.mcpManager.connectionManager.getTools(name);
    const config = this.mcpManager.configManager.getServer(name);

    const result = {
      name: status.name,
      status: status.status,
      scope: status.scope,
      transport: status.transport,
      endpoint: status.endpoint,
      protocolVersion: status.protocolVersion,
      serverVersion: status.serverVersion,
      latencyMs: status.latencyMs,
      lastError: status.lastError,
      config: config
        ? {
            transport: config.transport,
            url: config.url,
            command: config.command,
            args: config.args,
            headers: redactHeaders(config.headers),
            enabled: config.enabled !== false,
            alwaysLoad: config.alwaysLoad,
          }
        : undefined,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: Object.keys((t.inputSchema?.properties as any) || {}),
      })),
    };

    return {
      output: JSON.stringify(result, null, 2),
      success: true,
    };
  }
}

// ==========================================
// 3. mcp_propose_add (带深度 DNS 预检与 302 防重定向逃逸)
// ==========================================
export class MCPProposeAddTool implements Tool {
  public readonly name = "mcp_propose_add";
  public readonly description =
    "解析用户提供的 MCP 地址（URL 或 stdio 命令），在 DNS 与网络层深度防御 SSRF，受控探测服务端协议与认证需求，生成待用户确认的配置提案。";

  public readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "建议的服务名称（仅包含字母、数字、短横线与下划线）",
      },
      url: {
        type: "string",
        description: "远程 MCP 服务端点 URL（用于 HTTP / SSE）",
      },
      command: {
        type: "string",
        description: "本地 stdio 可执行程序名称 (例如 'node', 'npx', 'python')",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "本地 stdio 进程参数",
      },
      transport: {
        type: "string",
        enum: ["streamable-http", "sse", "stdio"],
        description: "可选：传输协议类型。若未指定将根据 URL/命令自动探测推导",
      },
      scope: {
        type: "string",
        enum: ["local", "project", "user"],
        description: "配置作用域：local (项目私有，不入 git) | project (.mcp.json) | user (全局默认)",
      },
      env: {
        type: "object",
        description: "注入的环境变量字典",
      },
      headers: {
        type: "object",
        description: "自定义请求头",
      },
    },
  };

  constructor(private readonly mcpManager: MCPManager) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    cleanupExpiredProposals();

    let name = String(args?.name ?? "").trim();
    const url = args?.url ? String(args.url).trim() : undefined;
    const command = args?.command ? String(args.command).trim() : undefined;
    const stdioArgs = Array.isArray(args?.args) ? args.args.map(String) : undefined;
    let transport = args?.transport as "streamable-http" | "sse" | "stdio" | undefined;
    const scope = (args?.scope as MCPConfigScope) ?? "user";

    // 自动推断服务标识名
    if (!name) {
      if (url) {
        try {
          const u = new URL(url);
          name = u.hostname.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-");
          if (name.endsWith("-org") || name.endsWith("-com") || name.endsWith("-net")) {
            name = name.split("-")[0] || "mcp-server";
          }
        } catch {
          name = `mcp-${Date.now().toString(36)}`;
        }
      } else if (command) {
        name = `${command}-mcp`;
      } else {
        name = `server-${Date.now().toString(36)}`;
      }
    }

    name = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();

    if (!transport) {
      if (url) {
        transport = "streamable-http";
      } else if (command) {
        transport = "stdio";
      } else {
        return {
          output: "错误：必须提供远程服务的 'url' 或本地服务的 'command' 命令行。",
          success: false,
        };
      }
    }

    let authType: "none" | "bearer" | "oauth" = "none";
    let requiresAuth = false;
    let authNote = "无需认证";
    const discoveredTools: string[] = [];

    // 网络级安全探测：调用 safeProbeEndpoint 进行真实 DNS 解析预检与 302 审查
    if (url && (transport === "streamable-http" || transport === "sse")) {
      try {
        const probeRes = await safeProbeEndpoint(url, {
          allowInsecure: Boolean(args?.allowInsecureHttp),
          timeoutMs: 5000,
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "nash-prober", version: "1.0.0" },
            },
            id: 1,
          }),
        });

        if (probeRes.status === 401 || probeRes.status === 403) {
          requiresAuth = true;
          const wwwAuth = probeRes.headers.get("www-authenticate") || "";
          if (wwwAuth.toLowerCase().includes("bearer")) {
            authType = "bearer";
            authNote = "需要 Bearer Token 鉴权";
          } else if (wwwAuth.toLowerCase().includes("oauth") || wwwAuth.toLowerCase().includes("authorization_uri")) {
            authType = "oauth";
            authNote = "需要 OAuth 2.0 登录授权";
          } else {
            authType = "bearer";
            authNote = "服务端要求身份认证 (HTTP 401/403)";
          }
        }
      } catch (err: unknown) {
        if (err instanceof MCPSecurityError) {
          return {
            output: `安全阻断: ${err.message}`,
            success: false,
          };
        }
      }
    }

    const config: MCPServerConfig = {
      name,
      transport,
      url,
      command,
      args: stdioArgs,
      headers: args?.headers as Record<string, string> | undefined,
      env: args?.env as Record<string, string> | undefined,
      scope,
      enabled: true,
      alwaysLoad: "auto",
    };

    const proposalId = crypto.randomUUID();
    const proposal: PendingProposal = {
      id: proposalId,
      name,
      config,
      scope,
      requiresAuth,
      authType,
      discoveredTools,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    activeProposals.set(proposalId, proposal);

    const proposalView = {
      proposalId,
      name,
      endpoint: url || (command ? `${command} ${(stdioArgs || []).join(" ")}` : "unknown"),
      transport,
      scope,
      requiresAuth,
      authType,
      authNote,
      securityWarning:
        transport === "stdio"
          ? "注意：stdio 进程将在 OS 原生沙箱限制中运行（受工作区写与网络阻断限制）。"
          : "注意：该远程 MCP 服务将向外部网络发送请求。",
      nextStep: requiresAuth
        ? `该服务需要凭据。为保障安全，切勿在对话中发送明文 Token！推荐在宿主环境设置环境变量（如 export BILIBILI_MCP_TOKEN=...），并在调用 mcp_register 时指定 bearerEnv: "BILIBILI_MCP_TOKEN" 完成注册。`
        : `请调用 mcp_register(confirmationToken: "${proposalId}") 提交人机审批并正式连接该服务。`,
    };

    return {
      output: JSON.stringify(proposalView, null, 2),
      success: true,
    };
  }
}

// ==========================================
// 4. mcp_register (严格 Fail-Closed 审批与零密钥泄露防线)
// ==========================================
export class MCPRegisterTool implements Tool {
  public readonly name = "mcp_register";
  public readonly description =
    "经由用户在交互通道中明确确认后，正式持久化注册 MCP 服务。严禁传递明文密钥（必须使用 bearerEnv 或 credentialRef），无审批通道严格 Fail-Closed 拒绝执行。";

  public readonly parameters = {
    type: "object",
    properties: {
      confirmationToken: {
        type: "string",
        description: "由 mcp_propose_add 返回的提案确认 token (proposalId)",
      },
      name: {
        type: "string",
        description: "服务标识名称",
      },
      transport: {
        type: "string",
        enum: ["streamable-http", "sse", "stdio"],
        description: "传输类型",
      },
      url: {
        type: "string",
        description: "远程端点 URL",
      },
      command: {
        type: "string",
        description: "stdio 可执行命令",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "stdio 参数",
      },
      scope: {
        type: "string",
        enum: ["local", "project", "user"],
        description: "配置作用域 (默认为 user 全局生效)",
      },
      bearerEnv: {
        type: "string",
        description: "存放 Token 的环境变量名称（例如 'BILIBILI_MCP_TOKEN'，绝不传递明文 Token）",
      },
      credentialRef: {
        type: "string",
        description: "由 TUI 安全掩码输入组件直接录入生成的凭证引用句柄 (例如 'cred_ref_xxxx')",
      },
      headers: {
        type: "object",
        description: "自定义请求头",
      },
      alwaysLoad: {
        type: "boolean",
        description: "是否让此服务的所有工具直接全部加载至模型请求中",
      },
    },
  };

  constructor(
    private readonly mcpManager: MCPManager,
    private readonly approvalService?: ApprovalService
  ) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    cleanupExpiredProposals();

    const confToken = args?.confirmationToken ? String(args.confirmationToken).trim() : undefined;
    let proposal = confToken ? activeProposals.get(confToken) : undefined;

    let name = String(args?.name ?? proposal?.name ?? "").trim();
    if (!name && proposal) name = proposal.name;
    if (!name) {
      return { output: "错误：必须提供服务名称 'name' 或有效的 'confirmationToken'。", success: false };
    }

    // 铁律 1：Fail-Closed 审批防线
    // 若不存在 ApprovalService 或没有任何交互提供者 (hasProvider() === false)，坚决拒绝持久化注册！
    if (!this.approvalService || !this.approvalService.hasProvider()) {
      return {
        output: `安全阻断 (Fail-Closed): 当前未连接有效的人机协同审批通道 (ApprovalProvider)。LLM 禁止在未经人工交互确认授权的情况下持久化注册或修改外部 MCP 服务。`,
        success: false,
        error: "ApprovalProvider required but unavailable",
      };
    }

    const transport = (args?.transport as any) || proposal?.config.transport || "streamable-http";
    const url = args?.url ? String(args.url).trim() : proposal?.config.url;
    const command = args?.command ? String(args.command).trim() : proposal?.config.command;
    const stdioArgs = (args?.args as string[]) || proposal?.config.args;
    const scope = ((args?.scope as any) || proposal?.scope || "user") as MCPConfigScope;
    const alwaysLoad = args?.alwaysLoad !== undefined ? Boolean(args.alwaysLoad) : proposal?.config.alwaysLoad;

    const headers: Record<string, string> = {
      ...(proposal?.config.headers ?? {}),
      ...((args?.headers as Record<string, string>) ?? {}),
    };

    // 铁律 2：凭证零泄露安全引用解析 (环境变量引用优先，或安全句柄)
    const bearerEnv = args?.bearerEnv ? String(args.bearerEnv).trim() : undefined;
    const credRef = args?.credentialRef ? String(args.credentialRef).trim() : undefined;

    if (bearerEnv) {
      headers["Authorization"] = `Bearer \${${bearerEnv}}`;
    } else if (credRef) {
      const boundServer = this.mcpManager.credentialStore.resolveCredentialRef(credRef);
      if (boundServer) {
        // 凭证已在本地 Store 中绑定
      }
    }
    // 安全铁律：绝不根据模型提供的服务名去猜测并自动绑定进程环境中的密钥
    // （例如 '<NAME>_TOKEN'）。否则模型只要把服务命名成与某个机密变量前缀相同，
    // 再填一个自己控制的 URL，就能在人工审批的表象下把该密钥发送到外部主机。
    // 远程凭证必须由调用方显式声明 bearerEnv / credentialRef。

    const config: MCPServerConfig = {
      name,
      transport,
      url,
      command,
      args: stdioArgs,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      scope,
      enabled: true,
      alwaysLoad,
    };

    // 发起人机审批 (HITL)
    const decision = await this.approvalService.requestApproval({
      reason: `注册并持久化挂载新的 MCP 服务 '${name}' (作用域: ${scope}, 协议: ${transport})`,
      capability: "mcp-registration",
      target: url || command || name,
      toolName: "mcp_register",
      toolArgsSummary: `name=${name}, transport=${transport}, scope=${scope}`,
    });

    if (decision !== "allow-once") {
      return {
        output: `用户在审批界面拒绝了 MCP 服务 '${name}' 的注册请求。操作已取消。`,
        success: false,
      };
    }

    try {
      await this.mcpManager.addServer(name, config, scope);

      if (confToken) {
        activeProposals.delete(confToken);
      }

      const status = this.mcpManager.getStatus(name);
      const tools = this.mcpManager.connectionManager.getTools(name);
      const isConnected = status?.status === "connected";
      const isAuthError = Boolean(
        status?.lastError &&
          (status.lastError.includes("401") ||
            status.lastError.includes("Unauthorized") ||
            status.lastError.includes("requires authorization"))
      );

      const structuredResult = {
        registration: {
          success: true,
          persisted: true,
          name,
          scope: status?.scope,
        },
        connection: {
          success: isConnected,
          status: isConnected ? "connected" : (isAuthError ? "needs_auth" : (status?.status ?? "failed")),
          protocolVersion: status?.protocolVersion,
          error: isConnected ? undefined : status?.lastError,
        },
        tools: {
          registered: tools.length,
          discoveredTools: tools.map((t) => t.name),
        },
        instructions: isConnected
          ? `✅ MCP 服务 '${name}' 注册并连接成功，已挂载 ${tools.length} 个工具，可在下一轮中直接调用。`
          : `⚠️ MCP 服务 '${name}' 配置已持久化，但连接未能建立 (${isAuthError ? "需要认证 401" : status?.lastError})，工具尚未激活。`,
      };

      return {
        output: JSON.stringify(structuredResult, null, 2),
        success: isConnected, // 只有连接与工具都就绪才返回 true，严谨区分持久化与连接
        error: isConnected ? undefined : status?.lastError,
      };
    } catch (err: unknown) {
      return {
        output: JSON.stringify({
          registration: { success: false, persisted: false, error: err instanceof Error ? err.message : String(err) },
          connection: { success: false, status: "failed" },
          tools: { registered: 0 },
        }, null, 2),
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ==========================================
// 5. mcp_remove_server (严格 Fail-Closed 审批)
// ==========================================
export class MCPRemoveServerTool implements Tool {
  public readonly name = "mcp_remove_server";
  public readonly description =
    "删除已配置的 MCP 服务，断开连接并从当前会话注销其关联的所有工具。必须经人工审批授权。";

  public readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "要删除的 MCP 服务名称",
      },
      scope: {
        type: "string",
        enum: ["local", "project", "user"],
        description: "可选：指定删除的作用域",
      },
    },
    required: ["name"],
  };

  constructor(
    private readonly mcpManager: MCPManager,
    private readonly approvalService?: ApprovalService
  ) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args?.name ?? "").trim();
    if (!name) {
      return { output: "必须提供要删除的服务名称 'name'。", success: false };
    }

    // Fail-Closed
    if (!this.approvalService || !this.approvalService.hasProvider()) {
      return {
        output: `安全阻断 (Fail-Closed): 当前未连接有效的人机审批通道。LLM 禁止在未经人工审批的情况下删除系统 MCP 服务。`,
        success: false,
      };
    }

    const decision = await this.approvalService.requestApproval({
      reason: `删除 MCP 服务 '${name}' 并注销其全部工具`,
      capability: "mcp-registration",
      target: name,
      toolName: "mcp_remove_server",
    });

    if (decision !== "allow-once") {
      return { output: `用户取消了删除 MCP 服务 '${name}' 的操作。`, success: false };
    }

    const scope = args?.scope as MCPConfigScope | undefined;
    const removed = await this.mcpManager.removeServer(name, scope);

    if (removed) {
      return {
        output: `✅ MCP 服务 '${name}' 已成功删除，并已从当前运行时安全注销。`,
        success: true,
      };
    } else {
      return {
        output: `未找到或未能删除 MCP 服务 '${name}'。`,
        success: false,
      };
    }
  }
}

// ==========================================
// 6. mcp_set_enabled
// ==========================================
export class MCPSetEnabledTool implements Tool {
  public readonly name = "mcp_set_enabled";
  public readonly description = "启用或暂时禁用指定的 MCP 服务。";

  public readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "MCP 服务名称",
      },
      enabled: {
        type: "boolean",
        description: "true 表示启用，false 表示禁用",
      },
    },
    required: ["name", "enabled"],
  };

  constructor(private readonly mcpManager: MCPManager) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args?.name ?? "").trim();
    const enabled = Boolean(args?.enabled);

    if (enabled) {
      const ok = await this.mcpManager.enableServer(name);
      return {
        output: ok ? `✅ MCP 服务 '${name}' 已启用并重新连接。` : `未找到服务 '${name}'。`,
        success: ok,
      };
    } else {
      const ok = await this.mcpManager.disableServer(name);
      return {
        output: ok ? `✅ MCP 服务 '${name}' 已禁用，工具已注销。` : `未找到服务 '${name}'。`,
        success: ok,
      };
    }
  }
}

// ==========================================
// 7. mcp_reconnect_server
// ==========================================
export class MCPReconnectServerTool implements Tool {
  public readonly name = "mcp_reconnect_server";
  public readonly description = "重新连接发生故障或中断的 MCP 服务，并刷新其工具列表。";

  public readonly parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "MCP 服务名称",
      },
    },
    required: ["name"],
  };

  constructor(private readonly mcpManager: MCPManager) {}

  async execute(args?: Record<string, unknown>): Promise<ToolResult> {
    const name = String(args?.name ?? "").trim();
    if (!name) {
      return { output: "必须提供要重连的服务名称 'name'。", success: false };
    }

    try {
      await this.mcpManager.reconnectServer(name);
      const status = this.mcpManager.getStatus(name);
      return {
        output: `✅ MCP 服务 '${name}' 重连完成。当前状态: ${status?.status}，可用工具数: ${status?.toolCount}。`,
        success: true,
      };
    } catch (err: unknown) {
      return {
        output: `重连服务 '${name}' 失败: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
