import type { ToolExecutionContext } from "../tools/tool.js";
import type { Tool } from "../tools/tool.js";
import type { ToolResult } from "../tools/executor.js";
import type { ApprovalService } from "../approval/approval-service.js";
import type { MCPResultAdapter } from "./mcp-result-adapter.js";
import type { MCPServerConfig } from "./types.js";
import type { SandboxPolicy } from "../sandbox/types.js";

/**
 * 将任意字符串标准化为合法的 LLM Function 名称标识符 ([a-zA-Z0-9_-]+)
 */
export function sanitizeIdentifier(str: string): string {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 构造统一唯一的 MCP Tool 外部名称
 */
export function buildMCPToolName(serverName: string, rawToolName: string): string {
  const s = sanitizeIdentifier(serverName);
  const t = sanitizeIdentifier(rawToolName);
  return `mcp__${s}__${t}`;
}

/**
 * 将 MCP inputSchema 清洗转换为标准的 Function Calling JSON Schema
 */
export function normalizeInputSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return {
      type: "object",
      properties: {},
    };
  }

  const normalized: Record<string, unknown> = {
    type: schema.type || "object",
    properties: (schema.properties && typeof schema.properties === "object") ? schema.properties : {},
  };

  if (Array.isArray(schema.required)) {
    normalized.required = schema.required;
  }

  if (schema.description && typeof schema.description === "string") {
    normalized.description = schema.description;
  }

  return normalized;
}

export interface MCPToolInvocationContext {
  agentId?: string;
  sessionId?: string;
  toolCallId?: string;
}

export interface MCPToolAdapterOptions {
  serverName: string;
  serverConfig: MCPServerConfig;
  rawTool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  };
  callToolHandler: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  resultAdapter: MCPResultAdapter;
  approvalService?: ApprovalService;
  /** 实时审批模式读取器：auto-grant 下本任务已由安全模型审查，不再逐次人工审批。 */
  getApprovalMode?: () => string | undefined;
  /**
   * 实时沙箱策略读取器。MCP 远程调用是一个真实的网络出口，
   * 必须与 bash / 文件工具遵守同一套 network + approval 边界。
   */
  getPolicy?: () => SandboxPolicy | undefined;
}

/**
 * 将单个 MCP 远程工具封装为 Nash 本地 Tool 接口实例
 */
export class MCPToolAdapter implements Tool {
  public readonly name: string;
  public readonly description: string;
  public readonly parameters: Record<string, unknown>;
  public readonly serverName: string;
  public readonly rawToolName: string;

  private readonly serverConfig: MCPServerConfig;
  private readonly callToolHandler: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  private readonly resultAdapter: MCPResultAdapter;
  private readonly approvalService?: ApprovalService;
  private readonly getApprovalMode?: () => string | undefined;
  private readonly getPolicy?: () => SandboxPolicy | undefined;

  constructor(options: MCPToolAdapterOptions) {
    this.serverName = options.serverName;
    this.serverConfig = options.serverConfig;
    this.rawToolName = options.rawTool.name;
    this.name = buildMCPToolName(options.serverName, options.rawTool.name);

    const desc = options.rawTool.description || `MCP Tool from server '${options.serverName}'`;
    this.description = `[MCP: ${options.serverName}] ${desc}`;
    this.parameters = normalizeInputSchema(options.rawTool.inputSchema);
    this.callToolHandler = options.callToolHandler;
    this.resultAdapter = options.resultAdapter;
    this.approvalService = options.approvalService;
    this.getApprovalMode = options.getApprovalMode;
    this.getPolicy = options.getPolicy;
  }

