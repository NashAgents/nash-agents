import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalService } from "../approval/approval-service.js";
import type { EventBus } from "../observability/event-bus.js";
import type { SpillStore } from "../context/spill/spill-store.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type { SandboxPolicy } from "../sandbox/types.js";
import type {
  MCPServerConfig,
  MCPServerStatusInfo,
  MCPTestResult,
  MCPConfigScope,
} from "./types.js";
import { MCPConfigManager } from "./mcp-config.js";
import { MCPConnectionManager } from "./mcp-connection-manager.js";
import { MCPToolAdapter, buildMCPToolName } from "./mcp-tool-adapter.js";
import { MCPResultAdapter } from "./mcp-result-adapter.js";
import { MCPToolDiscovery } from "./mcp-tool-discovery.js";
import { SearchMCPToolsTool } from "./mcp-tool-search.js";
import {
  ListMCPResourcesTool,
  ReadMCPResourceTool,
} from "./mcp-resource-manager.js";
import { MCPPromptManager } from "./mcp-prompt-manager.js";
import { CredentialStore } from "./credential-store.js";
import { MCPOAuthHandler } from "./oauth-handler.js";
import {
  MCPListServersTool,
  MCPInspectServerTool,
  MCPProposeAddTool,
  MCPRegisterTool,
  MCPRemoveServerTool,
  MCPSetEnabledTool,
  MCPReconnectServerTool,
} from "./mcp-management-tools.js";

export interface MCPManagerOptions {
  projectRoot?: string;
  homeDir?: string;
  nashHome?: string;
  registry?: ToolRegistry;
  approvalService?: ApprovalService;
  eventBus?: EventBus;
  spillStore?: SpillStore;
  sessionId?: string;
  sandboxService?: SandboxService;
  sandboxPolicy?: SandboxPolicy;
}

/**
 * MCP 统一管理服务中枢 (MCPManager)
 *
 * 核心架构职责：
 * 1. 配置加载与多作用域治理 (Local > Project > User) 与 Workspace Trust 检验；
 * 2. 官方标准协议连接池与 stdio OS 原生沙箱隔离 (Seatbelt / Bubblewrap / Landlock)；
 * 3. 动态工具挂载与运行时热更新 (ToolRegistry / ToolDiscovery / ToolSearch)；
 * 4. 自然语言 MCP 管理工具全链路支持 (LLM Propose -> Approval -> Register -> Next Step Immediate Call)；
 * 5. 安全凭证隔离与持久化存储 (CredentialStore + OAuth 2.0 PKCE)。
 */
export class MCPManager {
  public readonly configManager: MCPConfigManager;
  public readonly connectionManager: MCPConnectionManager;
  public readonly toolDiscovery: MCPToolDiscovery;
  public readonly resultAdapter: MCPResultAdapter;
  public readonly promptManager: MCPPromptManager;
  public readonly credentialStore: CredentialStore;

  private readonly registry?: ToolRegistry;
  private readonly approvalService?: ApprovalService;
  private readonly eventBus?: EventBus;
  private readonly spillStore?: SpillStore;
  private readonly sandboxService?: SandboxService;
  private readonly sandboxPolicy?: SandboxPolicy;
  private readonly activatedToolNames = new Set<string>();
  public getActivatedToolNames(): string[] { return [...this.activatedToolNames]; }

  private readonly registeredToolNames = new Set<string>();
  private readonly toolChangeListeners = new Set<() => void>();

  constructor(options?: MCPManagerOptions) {
    this.configManager = new MCPConfigManager({
      projectRoot: options?.projectRoot,
      homeDir: options?.homeDir,
      nashHome: options?.nashHome,
    });
    this.credentialStore = new CredentialStore({
      homeDir: options?.homeDir,
      nashHome: options?.nashHome,
    });
    this.connectionManager = new MCPConnectionManager({
      eventBus: options?.eventBus,
      cwd: options?.projectRoot,
      sandboxService: options?.sandboxService,
      sandboxPolicy: options?.sandboxPolicy,
    });
    this.toolDiscovery = new MCPToolDiscovery();
    this.resultAdapter = new MCPResultAdapter({
      spillStore: options?.spillStore,
      sessionId: options?.sessionId,
    });
    this.promptManager = new MCPPromptManager(this.connectionManager);
    this.registry = options?.registry;
    this.approvalService = options?.approvalService;
    this.eventBus = options?.eventBus;
    this.spillStore = options?.spillStore;
    this.sandboxService = options?.sandboxService;
    this.sandboxPolicy = options?.sandboxPolicy;
  }

  /**
   * 注册工具变动监听器（用于 AgentLoop 热更新通知）
   */
  public onToolsChanged(listener: () => void): () => void {
    this.toolChangeListeners.add(listener);
    return () => this.toolChangeListeners.delete(listener);
  }

