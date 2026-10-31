import { SandboxService } from "../sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";
import type { SandboxPolicy } from "../sandbox/types.js";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type {
  MCPServerConfig,
  MCPConnectionStatus,
  MCPServerStatusInfo,
  MCPTestResult,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
} from "./types.js";
import { createMCPTransport } from "./transports/index.js";
import type { EventBus } from "../observability/event-bus.js";

export interface MCPConnectionEntry {
  config: MCPServerConfig;
  status: MCPConnectionStatus;
  client?: Client;
  transport?: Transport;
  protocolVersion?: string;
  serverVersion?: string;
  capabilities?: Record<string, unknown>;
  tools: MCPToolDefinition[];
  resources: MCPResourceDefinition[];
  prompts: MCPPromptDefinition[];
  lastConnectedAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
}

export interface MCPConnectionManagerOptions {
  sandboxService?: SandboxService;
  sandboxPolicy?: SandboxPolicy;
  eventBus?: EventBus;
  cwd?: string;
  clientInfo?: {
    name: string;
    version: string;
  };
}

/**
 * 统一连接管理中枢：负责所有 MCP Server 的 Client 实例化、握手协商、健康监控、重连与生命周期控制
 */
export class MCPConnectionManager {
  private readonly connections = new Map<string, MCPConnectionEntry>();
  private readonly eventBus?: EventBus;
  private readonly cwd: string;
  private readonly sandboxService: SandboxService;
  private readonly clientInfo: { name: string; version: string };

  constructor(options?: MCPConnectionManagerOptions) {
    this.eventBus = options?.eventBus;
    this.sandboxService = options?.sandboxService ?? new SandboxService({ policy: options?.sandboxPolicy ?? createDefaultSandboxPolicy(), cwd: options?.cwd });
    this.cwd = options?.cwd ?? process.cwd();
    this.clientInfo = options?.clientInfo ?? {
      name: "nash-agent",
      version: "1.0.0",
    };
  }

  /**
   * 注册或更新服务连接元数据（不立即连接）
   */
  registerServer(name: string, config: MCPServerConfig): void {
    const existing = this.connections.get(name);
    if (existing) {
      existing.config = config;
      if (config.enabled === false) {
        existing.status = "disabled";
      }
    } else {
      this.connections.set(name, {
        config,
        status: config.enabled === false ? "disabled" : "disconnected",
        tools: [],
        resources: [],
        prompts: [],
        reconnectAttempts: 0,
      });
    }
  }

  /**
   * 移除服务元数据并释放连接
   */
  async unregisterServer(name: string): Promise<void> {
    await this.disconnect(name);
    this.connections.delete(name);
  }

  /**
   * 触发事件通知
   */
  private emitServerEvent(
    type: string,
    name: string,
    status: MCPConnectionStatus,
    extra?: Record<string, unknown>
  ): void {
    if (!this.eventBus) return;
    const entry = this.connections.get(name);
    this.eventBus.emit({
      id: crypto.randomUUID(),
      type: type as any,
      timestamp: new Date().toISOString(),
      projectId: "global",
      sessionId: "mcp-system",
      data: {
        serverName: name,
        transport: entry?.config.transport ?? "streamable-http",
        status,
        ...extra,
      },
    });
  }

