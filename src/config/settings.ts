import { resolveNashHome } from "./data-home.js";
import { ProductStore } from "../product/store.js";
import type { ModelApiFormat } from "../model/model-adapter.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  SandboxPolicy,
  FilesystemMode,
  NetworkMode,
  ApprovalMode,
} from "../sandbox/types.js";
import type { ContextConfig } from "../context/types.js";
import type { ObservabilityConfig } from "../observability/types.js";
import { DEFAULT_OBSERVABILITY_CONFIG } from "../observability/types.js";
import type { MemoryConfig } from "../memory/types.js";
import { DEFAULT_MEMORY_CONFIG } from "../memory/types.js";
import type { SkillConfig } from "../skills/types.js";
import { DEFAULT_SKILL_CONFIG } from "../skills/types.js";
import type { MCPServerConfig } from "../mcp/types.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";
import {
  ensureNashSettings,
  DEFAULT_NASH_CONTEXT_CONFIG,
  type EnsureNashSettingsOptions,
} from "./nash-config.js";

export interface SettingsSchema {
  sandbox?: {
    preset?: "default" | "full" | "read-only";
    filesystem?: FilesystemMode;
    network?: NetworkMode;
    approval?: ApprovalMode;
  };
  model?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    contextWindow?: number;
    compactionThreshold?: number;
    promptOptimizerModel?: string;
    sessionTitleModel?: string;
    format?: ModelApiFormat;
  };
  context?: Partial<Omit<ContextConfig, "spill">> & {
    spill?: Partial<ContextConfig["spill"]>;
  };
  observability?: Partial<Omit<ObservabilityConfig, "otel">> & {
    otel?: Partial<ObservabilityConfig["otel"]>;
  };
  jobs?: {
    bashSoftTimeoutMs?: number;
    bashHardTimeoutMs?: number;
    waitTimeoutMs?: number;
    killGraceMs?: number;
    maxConsecutiveWakes?: number;
  };
  memory?: Partial<MemoryConfig>;
  skills?: Partial<SkillConfig>;
  mcpServers?: Record<string, MCPServerConfig>;
  runtime?: {
    maxAgentTurns?: number;
    maxToolCalls?: number;
    maxRunMs?: number;
    maxWallTimeMs?: number;
  };
  cluster?: {
    enabled?: boolean;
    role?: "coordinator" | "worker" | "coordinator-worker";
    coordinator?: {
      listenHost?: string;
      listenPort?: number;
      publicUrl?: string;
      databaseUrl?: string;
      adminApiKey?: string;
      tls?: {
        certPath?: string;
        keyPath?: string;
      };
    };
    worker?: {
      enabled?: boolean;
      coordinatorUrl?: string;
      nodeId?: string;
      nodeToken?: string;
      heartbeatIntervalMs?: number;
      maxConcurrentRuns?: number;
      /** 单次安全审查模型请求超时 (ms)。 */
      securityMonitorTimeoutMs?: number;
      /** 安全审查总预算 (ms)，包含重试与退避。 */
      securityReviewTotalTimeoutMs?: number;
      /** 单节点真实安全审查最大在途并发，跨任务共享。 */
      securityReviewConcurrency?: number;
      /** 人工审批等待上限 (ms)；超时 Fail-Closed 并通知 Coordinator。 */
      approvalTimeoutMs?: number;
    };
  };
}

/**
 * 默认工作区 settings.json 配置文件名称
 */
const DEFAULT_SETTINGS_FILE = "settings.json";

/**
 * 从本地或全局 settings.json 加载沙箱安全策略配置。
 *
 * 搜索优先级：
 * 1. 显式指定的 configFilePath；
 * 2. 当前项目工作区根目录的 settings.json；
 * 3. 用户全局配置目录 NASH_HOME/settings.json（默认 ~/.nash-agents）；
 * 4. 系统内置默认策略。
 *
 * @param configFilePath - 可选的自定义配置文件路径
 */
