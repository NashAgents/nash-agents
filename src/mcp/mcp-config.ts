import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type {
  MCPServerConfig,
  MCPServerSettings,
  MCPConfigScope,
  MCPTrustStatus,
} from "./types.js";
import {
  validateMCPUrl,
  MCPSecurityError,
  computeServerFingerprint,
} from "./mcp-security.js";
import { ensureNashSettings } from "../config/nash-config.js";
import { resolveNashHome } from "../config/data-home.js";

export const DEFAULT_SETTINGS_FILE = "settings.json";
export const DOT_MCP_JSON_FILE = ".mcp.json";

export interface MCPConfigManagerOptions {
  projectRoot?: string;
  homeDir?: string;
  nashHome?: string;
  globalConfigPath?: string;
  projectConfigPath?: string;
  localConfigPath?: string;
}

export interface ScopedServerInfo {
  config: MCPServerConfig;
  activeScope: MCPConfigScope;
  overriddenScopes: MCPConfigScope[];
}

export interface WorkspaceTrustRecord {
  projectRoot: string;
  fingerprint: string;
  trustedAt: number;
}

/**
 * MCP 配置管理中心
 *
 * 支持三级作用域：
 * 1. local: 当前项目私有，不进 Git，保存在 NASH_HOME/projects/<id>/mcp.json
 * 2. project: 当前项目共享，保存在项目根目录 .mcp.json (兼容 settings.json)
 * 3. user (global): 全局所有项目通用，保存在 NASH_HOME/settings.json
 *
 * NASH_HOME 默认是 ~/.nash-agents（与旧 ~/.nash 目录区分）。
 *
 * 优先级: local > project > user (global)
 */
export class MCPConfigManager {
  public readonly projectRoot: string;
  public readonly homeDir: string;
  public readonly nashHome: string;
  public readonly userConfigPath: string;
  public readonly projectMcpJsonPath: string;
  public readonly projectSettingsPath: string;
  public readonly localConfigPath: string;
  public readonly trustedProjectsPath: string;

  constructor(options?: MCPConfigManagerOptions) {
    this.projectRoot = path.resolve(options?.projectRoot ?? process.cwd());
    this.homeDir = options?.homeDir ?? os.homedir();
    this.nashHome = options?.nashHome ?? (options?.homeDir ? path.join(this.homeDir, ".nash") : resolveNashHome());
    this.userConfigPath =
      options?.globalConfigPath ??
      path.join(this.nashHome, "settings.json");
    this.projectMcpJsonPath = path.join(this.projectRoot, DOT_MCP_JSON_FILE);
    this.projectSettingsPath =
      options?.projectConfigPath ??
      path.join(this.projectRoot, DEFAULT_SETTINGS_FILE);

    // 基于项目物理路径哈希生成隔离的 local 目录
    const projectHash = crypto
      .createHash("sha256")
      .update(this.projectRoot)
      .digest("hex")
      .slice(0, 16);
    this.localConfigPath =
      options?.localConfigPath ??
      path.join(this.nashHome, "projects", projectHash, "mcp.json");
    this.trustedProjectsPath = path.join(
      this.nashHome,
      "trusted-projects.json"
    );
  }