  private notifyToolsChanged(): void {
    for (const listener of this.toolChangeListeners) {
      try {
        listener();
      } catch {}
    }
  }

  /**
   * 初始化并启动所有已配置的 MCP Server
   */
  async initialize(): Promise<void> {
    const servers = this.configManager.loadAllServers();
    this.toolDiscovery.setServerConfigs(servers);

    // 1. 将所有服务配置注册到连接管理器，并注入从 CredentialStore 中解析的凭证
    for (const [name, config] of Object.entries(servers)) {
      this.enrichServerWithCredentials(name, config);
      this.connectionManager.registerServer(name, config);
    }

    // 2. 并发连接所有 enabled 且通过 Workspace Trust 的服务
    const connectPromises: Promise<void>[] = [];
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;

      // 项目信任检查：若项目未受信任且未批准，标记为待审批状态，拒绝静默启动
      if (config.scope === "project" && config.trustStatus === "pending") {
        console.warn(
          `\x1b[33m[Workspace Trust]\x1b[0m 项目级 MCP 服务 '${name}' 尚未被用户信任，已拦截自动启动。请运行 'nash mcp trust' 确认。`
        );
        continue;
      }

      connectPromises.push(
        this.connectionManager.connect(name).catch((err) => {
          console.warn(
            `\x1b[33m[MCP Warning]\x1b[0m 无法连接 MCP 服务 '${name}':`,
            err instanceof Error ? err.message : String(err)
          );
        })
      );
    }

    await Promise.allSettled(connectPromises);

    // 3. 将发现的所有工具同步注册到 Nash ToolRegistry 中
    this.syncToolsToRegistry();