export function loadSandboxPolicyFromSettings(
  configFilePath?: string,
  options?: { projectRoot?: string; homeDir?: string; nashHome?: string }
): SandboxPolicy {
  const dataHome = options?.nashHome ?? (options?.homeDir ? path.join(options.homeDir, ".nash") : resolveNashHome());
  if (!configFilePath && fs.existsSync(path.join(dataHome, "product.db"))) {
    const product = new ProductStore({ homeDir: dataHome });
    try {
      if (product.isInitialized()) {
        const config = product.getPublicConfig();
        return { filesystem: { mode: config.security.filesystem }, network: { mode: config.security.network }, approval: { mode: config.security.approval } };
      }
    } finally { product.close(); }
  }
  if (!options?.nashHome) ensureNashSettings(options);

  const policy = createDefaultSandboxPolicy();

  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(options?.projectRoot ?? process.cwd(), configFilePath);
  } else {
    // 优先工作区 settings.json
    const workspaceSettings = path.resolve(options?.projectRoot ?? process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      // 其次全局 NASH_HOME/settings.json（默认 ~/.nash-agents）
      const globalSettings = path.join(options?.nashHome ?? (options?.homeDir ? path.join(options.homeDir, ".nash") : resolveNashHome()), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return policy;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;

    const sandboxConfig = parsed.sandbox;
    if (!sandboxConfig) {
      return policy;
    }

    // 1. 处理预设 preset 模式快捷配置
    if (sandboxConfig.preset === "full") {
      policy.filesystem.mode = "danger-full-access";
      policy.network.mode = "allow";
      // 完全访问自主模式：仍保留确定性硬拦截与独立安全审查，只是不再逐次打断用户。
      policy.approval.mode = "auto-grant";
    } else if (sandboxConfig.preset === "read-only") {
      policy.filesystem.mode = "read-only";
      policy.network.mode = "deny";
      policy.approval.mode = "ask";
    }

    // 2. 细粒度覆盖优先级高于 preset
    if (typeof sandboxConfig.filesystem === "string" && ["read-only", "workspace-write", "full-capability", "danger-full-access"].includes(sandboxConfig.filesystem)) {
      policy.filesystem.mode = sandboxConfig.filesystem;
    }
    if (typeof sandboxConfig.network === "string" && ["allow", "deny"].includes(sandboxConfig.network)) {
      policy.network.mode = sandboxConfig.network;
    }
    if (typeof sandboxConfig.approval === "string" && ["ask", "never", "auto-grant"].includes(sandboxConfig.approval)) {
      policy.approval.mode = sandboxConfig.approval;
    }

    return policy;
  } catch (err: unknown) {
    console.warn(
      `\x1b[33m[Warning]\x1b[0m 解析 '${targetPath}' 失败，已回退至默认安全策略:`,
      err instanceof Error ? err.message : String(err)
    );
    return policy;
  }
}

/**
 * 从本地或全局 settings.json 加载 Context 治理策略配置。
 *
 * 搜索优先级：
 * 1. 显式指定的 configFilePath；
 * 2. 当前项目工作区根目录的 settings.json；
 * 3. 用户全局配置目录 NASH_HOME/settings.json（默认 ~/.nash-agents）；
 * 4. 系统内置默认策略。
 */
export function loadContextConfigFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): ContextConfig {
  ensureNashSettings(options);

  const defaults: ContextConfig = {
    autoCompact: DEFAULT_NASH_CONTEXT_CONFIG.autoCompact,
    keepRecentMessages: DEFAULT_NASH_CONTEXT_CONFIG.keepRecentMessages,
    spill: { ...DEFAULT_NASH_CONTEXT_CONFIG.spill },
  };

  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const ctx = parsed.context;
    if (!ctx) {
      return defaults;
    }

    const spill = ctx.spill ?? {};

    return {
      autoCompact: ctx.autoCompact ?? defaults.autoCompact,
      keepRecentMessages:
        typeof ctx.keepRecentMessages === "number" && ctx.keepRecentMessages >= 0
          ? ctx.keepRecentMessages
          : defaults.keepRecentMessages,
      spill: {
        enabled: spill.enabled ?? defaults.spill.enabled,
        maxInlineChars:
          typeof spill.maxInlineChars === "number" && spill.maxInlineChars > 0
            ? spill.maxInlineChars
            : defaults.spill.maxInlineChars,
        maxArtifactBytes:
          typeof spill.maxArtifactBytes === "number" && spill.maxArtifactBytes > 0
            ? spill.maxArtifactBytes
            : defaults.spill.maxArtifactBytes,
        maxSessionBytes:
          typeof spill.maxSessionBytes === "number" && spill.maxSessionBytes > 0
            ? spill.maxSessionBytes
            : defaults.spill.maxSessionBytes,
        maxGlobalBytes:
          typeof spill.maxGlobalBytes === "number" && spill.maxGlobalBytes > 0
            ? spill.maxGlobalBytes
            : defaults.spill.maxGlobalBytes,
        retentionDays:
          typeof spill.retentionDays === "number" && spill.retentionDays >= 0
            ? spill.retentionDays
            : defaults.spill.maxSessionBytes,
      },
      baseDir: ctx.baseDir,
    };
  } catch (err: unknown) {
    console.warn(
      `\x1b[33m[Warning]\x1b[0m 解析 '${targetPath}' Context 配置失败，已回退至默认配置:`,
      err instanceof Error ? err.message : String(err)
    );
    return defaults;
  }
}