  /**
   * 读取指定路径的 JSON 配置文件，不存在则返回空对象
   */
  private readConfigFile(filePath: string): Record<string, unknown> {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(content);
      }
    } catch (err) {
      console.warn(
        `[MCPConfig] 读取配置文件 '${filePath}' 失败:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    return {};
  }

  /**
   * 原子写入 JSON 配置文件
   */
  private writeConfigFile(
    filePath: string,
    data: Record<string, unknown>
  ): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }
    const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tempFile, filePath);
  }

  /**
   * 获取作用域对应的目标文件路径
   */
  private ensureUserConfig(): void {
    if (this.nashHome === path.join(this.homeDir, ".nash")) { ensureNashSettings({ homeDir: this.homeDir }); return; }
    fs.mkdirSync(path.dirname(this.userConfigPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.userConfigPath)) fs.writeFileSync(this.userConfigPath, "{}\n", { flag: "wx", mode: 0o600 });
  }

  private getTargetFilePath(scope: MCPConfigScope): string {
    switch (scope) {
      case "local":
        return this.localConfigPath;
      case "project":
        // 优先兼容已有 settings.json，若显式存在 .mcp.json 则写入 .mcp.json
        if (fs.existsSync(this.projectMcpJsonPath)) {
          return this.projectMcpJsonPath;
        }
        return this.projectSettingsPath;
      case "user":
      case "global":
        this.ensureUserConfig();
        return this.userConfigPath;
    }
  }

  /**
   * 规范化 Scope 名称 (保留原有输入语义，映射目标存储层)
   */
  public normalizeScope(scope?: MCPConfigScope): MCPConfigScope {
    if (!scope) return "global";
    return scope;
  }

  /**
   * 验证单条 MCP Server 配置的完整性与合法性
   */
  public validateConfig(name: string, config: MCPServerConfig): void {
    if (!name || typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new MCPSecurityError(
        `非法的 MCP 服务名称 '${name}'。服务名只能包含字母、数字、下划线与短横线。`
      );
    }

    if (!["stdio", "streamable-http", "sse"].includes(config.transport)) {
      throw new MCPSecurityError(
        `服务 '${name}' 传输协议 '${config.transport}' 不受支持。可用值: stdio, streamable-http, sse`
      );
    }

    if (config.transport === "streamable-http" || config.transport === "sse") {
      if (!config.url) {
        throw new MCPSecurityError(
          `远程服务 '${name}' 必须提供有效的 'url' 字段。`
        );
      }
      validateMCPUrl(config.url, Boolean(config.allowInsecureHttp));
    }

    if (config.transport === "stdio") {
      if (!config.command || typeof config.command !== "string") {
        throw new MCPSecurityError(
          `stdio 服务 '${name}' 必须提供有效的 'command' 命令行字段。`
        );
      }
    }
  }

  /**
   * 加载指定作用域下的所有 MCP Server 配置
   */
  public loadScopedServers(scope: MCPConfigScope): Record<string, MCPServerConfig> {
    let targetFiles: string[] = [];

    if (scope === "local") {
      targetFiles = [this.localConfigPath];
    } else if (scope === "project") {
      targetFiles = [this.projectMcpJsonPath, this.projectSettingsPath];
    } else {
      this.ensureUserConfig();
      targetFiles = [this.userConfigPath];
    }

    const result: Record<string, MCPServerConfig> = {};
    for (const file of targetFiles) {
      if (!fs.existsSync(file)) continue;
      const data = this.readConfigFile(file);
      const mcpServers =
        (data.mcpServers as Record<string, MCPServerConfig>) ?? {};
      for (const [name, cfg] of Object.entries(mcpServers)) {
        if (!result[name]) {
          result[name] = {
            ...cfg,
            name,
            scope: (cfg as any).scope ?? scope,
            enabled: cfg.enabled !== false,
            fingerprint: computeServerFingerprint(cfg as any),
          };
        }
      }
    }

    return result;
  }

  /**
   * 获取合并后的所有已配置 MCP Server
   * 配置优先级：Local > Project > User (Global)
   */
  public loadAllServers(): Record<string, MCPServerConfig> {
    const scopedMap = this.loadAllServersWithMetadata();
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, info] of Object.entries(scopedMap)) {
      result[name] = info.config;
    }
    return result;
  }

  /**
   * 获取合并后的所有 MCP Server 并附带 Scope 覆盖元数据
   */
  public loadAllServersWithMetadata(): Record<string, ScopedServerInfo> {
    const userServers = this.loadScopedServers("global");
    const projectServers = this.loadScopedServers("project");
    const localServers = this.loadScopedServers("local");

    const allNames = new Set([
      ...Object.keys(userServers),
      ...Object.keys(projectServers),
      ...Object.keys(localServers),
    ]);

    const result: Record<string, ScopedServerInfo> = {};

    for (const name of allNames) {
      const scopes: MCPConfigScope[] = [];
      if (localServers[name]) scopes.push("local");
      if (projectServers[name]) scopes.push("project");
      if (userServers[name]) scopes.push("global");

      const activeScope = scopes[0]!; // local > project > user (global)
      const overriddenScopes = scopes.slice(1);

      let chosenConfig: MCPServerConfig;
      if (activeScope === "local") {
        chosenConfig = localServers[name]!;
      } else if (activeScope === "project") {
        chosenConfig = projectServers[name]!;
      } else {
        chosenConfig = userServers[name]!;
      }

      // 如果选中的是项目级配置，针对具有本地执行风险的 stdio 检查 Workspace Trust 状态
      if (activeScope === "project" && chosenConfig.transport === "stdio") {
        const isTrusted = this.isProjectTrusted();
        chosenConfig.trustStatus = isTrusted ? "approved" : "pending";
      } else {
        chosenConfig.trustStatus = "approved";
      }

      result[name] = {
        config: chosenConfig,
        activeScope,
        overriddenScopes,
      };
    }

    return result;
  }

  /**
   * 获取单个 Server 配置
   */
  public getServer(name: string): MCPServerConfig | undefined {
    const all = this.loadAllServers();
    return all[name];
  }

  /**
   * 添加或更新 MCP Server 配置至指定作用域
   */
  public saveServer(
    name: string,
    config: MCPServerConfig,
    scope: MCPConfigScope = "user"
  ): void {
    this.validateConfig(name, config);
    const normScope = this.normalizeScope(scope);
    const targetFile = this.getTargetFilePath(normScope);

    const data = this.readConfigFile(targetFile);
    const mcpServers =
      (data.mcpServers as Record<string, Record<string, unknown>>) ?? {};

    // 构造存储用的干净配置对象
    const { name: _n, scope: _s, trustStatus: _t, ...cleanConfig } = config;
    cleanConfig.enabled = config.enabled !== false;
    cleanConfig.fingerprint = computeServerFingerprint(cleanConfig as any);

    mcpServers[name] = cleanConfig as Record<string, unknown>;
    data.mcpServers = mcpServers;

    this.writeConfigFile(targetFile, data);
  }

  /**
   * 移除指定 MCP Server 配置（可精确移除某个作用域）
   */
  public removeServer(name: string, scope?: MCPConfigScope): boolean {
    const removeFromTarget = (filePath: string) => {
      if (!fs.existsSync(filePath)) return false;
      const data = this.readConfigFile(filePath);
      const mcpServers =
        (data.mcpServers as Record<string, Record<string, unknown>>) ?? {};
      if (mcpServers[name]) {
        delete mcpServers[name];
        data.mcpServers = mcpServers;
        this.writeConfigFile(filePath, data);
        return true;
      }
      return false;
    };

    if (scope) {
      const normScope = this.normalizeScope(scope);
      if (normScope === "local") return removeFromTarget(this.localConfigPath);
      if (normScope === "project") {
        const a = removeFromTarget(this.projectMcpJsonPath);
        const b = removeFromTarget(this.projectSettingsPath);
        return a || b;
      }
      return removeFromTarget(this.userConfigPath);
    }

    // 未指定 scope 时优先按优先级移除：local -> project -> user
    const l = removeFromTarget(this.localConfigPath);
    const p =
      removeFromTarget(this.projectMcpJsonPath) ||
      removeFromTarget(this.projectSettingsPath);
    const u = removeFromTarget(this.userConfigPath);
    return l || p || u;
  }

  /**
   * 切换 Server 的启用/禁用状态
   */
  public setServerEnabled(name: string, enabled: boolean): boolean {
    const meta = this.loadAllServersWithMetadata()[name];
    if (!meta) return false;
    meta.config.enabled = enabled;
    this.saveServer(name, meta.config, meta.activeScope);
    return true;
  }

  // ==========================================
  // Workspace Trust 机制
  // ==========================================

  /**
   * 计算当前项目全部 MCP 配置的指纹总和
   */
  public getProjectConfigFingerprint(): string {
    const projectServers = this.loadScopedServers("project");
    const keys = Object.keys(projectServers).sort();
    if (keys.length === 0) return "empty";
    const combined = keys.map((k) => `${k}:${projectServers[k]!.fingerprint}`).join(";");
    return crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
  }

  /**
   * 检查当前项目是否已受信任
   */
  public isProjectTrusted(): boolean {
    const fingerprint = this.getProjectConfigFingerprint();
    if (fingerprint === "empty") return true;

    try {
      if (!fs.existsSync(this.trustedProjectsPath)) return false;
      const raw = fs.readFileSync(this.trustedProjectsPath, "utf-8");
      const list = JSON.parse(raw) as WorkspaceTrustRecord[];
      if (!Array.isArray(list)) return false;

      return list.some(
        (rec) =>
          rec.projectRoot === this.projectRoot &&
          rec.fingerprint === fingerprint
      );
    } catch {
      return false;
    }
  }

  /**
   * 批准信任当前项目 MCP 配置
   */
  public trustCurrentProject(): void {
    const fingerprint = this.getProjectConfigFingerprint();
    const records: WorkspaceTrustRecord[] = [];

    try {
      if (fs.existsSync(this.trustedProjectsPath)) {
        const raw = fs.readFileSync(this.trustedProjectsPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) records.push(...parsed);
      }
    } catch {}

    const filtered = records.filter((r) => r.projectRoot !== this.projectRoot);
    filtered.push({
      projectRoot: this.projectRoot,
      fingerprint,
      trustedAt: Date.now(),
    });

    const dir = path.dirname(this.trustedProjectsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

    fs.writeFileSync(this.trustedProjectsPath, JSON.stringify(filtered, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  /**
   * 撤销当前项目信任
   */
  public revokeTrustCurrentProject(): void {
    if (!fs.existsSync(this.trustedProjectsPath)) return;
    try {
      const raw = fs.readFileSync(this.trustedProjectsPath, "utf-8");
      const list = JSON.parse(raw) as WorkspaceTrustRecord[];
      if (Array.isArray(list)) {
        const filtered = list.filter((r) => r.projectRoot !== this.projectRoot);
        fs.writeFileSync(
          this.trustedProjectsPath,
          JSON.stringify(filtered, null, 2),
          { encoding: "utf-8", mode: 0o600 }
        );
      }
    } catch {}
  }
}