    // 4. 挂载通用 MCP 辅助与管理工具
    this.registerHelperAndManagementTools();
  }

  /**
   * 运行时热重载：重新读取磁盘配置并同步运行态连接与可用工具
   */
  async reload(): Promise<void> {
    const currentStatuses = this.listStatuses();
    const existingNames = new Set(currentStatuses.map((s) => s.name));
    const newServers = this.configManager.loadAllServers();
    const newNames = new Set(Object.keys(newServers));

    this.toolDiscovery.setServerConfigs(newServers);

    // 1. 移除已从磁盘删除的 Server
    for (const name of existingNames) {
      if (!newNames.has(name)) {
        await this.removeServer(name);
      }
    }

    // 2. 更新或新建 Server
    for (const [name, config] of Object.entries(newServers)) {
      if (existingNames.has(name)) await this.connectionManager.disconnect(name);
      this.enrichServerWithCredentials(name, config);
      this.connectionManager.registerServer(name, config);

      if (config.enabled !== false) {
        if (config.scope === "project" && config.trustStatus === "pending") {
          continue;
        }
        await this.connectionManager.connect(name).catch(() => {});
      } else {
        await this.connectionManager.disconnect(name).catch(() => {});
      }
    }

    this.syncToolsToRegistry();
    this.notifyToolsChanged();
  }

  /**
   * 从 CredentialStore 自动注入凭据
   */
  private enrichServerWithCredentials(name: string, config: MCPServerConfig): void {
    const cred = this.credentialStore.getCredential(name);
    if (!cred) return;

    if (cred.type === "bearer" && cred.token) {
      if (!config.headers) config.headers = {};
      config.headers["Authorization"] = `Bearer ${cred.token}`;
    } else if (cred.type === "oauth" && cred.oauth?.accessToken) {
      if (!config.headers) config.headers = {};
      config.headers["Authorization"] = `Bearer ${cred.oauth.accessToken}`;
    }
  }

  /**
   * 将当前连接管理器中所有可用工具同步挂载至 Nash ToolRegistry
   */
  public syncToolsToRegistry(targetRegistry?: ToolRegistry): void {
    if (targetRegistry) {
      (this as any).registry = targetRegistry;
    }
    const reg = targetRegistry ?? this.registry;
    if (!reg) return;

    const allTools = this.connectionManager.getAllTools();
    this.toolDiscovery.updateIndex(allTools);
    const liveNames = new Set(allTools.map(tool => buildMCPToolName(tool.serverName, tool.name)));
    for (const name of this.registeredToolNames) {
      if (name.startsWith("mcp__") && !liveNames.has(name)) {
        reg.unregister(name); this.registeredToolNames.delete(name); this.activatedToolNames.delete(name);
      }
    }

    for (const rawTool of allTools) {
      const serverConfig = this.configManager.getServer(rawTool.serverName);
      if (!serverConfig) continue;

      const adapter = new MCPToolAdapter({
        serverName: rawTool.serverName,
        serverConfig,
        rawTool,
        callToolHandler: async (tName, args, signal) => {
          return await this.connectionManager.callTool(rawTool.serverName, tName, args, signal);
        },
        resultAdapter: this.resultAdapter,
        approvalService: this.approvalService,
        getApprovalMode: () => this.sandboxService?.getPolicy().approval.mode,
        // 实时读取：任务级授权 / 全局策略收紧必须在后续 MCP 调用上立即生效。
        getPolicy: () => this.sandboxService?.getPolicy(),
      });

      if (this.registeredToolNames.has(adapter.name)) reg.unregister(adapter.name);
      if (!reg.has(adapter.name)) {
        reg.register(adapter);
        this.registeredToolNames.add(adapter.name);
      }
    }

    // 确保辅助工具与 7 大自然语言管理工具同步挂载到 registry
    this.registerHelperAndManagementTools();

    this.notifyToolsChanged();
  }

  /**
   * 挂载 MCP 辅助工具及 LLM 自然语言管理工具集
   */
  private registerHelperAndManagementTools(): void {
    if (!this.registry) return;

    // 1. 注册 search_mcp_tools 工具
    if (!this.registry.has("search_mcp_tools")) {
      const searchTool = new SearchMCPToolsTool(this.toolDiscovery, {
        onToolsFound: (toolNames) => {
          this.syncToolsToRegistry();
          for (const name of toolNames) this.activatedToolNames.add(name);
        },
      });
      this.registry.register(searchTool);
      this.registeredToolNames.add(searchTool.name);
    }

    // 2. 注册 Resources 工具
    if (!this.registry.has("list_mcp_resources")) {
      const listResTool = new ListMCPResourcesTool(this.connectionManager);
      this.registry.register(listResTool);
      this.registeredToolNames.add(listResTool.name);
    }

    if (!this.registry.has("read_mcp_resource")) {
      const readResTool = new ReadMCPResourceTool(
        this.connectionManager,
        this.spillStore
      );
      this.registry.register(readResTool);
      this.registeredToolNames.add(readResTool.name);
    }

    // 3. 注册全套自然语言管理工具集 (供 AgentLoop 识别并管理 MCP)
    const mgmtTools = [
      new MCPListServersTool(this),
      new MCPInspectServerTool(this),
      new MCPProposeAddTool(this),
      new MCPRegisterTool(this, this.approvalService),
      new MCPRemoveServerTool(this, this.approvalService),
      new MCPSetEnabledTool(this),
      new MCPReconnectServerTool(this),
    ];

    for (const t of mgmtTools) {
      if (!this.registry.has(t.name)) {
        this.registry.register(t);
        this.registeredToolNames.add(t.name);
      }
    }
  }

  /**
   * 添加并连接新的 MCP 服务
   */
  async addServer(
    name: string,
    config: MCPServerConfig,
    scope: MCPConfigScope = "user"
  ): Promise<MCPServerStatusInfo> {
    const normScope = this.configManager.normalizeScope(scope);
    this.configManager.saveServer(name, config, normScope);
    const fullConfig = this.configManager.getServer(name)!;

    this.enrichServerWithCredentials(name, fullConfig);
    this.connectionManager.registerServer(name, fullConfig);

    if (fullConfig.enabled !== false) {
      await this.connectionManager.connect(name);
      this.syncToolsToRegistry();
    }

    this.notifyToolsChanged();
    return this.connectionManager.getStatus(name)!;
  }

  /**
   * 移除 MCP 服务并清理对应注册的工具
   */
  async removeServer(name: string, scope?: MCPConfigScope): Promise<boolean> {
    const removed = this.configManager.removeServer(name, scope);
    if (!removed && !this.connectionManager.getStatus(name)) return false;

    // 清理该服务在 ToolRegistry 中注册的所有工具
    if (this.registry) {
      const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
      for (const tName of Array.from(this.registeredToolNames)) {
        if (tName.startsWith(prefix)) {
          this.registry.unregister(tName);
          this.registeredToolNames.delete(tName);
          this.activatedToolNames.delete(tName);
        }
      }
    }

    this.credentialStore.removeCredential(name);
    await this.connectionManager.unregisterServer(name);
    this.toolDiscovery.updateIndex(this.connectionManager.getAllTools());
    this.notifyToolsChanged();
    return true;
  }

  /**
   * 启用服务
   */
  async enableServer(name: string): Promise<boolean> {
    const ok = this.configManager.setServerEnabled(name, true);
    if (!ok) return false;
    const config = this.configManager.getServer(name)!;
    this.enrichServerWithCredentials(name, config);
    this.connectionManager.registerServer(name, config);
    await this.connectionManager.connect(name);
    this.syncToolsToRegistry();
    this.notifyToolsChanged();
    return true;
  }

  /**
   * 禁用服务
   */
  async disableServer(name: string): Promise<boolean> {
    const ok = this.configManager.setServerEnabled(name, false);
    if (!ok) return false;

    if (this.registry) {
      const prefix = `mcp__${name.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
      for (const tName of Array.from(this.registeredToolNames)) {
        if (tName.startsWith(prefix)) {
          this.registry.unregister(tName);
          this.registeredToolNames.delete(tName);
          this.activatedToolNames.delete(tName);
        }
      }
    }

    await this.connectionManager.disconnect(name);
    const config = this.configManager.getServer(name)!;
    this.connectionManager.registerServer(name, config);
    this.toolDiscovery.updateIndex(this.connectionManager.getAllTools());
    this.notifyToolsChanged();
    return true;
  }

  /**
   * 测试指定服务连通性
   */
  async testServer(name: string): Promise<MCPTestResult> {
    const config = this.configManager.getServer(name);
    if (config) {
      this.enrichServerWithCredentials(name, config);
      this.connectionManager.registerServer(name, config);
    }
    return await this.connectionManager.testConnection(name);
  }

  /**
   * 重新连接指定服务
   */
  async reconnectServer(name: string): Promise<void> {
    await this.connectionManager.disconnect(name);
    const config = this.configManager.getServer(name);
    if (config) {
      this.enrichServerWithCredentials(name, config);
      this.connectionManager.registerServer(name, config);
    }
    await this.connectionManager.connect(name);
    this.syncToolsToRegistry();
    this.notifyToolsChanged();
  }

  /**
   * 登录服务 (OAuth 2.0 PKCE 流程)
   */
  async loginServer(
    name: string,
    options?: {
      onAuthUrl?: (url: string) => void;
      manualCodeInput?: () => Promise<string>;
    }
  ): Promise<boolean> {
    const config = this.configManager.getServer(name);
    if (!config || !config.url) {
      throw new Error(`服务 '${name}' 未配置有效的远程 URL`);
    }

    let oauthConfig = config.oauth;
    if (!oauthConfig?.authorizationUrl || !oauthConfig?.tokenUrl) {
      const meta = await MCPOAuthHandler.discoverMetadata(config.url);
      if (meta) {
        oauthConfig = {
          ...oauthConfig,
          authorizationUrl: meta.authorizationEndpoint,
          tokenUrl: meta.tokenEndpoint,
        };
      }
    }

    if (!oauthConfig?.authorizationUrl || !oauthConfig?.tokenUrl) {
      throw new Error(`无法自动发现服务 '${name}' 的 OAuth 元数据，请手动配置 oauth 端点`);
    }

    const { codeVerifier, codeChallenge } = MCPOAuthHandler.generatePKCE();
    const state = Math.random().toString(36).slice(2);

    // 启动本地监听
    const listener = await MCPOAuthHandler.startCallbackListener(state);

    try {
      const authUrl = new URL(oauthConfig.authorizationUrl);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", oauthConfig.clientId ?? "nash-agent");
      authUrl.searchParams.set("redirect_uri", listener.redirectUri);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      if (options?.onAuthUrl) {
        options.onAuthUrl(authUrl.toString());
      } else {
        console.log(`\n\x1b[36m请在浏览器中打开此 URL 进行认证:\x1b[0m\n${authUrl.toString()}\n`);
      }

      // 等待 callback
      const code = await listener.waitForCode();

      const tokenResult = await MCPOAuthHandler.exchangeCodeForToken({
        tokenUrl: oauthConfig.tokenUrl,
        code,
        codeVerifier,
        clientId: oauthConfig.clientId ?? "nash-agent",
        clientSecret: oauthConfig.clientSecret,
        redirectUri: listener.redirectUri,
      });

      this.credentialStore.setOAuthCredential(name, {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken,
        expiresAt: tokenResult.expiresIn ? Date.now() + tokenResult.expiresIn * 1000 : undefined,
      });

      // 重新连接以应用 Token
      await this.reconnectServer(name);
      return true;
    } finally {
      listener.close();
    }
  }

  /**
   * 登出服务，清除凭证
   */
  async logoutServer(name: string): Promise<boolean> {
    this.credentialStore.removeCredential(name);
    await this.reconnectServer(name);
    return true;
  }

  /**
   * 获取所有服务状态
   */
  listStatuses(): MCPServerStatusInfo[] {
    return this.connectionManager.listStatuses();
  }

  /**
   * 获取指定服务状态
   */
  getStatus(name: string): MCPServerStatusInfo | undefined {
    return this.connectionManager.getStatus(name);
  }

  /**
   * 优雅关闭所有连接
   */
  async close(): Promise<void> {
    await this.connectionManager.closeAll();
  }
}