/**
 * 从本地或全局 settings.json 加载 Observability 配置。
 */
export function loadObservabilityConfigFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): ObservabilityConfig {
  ensureNashSettings(options);

  const defaults: ObservabilityConfig = {
    enabled: DEFAULT_OBSERVABILITY_CONFIG.enabled,
    consoleSummary: DEFAULT_OBSERVABILITY_CONFIG.consoleSummary,
    otel: { ...DEFAULT_OBSERVABILITY_CONFIG.otel },
  };

  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const obs = parsed.observability;
    if (!obs) {
      return defaults;
    }

    const otel = obs.otel ?? {};

    return {
      enabled: obs.enabled ?? defaults.enabled,
      consoleSummary: obs.consoleSummary ?? defaults.consoleSummary,
      otel: {
        enabled: otel.enabled ?? defaults.otel.enabled,
        endpoint: otel.endpoint ?? defaults.otel.endpoint,
        traces: otel.traces ?? defaults.otel.traces,
        metrics: otel.metrics ?? defaults.otel.metrics,
        logs: otel.logs ?? defaults.otel.logs,
        serviceName: otel.serviceName ?? defaults.otel.serviceName,
        timeoutMs:
          typeof otel.timeoutMs === "number" && otel.timeoutMs > 0
            ? otel.timeoutMs
            : defaults.otel.timeoutMs,
      },
    };
  } catch (err: unknown) {
    console.warn(
      `\x1b[33m[Warning]\x1b[0m 解析 '${targetPath}' Observability 配置失败，已回退至默认配置:`,
      err instanceof Error ? err.message : String(err)
    );
    return defaults;
  }
}

/**
 * 从本地或全局 settings.json 加载 Background Jobs 配置
 */
export function loadJobsConfigFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): {
  bashSoftTimeoutMs: number;
  bashHardTimeoutMs: number;
  waitTimeoutMs: number;
  killGraceMs: number;
  maxConsecutiveWakes: number;
} {
  ensureNashSettings(options);

  const defaults = {
    bashSoftTimeoutMs: 120_000,
    bashHardTimeoutMs: 1_800_000,
    waitTimeoutMs: 30_000,
    killGraceMs: 5_000,
    maxConsecutiveWakes: 20,
  };

  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const j = parsed.jobs;
    if (!j) return defaults;

    let soft = typeof j.bashSoftTimeoutMs === "number" && j.bashSoftTimeoutMs > 0 ? j.bashSoftTimeoutMs : defaults.bashSoftTimeoutMs;
    let hard = typeof j.bashHardTimeoutMs === "number" && j.bashHardTimeoutMs > 0 ? j.bashHardTimeoutMs : defaults.bashHardTimeoutMs;
    // 强制 hardTimeout > softTimeout 约束校验
    if (hard <= soft) {
      hard = soft + 60_000;
    }

    return {
      bashSoftTimeoutMs: soft,
      bashHardTimeoutMs: hard,
      waitTimeoutMs: typeof j.waitTimeoutMs === "number" && j.waitTimeoutMs > 0 ? j.waitTimeoutMs : defaults.waitTimeoutMs,
      killGraceMs: typeof j.killGraceMs === "number" && j.killGraceMs > 0 ? j.killGraceMs : defaults.killGraceMs,
      maxConsecutiveWakes: typeof j.maxConsecutiveWakes === "number" && j.maxConsecutiveWakes > 0 ? j.maxConsecutiveWakes : defaults.maxConsecutiveWakes,
    };
  } catch {
    return defaults;
  }
}