  /**
   * 工具执行核心逻辑
   */
  async execute(args: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult> {
    const startTime = Date.now();
    context?.signal?.throwIfAborted();

    // 1. 白名单与黑名单检查
    if (this.serverConfig.denyTools && this.serverConfig.denyTools.includes(this.rawToolName)) {
      return {
        success: false,
        output: `Error: 工具 '${this.rawToolName}' (服务: ${this.serverName}) 已被管理员黑名单禁用。`,
        error: "TOOL_DENIED_BY_POLICY",
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (this.serverConfig.allowTools && this.serverConfig.allowTools.length > 0) {
      const allowed =
        this.serverConfig.allowTools.includes("*") ||
        this.serverConfig.allowTools.includes(this.rawToolName);
      if (!allowed) {
        return {
          success: false,
          output: `Error: 工具 '${this.rawToolName}' 未在服务 '${this.serverName}' 的允许列表中。`,
          error: "TOOL_NOT_IN_ALLOWLIST",
          executionTimeMs: Date.now() - startTime,
        };
      }
    }

    // 2. 沙箱策略与人机协同审批检查
    // 铁律：MCP 调用与 bash / 文件工具共用同一套 network + approval 边界。
    //   - approval: never            → 不弹窗，直接 Fail-Closed（never 的语义是「不询问」）；
    //   - network: deny + auto-grant → 绝不静默放行（auto-grant 不能放宽显式 deny）；
    //   - network: deny + ask        → 由人工逐次授予一次；
    //   - 本地 stdio 服务由 OS 沙箱约束，且沿用原有的逐次审批语义。
    const policy = this.getPolicy?.();
    const policyApprovalMode = policy?.approval.mode;
    const approvalMode = policyApprovalMode ?? this.getApprovalMode?.();
    const isRemoteTransport = this.serverConfig.transport !== "stdio";
    const networkDenied = policy?.network?.mode === "deny";

    if (approvalMode === "never") {
      return {
        success: false,
        output: `[MCP Security] 当前策略为 approval: never，不存在交互式审批通道，已按 Fail-Closed 拒绝调用 MCP 工具 '${this.name}'。`,
        error: "APPROVAL_MODE_NEVER",
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (isRemoteTransport && networkDenied && approvalMode === "auto-grant") {
      return {
        success: false,
        output: `[MCP Security] 服务 '${this.serverName}' 为远程传输，当前策略明确禁止网络 (network: deny)，approval: auto-grant 不能放宽该边界。如需联网，请由管理员授予该 Task/Run 全访问，或将全局策略切换为 network: allow。`,
        error: "NETWORK_DENY_UNDER_AUTO_GRANT",
        executionTimeMs: Date.now() - startTime,
      };
    }

    if (this.approvalService && approvalMode !== "auto-grant") {
      const approvalDecision = await this.approvalService.requestApproval({
        reason: isRemoteTransport
          ? (networkDenied
              ? `执行 MCP 远程工具 (network: deny 需逐次授权): ${this.serverName} -> ${this.rawToolName}`
              : `执行 MCP 远程工具: ${this.serverName} -> ${this.rawToolName}`)
          : `执行本地 MCP 工具 (stdio，受 OS 沙箱约束): ${this.serverName} -> ${this.rawToolName}`,
        // 本地 stdio 是进程间通信，不是网络出口；它的网络能力由子进程的 OS
        // 沙箱约束。把本地调用标成 network 会让审计和 UI 误报为远程出网。
        capability: isRemoteTransport ? "network" : "mcp-local",
        toolName: this.name,
        target: `${this.serverName}:${this.rawToolName}`,
        toolArgsSummary: JSON.stringify(args),
      }, { signal: context?.signal });
      context?.signal?.throwIfAborted();

      if (approvalDecision !== "allow-once") {
        return {
          success: false,
          output: "PERMISSION_DENIED: 用户拒绝了执行该 MCP 工具的请求",
          error: "APPROVAL_DENIED",
          executionTimeMs: Date.now() - startTime,
        };
      }
    } else if (isRemoteTransport && networkDenied && policyApprovalMode !== undefined) {
      // 显式 deny 且没有任何审批通道：绝不能因为「没有人可以问」而放行。
      return {
        success: false,
        output: `[MCP Security] 当前策略禁止网络 (network: deny) 且没有可用的审批通道，已按 Fail-Closed 拒绝远程 MCP 调用 '${this.name}'。`,
        error: "NETWORK_APPROVAL_UNAVAILABLE",
        executionTimeMs: Date.now() - startTime,
      };
    }

    // 3. 实际向 MCP 客户端分发调用
    try {
      context?.signal?.throwIfAborted();
      const rawResult = await this.callToolHandler(this.rawToolName, args, context?.signal);
      return await this.resultAdapter.formatResult(
        rawResult,
        this.name,
        undefined,
        Date.now() - startTime
      );
    } catch (err: unknown) {
      const errMsg = context?.signal?.aborted ? "MCP 调用已取消，远端执行结果未知 (Outcome Unknown)，不得自动重试。" : err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Error: 调用 MCP 远程工具 '${this.name}' 失败: ${errMsg}`,
        error: errMsg,
        interrupted: context?.signal?.aborted || undefined,
        executionTimeMs: Date.now() - startTime,
      };
    }
  }
}