  /**
   * 连接指定的 MCP 服务
   */
  async connect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) {
      throw new Error(`未找到已注册的 MCP 服务: '${name}'`);
    }

    if (entry.config.enabled === false) {
      entry.status = "disabled";
      return;
    }

    // 若已连接则无需重复连接
    if (entry.status === "connected" && entry.client) {
      return;
    }

    // 清理之前的定时器与连接
    this.clearReconnectTimer(entry);
    await this.closeActiveClient(entry);

    entry.status = entry.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    this.emitServerEvent("mcp.server.connecting", name, entry.status);

    const timeoutMs = entry.config.timeoutMs ?? 30000;

    try {
      // 1. 创建官方 Transport 实例
      const transport = createMCPTransport(entry.config, { cwd: this.cwd, sandboxService: this.sandboxService, sandboxPolicy: this.sandboxService.getPolicy() });
      entry.transport = transport;

      // 2. 实例化官方 Client，使用 SDK 规范协商协议与能力
      const client = new Client(this.clientInfo, {
        capabilities: {
          roots: {
            listChanged: true,
          },
        },
        versionNegotiation: {
          mode: "auto",
        },
      });
      entry.client = client;

      // 3. 执行 connect 握手与协议初始化（附带硬超时控制）
      await this.withTimeout(
        client.connect(transport),
        timeoutMs,
        `连接握手超时 (${timeoutMs}ms)`
      );

      // 4. 读取协商得到的协议版本与服务端能力
      try {
        entry.protocolVersion = client.getNegotiatedProtocolVersion?.();
        entry.serverVersion = client.getServerVersion?.()?.version;
        entry.capabilities = client.getServerCapabilities?.() as Record<string, unknown>;
      } catch {
        // 部分测试或老版本 Server 未返回时容错
      }

      entry.status = "connected";
      entry.lastConnectedAt = Date.now();
      entry.lastError = undefined;
      entry.reconnectAttempts = 0;

      // 5. 发现并缓存服务端的 Tools、Resources、Prompts
      await this.refreshServerCapabilities(name);

      this.emitServerEvent("mcp.server.connected", name, "connected", {
        toolCount: entry.tools.length,
        protocolVersion: entry.protocolVersion,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      entry.status = "failed";
      entry.lastError = errMsg;
      await this.closeActiveClient(entry);

      this.emitServerEvent("mcp.server.failed", name, "failed", {
        error: errMsg,
      });

      // 判断是否触发自动重连
      this.scheduleReconnectIfApplicable(name);

      throw err;
    }
  }

  /**
   * 刷新指定服务提供的 Tools、Resources、Prompts 列表
   */
  async refreshServerCapabilities(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry || !entry.client || entry.status !== "connected") return;

    try {
      // 1. 发现工具
      const toolsResult = await entry.client.listTools();
      const rawTools = toolsResult?.tools ?? [];
      entry.tools = rawTools.map((t: any) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        serverName: name,
      }));

      this.emitServerEvent("mcp.tools.updated", name, "connected", {
        toolCount: entry.tools.length,
        tools: entry.tools.map((t) => t.name),
      });
    } catch (toolErr) {
      console.warn(
        `[MCPConnectionManager] 获取服务 '${name}' 工具列表失败:`,
        toolErr instanceof Error ? toolErr.message : String(toolErr)
      );
    }

    try {
      // 2. 发现资源 (若服务端声明支持 resources)
      if (entry.capabilities?.resources || !entry.capabilities) {
        const resResult = await entry.client.listResources();
        const rawRes = resResult?.resources ?? [];
        entry.resources = rawRes.map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
          serverName: name,
        }));
      }
    } catch {
      // 服务端可能未声明或不支持 resources
    }

    try {
      // 3. 发现 Prompts (若服务端声明支持 prompts)
      if (entry.capabilities?.prompts || !entry.capabilities) {
        const promptsResult = await entry.client.listPrompts();
        const rawPrompts = promptsResult?.prompts ?? [];
        entry.prompts = rawPrompts.map((p: any) => ({
          name: p.name,
          description: p.description,
          arguments: p.arguments,
          serverName: name,
        }));
      }
    } catch {
      // 服务端可能未声明或不支持 prompts
    }
  }

  /**
   * 调用指定服务的具体工具（防副作用自动盲目重试）
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const entry = this.connections.get(serverName);
    if (!entry || !entry.client || entry.status !== "connected") {
      throw new Error(
        `MCP 服务 '${serverName}' 尚未连接 (当前状态: ${entry?.status ?? "unknown"})`
      );
    }

    signal?.throwIfAborted();
    const timeoutMs = entry.config.timeoutMs ?? 60000;

    try {
      return await this.withTimeout(
        entry.client.callTool({
          name: toolName,
          arguments: args,
        }, { signal, timeout: timeoutMs }),
        timeoutMs,
        `调用工具 '${toolName}' 超时 (${timeoutMs}ms)`
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 铁律：检测是否为网络断开/未完成状态。若结果未知，抛出明确错误，严禁无感知重发
      if (
        errMsg.includes("fetch failed") ||
        errMsg.includes("ECONNREFUSED") ||
        errMsg.includes("ETIMEDOUT") ||
        errMsg.includes("超时")
      ) {
        throw new Error(
          `调用 MCP 工具 '${toolName}' 时网络通信异常 (${errMsg})。执行结果未知 (Outcome Unknown)，为保障安全性已拒绝自动重发。`
        );
      }
      throw err;
    }
  }

  /**
   * 读取指定资源
   */
  async readResource(serverName: string, uri: string): Promise<unknown> {
    const entry = this.connections.get(serverName);
    if (!entry || !entry.client || entry.status !== "connected") {
      throw new Error(`MCP 服务 '${serverName}' 尚未连接`);
    }
    return await entry.client.readResource({ uri });
  }

  /**
   * 获取指定 Prompt 模板
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<unknown> {
    const entry = this.connections.get(serverName);
    if (!entry || !entry.client || entry.status !== "connected") {
      throw new Error(`MCP 服务 '${serverName}' 尚未连接`);
    }
    return await entry.client.getPrompt({ name: promptName, arguments: args });
  }

  /**
   * 测试指定 MCP 服务的协议握手、能力获取与工具列表
   */
  async testConnection(name: string): Promise<MCPTestResult> {
    const entry = this.connections.get(name);
    if (!entry) {
      return {
        serverName: name,
        transport: "streamable-http",
        success: false,
        latencyMs: 0,
        toolCount: 0,
        error: `服务 '${name}' 未配置`,
      };
    }

    const startTime = Date.now();
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      // 临时建立独立测试 Client 与 Transport，避免干扰主客户端运行态
      transport = createMCPTransport(entry.config, { cwd: this.cwd, sandboxService: this.sandboxService, sandboxPolicy: this.sandboxService.getPolicy() });
      client = new Client(
        { name: "nash-agent-tester", version: "1.0.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: "auto" },
        }
      );

      const timeoutMs = entry.config.timeoutMs ?? 15000;
      await this.withTimeout(
        client.connect(transport),
        timeoutMs,
        `连接超时 (${timeoutMs}ms)`
      );

      const latencyMs = Date.now() - startTime;
      const protocolVersion = client.getNegotiatedProtocolVersion?.();
      const serverVersion = client.getServerVersion?.();
      const capabilities = client.getServerCapabilities?.() as Record<string, unknown>;

      let tools: string[] = [];
      try {
        const toolsRes = await this.withTimeout(client.listTools(), timeoutMs, `工具列表超时 (${timeoutMs}ms)`);
        tools = (toolsRes?.tools ?? []).map((t: any) => t.name);
      } catch (error) { throw error; }

      return {
        serverName: name,
        transport: entry.config.transport,
        success: true,
        latencyMs,
        protocolVersion,
        serverInfo: serverVersion,
        capabilities,
        toolCount: tools.length,
        tools,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        serverName: name,
        transport: entry.config.transport,
        success: false,
        latencyMs: Date.now() - startTime,
        toolCount: 0,
        error: errMsg,
      };
    } finally {
      try { await client?.close(); } finally { await transport?.close(); }
    }
  }

  /**
   * 断开指定服务的连接
   */
  async disconnect(name: string): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) return;

    this.clearReconnectTimer(entry);
    await this.closeActiveClient(entry);

    entry.status = entry.config.enabled === false ? "disabled" : "disconnected";
    this.emitServerEvent("mcp.server.disconnected", name, entry.status);
  }

  /**
   * 断开并关闭所有服务
   */
  async closeAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /**
   * 获取指定服务状态
   */
  getStatus(name: string): MCPServerStatusInfo | undefined {
    const entry = this.connections.get(name);
    if (!entry) return undefined;

    return {
      name,
      transport: entry.config.transport,
      status: entry.status,
      scope: entry.config.scope ?? "global",
      enabled: entry.config.enabled !== false,
      endpoint: entry.config.url || entry.config.command,
      protocolVersion: entry.protocolVersion,
      serverVersion: entry.serverVersion,
      toolCount: entry.tools.length,
      resourceCount: entry.resources.length,
      promptCount: entry.prompts.length,
      lastConnectedAt: entry.lastConnectedAt,
      lastError: entry.lastError,
    };
  }

  /**
   * 获取所有服务状态列表
   */
  listStatuses(): MCPServerStatusInfo[] {
    return Array.from(this.connections.keys())
      .map((name) => this.getStatus(name))
      .filter((s): s is MCPServerStatusInfo => s !== undefined);
  }

  /**
   * 获取指定服务的所有工具
   */
  getTools(serverName: string): MCPToolDefinition[] {
    return this.connections.get(serverName)?.tools ?? [];
  }

  /**
   * 获取所有已连接服务发现的工具集合
   */
  getAllTools(): MCPToolDefinition[] {
    const result: MCPToolDefinition[] = [];
    for (const entry of this.connections.values()) {
      if (entry.status === "connected") {
        result.push(...entry.tools);
      }
    }
    return result;
  }

  /**
   * 获取已连接的所有 Resources
   */
  getAllResources(): MCPResourceDefinition[] {
    const result: MCPResourceDefinition[] = [];
    for (const entry of this.connections.values()) {
      if (entry.status === "connected") {
        result.push(...entry.resources);
      }
    }
    return result;
  }

  /**
   * 获取已连接的所有 Prompts
   */
  getAllPrompts(): MCPPromptDefinition[] {
    const result: MCPPromptDefinition[] = [];
    for (const entry of this.connections.values()) {
      if (entry.status === "connected") {
        result.push(...entry.prompts);
      }
    }
    return result;
  }

  /**
   * 安全关闭活跃 Client 与 Transport
   */
  private async closeActiveClient(entry: MCPConnectionEntry): Promise<void> {
    if (entry.client) {
      try {
        await entry.client.close();
      } catch {}
      entry.client = undefined;
    }
    if (entry.transport) {
      try {
        await entry.transport.close();
      } catch {}
      entry.transport = undefined;
    }
  }

  /**
   * 清除重连定时器
   */
  private clearReconnectTimer(entry: MCPConnectionEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
  }

  /**
   * 指数退避调度自动重连
   */
  private scheduleReconnectIfApplicable(name: string): void {
    const entry = this.connections.get(name);
    if (!entry || entry.config.enabled === false) return;

    const policy = entry.config.reconnect ?? {};
    const maxRetries = policy.maxRetries ?? 5;
    if (entry.reconnectAttempts >= maxRetries) {
      return;
    }

    entry.reconnectAttempts++;
    const initialDelay = policy.initialDelayMs ?? 1000;
    const maxDelay = policy.maxDelayMs ?? 30000;
    const factor = policy.backoffFactor ?? 2;

    const rawDelay = initialDelay * Math.pow(factor, entry.reconnectAttempts - 1);
    const jitter = Math.random() * 500;
    const delay = Math.min(rawDelay + jitter, maxDelay);

    this.clearReconnectTimer(entry);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      this.connect(name).catch(() => {});
    }, delay);
  }

  /**
   * 超时包装辅助函数
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    errMsg: string
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(errMsg)), ms);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