/**
 * 从本地或全局 settings.json 加载 Runtime Limits 配置
 */
export function loadRuntimeLimitsFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): {
  maxAgentTurns: number;
  maxToolCalls: number;
  maxRunMs: number;
} {
  ensureNashSettings(options);

  const defaults = {
    maxAgentTurns: 100,
    maxToolCalls: 200,
    maxRunMs: 1_800_000,
  };

  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const r = parsed.runtime;
    if (!r) return defaults;

    return {
      maxAgentTurns: typeof r.maxAgentTurns === "number" && r.maxAgentTurns > 0 ? r.maxAgentTurns : defaults.maxAgentTurns,
      maxToolCalls: typeof r.maxToolCalls === "number" && r.maxToolCalls > 0 ? r.maxToolCalls : defaults.maxToolCalls,
      maxRunMs: typeof r.maxRunMs === "number" && r.maxRunMs > 0 ? r.maxRunMs : (typeof r.maxWallTimeMs === "number" && r.maxWallTimeMs > 0 ? r.maxWallTimeMs : defaults.maxRunMs),
    };
  } catch {
    return defaults;
  }
}

/**
 * 从本地或全局 settings.json 加载 Memory 治理策略配置
 */
export function loadMemoryConfigFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): MemoryConfig {
  ensureNashSettings(options);

  const defaults: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const mem = parsed.memory;
    if (!mem) return defaults;

    return {
      enabled: mem.enabled ?? defaults.enabled,
      autoLearn: mem.autoLearn ?? defaults.autoLearn,
      maxContextEntries: typeof mem.maxContextEntries === "number" && mem.maxContextEntries > 0 ? mem.maxContextEntries : defaults.maxContextEntries,
      maxContextTokens: typeof mem.maxContextTokens === "number" && mem.maxContextTokens > 0 ? mem.maxContextTokens : defaults.maxContextTokens,
    };
  } catch {
    return defaults;
  }
}

/**
 * 从本地或全局 settings.json 加载 Skills 策略配置
 */
export function loadSkillConfigFromSettings(
  configFilePath?: string,
  options?: EnsureNashSettingsOptions
): SkillConfig {
  ensureNashSettings(options);

  const defaults: SkillConfig = { ...DEFAULT_SKILL_CONFIG };
  let targetPath: string | undefined;

  if (configFilePath) {
    targetPath = path.resolve(process.cwd(), configFilePath);
  } else {
    const workspaceSettings = path.resolve(process.cwd(), DEFAULT_SETTINGS_FILE);
    if (fs.existsSync(workspaceSettings)) {
      targetPath = workspaceSettings;
    } else {
      const homeDir = options?.homeDir ?? os.homedir();
      const globalSettings = path.join(options?.homeDir ? path.join(homeDir, ".nash") : resolveNashHome(), "settings.json");
      if (fs.existsSync(globalSettings)) {
        targetPath = globalSettings;
      }
    }
  }

  if (!targetPath || !fs.existsSync(targetPath)) {
    return defaults;
  }

  try {
    const rawContent = fs.readFileSync(targetPath, "utf-8");
    const parsed = JSON.parse(rawContent) as SettingsSchema;
    const s = parsed.skills;
    if (!s) return defaults;

    return {
      enabled: s.enabled ?? defaults.enabled,
      autoDiscover: s.autoDiscover ?? defaults.autoDiscover,
      autoGenerate: s.autoGenerate ?? defaults.autoGenerate,
      maxMetadataEntries: typeof s.maxMetadataEntries === "number" && s.maxMetadataEntries > 0 ? s.maxMetadataEntries : defaults.maxMetadataEntries,
    };
  } catch {
    return defaults;
  }
}
