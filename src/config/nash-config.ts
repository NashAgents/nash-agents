import type { ModelApiFormat } from "../model/model-adapter.js";
import { resolveModelFormat } from "../model/model-adapter.js";
import { currentModelContext, readProductModels } from "../product/runtime.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  FilesystemMode,
  NetworkMode,
  ApprovalMode,
} from "../sandbox/types.js";
import type { ContextConfig } from "../context/types.js";
import type { ObservabilityConfig } from "../observability/types.js";
import { DEFAULT_OBSERVABILITY_CONFIG } from "../observability/types.js";
import type { MemoryConfig } from "../memory/types.js";
import type { SkillConfig } from "../skills/types.js";
import type { MCPServerConfig } from "../mcp/types.js";

/**
 * Nash 模型与上下文运行配置定义
 */
export interface NashModelConfig {
  timeoutMs?: number;
  streaming?: boolean;
  toolCalling?: boolean;
  headers?: Record<string, string>;
  /**
   * 模型 API 基础路径，默认 https://api.deepseek.com/v1
   */
  baseUrl: string;

  /**
   * 模型访问 API Key
   */
  apiKey: string;

  /**
   * 模型名称，如 deepseek-chat
   */
  model: string;

  /**
   * 最大上下文 Token 上限（Context Window），默认 64000
   */
  contextWindow: number;

  /**
   * 上下文压缩触发阈值（达到上下文的比例，如 0.8 表示 80% 即约 51200 tokens 时触发压缩）
   */
  compactionThreshold: number;

  /**
   * AI 提示词优化专用模型（可选，默认复用主模型）
   */
  promptOptimizerModel?: string;

  /**
   * AI 会话自动命名专用模型（可选，默认复用主模型）
   */
  sessionTitleModel?: string;
  /**
   * 模型协议格式：completions (OpenAI Chat), responses (OpenAI Responses), messages (Anthropic Messages)
   */
  format?: ModelApiFormat;
}

/**
 * NASH_HOME/settings.json 完整配置 Schema（默认 ~/.nash-agents）
 */
export interface NashSettingsSchema {
  /**
   * 模型与上下文配置
   */
  model?: Partial<NashModelConfig>;

  /**
   * Context 上下文管理与溢出治理配置
   */
  context?: Partial<Omit<ContextConfig, "spill">> & {
    spill?: Partial<ContextConfig["spill"]>;
  };

  /**
   * 沙箱安全策略配置
   */
  sandbox?: {
    preset?: "default" | "full" | "read-only";
    filesystem?: FilesystemMode;
    network?: NetworkMode;
    approval?: ApprovalMode;
  };

  /**
   * Observability 可观测性与 OpenTelemetry 配置
   */
  observability?: Partial<Omit<ObservabilityConfig, "otel">> & {
    otel?: Partial<ObservabilityConfig["otel"]>;
  };

  /**
   * 后台 Job 与时间治理配置
   */
  jobs?: {
    bashSoftTimeoutMs?: number;
    bashHardTimeoutMs?: number;
    waitTimeoutMs?: number;
    killGraceMs?: number;
    maxConsecutiveWakes?: number;
  };

  /**
   * Memory 长期事实与经验管理配置
   */
  memory?: Partial<MemoryConfig>;

  /**
   * Skills 可复用流程与专业技能配置
   */
  skills?: Partial<SkillConfig>;

  /**
   * Model Context Protocol (MCP) 服务配置字典
   */
  mcpServers?: Record<string, MCPServerConfig>;

  /**
   * 运行时资源与迭代限制配置
   */
  runtime?: {
    maxAgentTurns?: number;
    maxToolCalls?: number;
    maxRunMs?: number;
    maxWallTimeMs?: number;
  };
}

/**
 * 默认上下文治理配置常量
 */
export const DEFAULT_NASH_CONTEXT_CONFIG: ContextConfig = {
  autoCompact: true,
  keepRecentMessages: 30,
  spill: {
    enabled: true,
    maxInlineChars: 16_000,
    maxArtifactBytes: 16 * 1024 * 1024,
    maxSessionBytes: 256 * 1024 * 1024,
    maxGlobalBytes: 2 * 1024 * 1024 * 1024,
    retentionDays: 7,
  },
};

/**
 * 默认模型配置常量
 */
export const DEFAULT_NASH_MODEL_CONFIG: NashModelConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  contextWindow: 64_000,
  compactionThreshold: 0.8,
  format: "completions" as ModelApiFormat,
};

/**
 * 首次初始化时的访问模式裁决。
 *
 * - full-access：完全访问自主模式（danger-full-access + network allow + approval auto-grant）。
 *   仍保留确定性硬拦截、独立安全审查与可用的 OS 原生沙箱；
 *   注意它不再提供「完整文件系统隔离」保证。
 * - restricted：受限模式（workspace-write + network deny + approval ask）。
 *
 * 未显式给出时读取 NASH_INIT_ACCESS_MODE / NASH_INIT_FULL_ACCESS；
 * 二者皆无则回退 restricted —— 绝不在用户没有明确授权的情况下悄悄启用高权限。
 */
export type InitAccessMode = "full-access" | "restricted";

export interface EnsureNashSettingsOptions {
  /**
   * 自定义用户家目录（主要用于单测隔离）
   */
  homeDir?: string;

  /**
   * 首次初始化使用哪套沙箱默认值。仅在 settings.json 尚不存在时生效，
   * 既有安装永远不会被迁移或覆盖。
   */
  accessMode?: InitAccessMode;
}

export const FULL_ACCESS_SANDBOX_DEFAULTS = {
  preset: "default",
  filesystem: "danger-full-access",
  network: "allow",
  approval: "auto-grant",
} as const;

export const RESTRICTED_SANDBOX_DEFAULTS = {
  preset: "default",
  filesystem: "workspace-write",
  network: "deny",
  approval: "ask",
} as const;

function resolveInitAccessMode(options?: EnsureNashSettingsOptions): InitAccessMode {
  if (options?.accessMode) return options.accessMode;
  const explicit = (process.env.NASH_INIT_ACCESS_MODE ?? "").trim().toLowerCase();
  if (explicit === "full-access" || explicit === "restricted") return explicit;
  if (process.env.NASH_INIT_FULL_ACCESS === "1") return "full-access";
  return "restricted";
}

export interface NashSettingsStatus {
  nashDir: string;
  settingsPath: string;
  createdDir: boolean;
  createdSettings: boolean;
  settings: NashSettingsSchema;
}

/**
 * 启动时检查 NASH_HOME 目录及 settings.json 配置文件（默认 ~/.nash-agents）。
 *
 * 核心逻辑：
 * 1. 检查 NASH_HOME 目录是否存在，若不存在则递归创建；
 * 2. 检查 NASH_HOME/settings.json 是否存在，若不存在则生成包含 baseUrl, apiKey, model, contextWindow, compactionThreshold 及沙箱预设的默认配置；
 * 3. 若当前环境变量 (.env / process.env) 中已存在 DEEPSEEK_* 相关变量，在创建时会自动迁移预填入，免去重复配置；
 * 4. 返回当前全局配置状态与配置内容。
 *
 * @param options - 可选配置项
 */
export function ensureNashSettings(
  options?: EnsureNashSettingsOptions
): NashSettingsStatus {
  const homeDir = options?.homeDir ?? os.homedir();
  const nashDir = options?.homeDir ? path.join(homeDir, ".nash") : (process.env.NASH_HOME || path.join(homeDir, ".nash-agents"));
  const settingsPath = path.join(nashDir, "settings.json");

  let createdDir = false;
  let createdSettings = false;

  // 1. 检查并创建 NASH_HOME 目录
  if (!fs.existsSync(nashDir)) {
    fs.mkdirSync(nashDir, { recursive: true });
    createdDir = true;
  }

  // 2. 检查并创建 NASH_HOME/settings.json
  if (!fs.existsSync(settingsPath)) {
    // 自动尝试继承环境中已有的配置值
    const envBaseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
    const envApiKey = process.env.DEEPSEEK_API_KEY?.trim();
    const resolvedAccessMode = resolveInitAccessMode(options);
    const envModel = process.env.DEEPSEEK_MODEL?.trim();

    const initialSettings: NashSettingsSchema = {
      model: {
        baseUrl: envBaseUrl || DEFAULT_NASH_MODEL_CONFIG.baseUrl,
        apiKey: envApiKey || "your_api_key_here",
        model: envModel || DEFAULT_NASH_MODEL_CONFIG.model,
        contextWindow: DEFAULT_NASH_MODEL_CONFIG.contextWindow,
        compactionThreshold: DEFAULT_NASH_MODEL_CONFIG.compactionThreshold,
      },
      sandbox: resolvedAccessMode === "full-access"
        ? { ...FULL_ACCESS_SANDBOX_DEFAULTS }
        : { ...RESTRICTED_SANDBOX_DEFAULTS },
      context: {
        autoCompact: DEFAULT_NASH_CONTEXT_CONFIG.autoCompact,
        keepRecentMessages: DEFAULT_NASH_CONTEXT_CONFIG.keepRecentMessages,
        spill: {
          enabled: DEFAULT_NASH_CONTEXT_CONFIG.spill.enabled,
          maxInlineChars: DEFAULT_NASH_CONTEXT_CONFIG.spill.maxInlineChars,
          maxArtifactBytes: DEFAULT_NASH_CONTEXT_CONFIG.spill.maxArtifactBytes,
          maxSessionBytes: DEFAULT_NASH_CONTEXT_CONFIG.spill.maxSessionBytes,
          maxGlobalBytes: DEFAULT_NASH_CONTEXT_CONFIG.spill.maxGlobalBytes,
          retentionDays: DEFAULT_NASH_CONTEXT_CONFIG.spill.retentionDays,
        },
      },
      observability: {
        enabled: DEFAULT_OBSERVABILITY_CONFIG.enabled,
        consoleSummary: DEFAULT_OBSERVABILITY_CONFIG.consoleSummary,
        otel: {
          enabled: DEFAULT_OBSERVABILITY_CONFIG.otel.enabled,
          endpoint: DEFAULT_OBSERVABILITY_CONFIG.otel.endpoint,
          traces: DEFAULT_OBSERVABILITY_CONFIG.otel.traces,
          metrics: DEFAULT_OBSERVABILITY_CONFIG.otel.metrics,
          logs: DEFAULT_OBSERVABILITY_CONFIG.otel.logs,
          serviceName: DEFAULT_OBSERVABILITY_CONFIG.otel.serviceName,
        },
      },
    };

    fs.writeFileSync(
      settingsPath,
      JSON.stringify(initialSettings, null, 2),
      { encoding: "utf-8", mode: 0o600 }
    );
    createdSettings = true;
  }

  // 3. 读取并解析配置
  let settings: NashSettingsSchema = {};
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(content) as NashSettingsSchema;
  } catch (err: unknown) {
    console.warn(
      `\x1b[33m[Warning]\x1b[0m 解析 '${settingsPath}' 异常:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return {
    nashDir,
    settingsPath,
    createdDir,
    createdSettings,
    settings,
  };
}

/**
 * 获取当前全局生效的模型与上下文配置。
 * 优先级：
 * 1. 环境变量显式覆盖（DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY, DEEPSEEK_MODEL）；
 * 2. NASH_HOME/settings.json 中的 model 配置；
 * 3. 系统内置默认值。
 */
function normalizeBaseUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (url.startsWith("https://http://")) {
    url = url.replace("https://http://", "http://");
  } else if (url.startsWith("http://https://")) {
    url = url.replace("http://https://", "https://");
  } else if (url.startsWith("https://https://")) {
    url = url.replace("https://https://", "https://");
  } else if (url.startsWith("http://http://")) {
    url = url.replace("http://http://", "http://");
  }
  return url;
}

export function getNashModelConfig(
  options?: EnsureNashSettingsOptions
): NashModelConfig {
  if (!options?.homeDir) {
    const product = currentModelContext() ?? readProductModels();
    if (product) return product.main;
  }
  const status = ensureNashSettings(options);
  const fileModel = status.settings.model ?? {};

  const rawBaseUrl =
    process.env.DEEPSEEK_BASE_URL?.trim() ||
    fileModel.baseUrl?.trim() ||
    DEFAULT_NASH_MODEL_CONFIG.baseUrl;

  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  let apiKey =
    process.env.DEEPSEEK_API_KEY?.trim() ||
    fileModel.apiKey?.trim() ||
    "";

  // 过滤占位符字符串
  if (apiKey === "your_api_key_here") {
    apiKey = "";
  }

  const model =
    process.env.DEEPSEEK_MODEL?.trim() ||
    fileModel.model?.trim() ||
    DEFAULT_NASH_MODEL_CONFIG.model;

  const contextWindow =
    typeof fileModel.contextWindow === "number" && fileModel.contextWindow > 0
      ? fileModel.contextWindow
      : DEFAULT_NASH_MODEL_CONFIG.contextWindow;

  const compactionThreshold =
    typeof fileModel.compactionThreshold === "number" &&
    fileModel.compactionThreshold > 0
      ? fileModel.compactionThreshold
      : DEFAULT_NASH_MODEL_CONFIG.compactionThreshold;

  const sanitizedBaseUrl = baseUrl.replace(/\/+$/, "");

  const promptOptimizerModel =
    process.env.PROMPT_OPTIMIZER_MODEL?.trim() ||
    process.env.NASH_PROMPT_OPTIMIZER_MODEL?.trim() ||
    fileModel.promptOptimizerModel?.trim() ||
    undefined;

  const rawFormat =
    process.env.DEEPSEEK_API_FORMAT?.trim() ||
    process.env.DEEPSEEK_FORMAT?.trim() ||
    fileModel.format?.trim();

  const format = resolveModelFormat(rawFormat, sanitizedBaseUrl);

  const sessionTitleModel =
    process.env.SESSION_TITLE_MODEL?.trim() ||
    process.env.NASH_SESSION_TITLE_MODEL?.trim() ||
    fileModel.sessionTitleModel?.trim() ||
    undefined;

  return {
    baseUrl: sanitizedBaseUrl,
    apiKey,
    model,
    contextWindow,
    compactionThreshold,
    promptOptimizerModel,
    sessionTitleModel,
    format,
  };
}

/**
 * 获取当前全局生效的 Context 管理与溢出治理配置。
 */
export function getNashContextConfig(
  options?: EnsureNashSettingsOptions
): ContextConfig {
  const status = ensureNashSettings(options);
  const fileContext = status.settings.context ?? {};
  const fileSpill = fileContext.spill ?? {};

  return {
    autoCompact: fileContext.autoCompact ?? DEFAULT_NASH_CONTEXT_CONFIG.autoCompact,
    keepRecentMessages:
      typeof fileContext.keepRecentMessages === "number" &&
      fileContext.keepRecentMessages >= 0
        ? fileContext.keepRecentMessages
        : DEFAULT_NASH_CONTEXT_CONFIG.keepRecentMessages,
    spill: {
      enabled: fileSpill.enabled ?? DEFAULT_NASH_CONTEXT_CONFIG.spill.enabled,
      maxInlineChars:
        typeof fileSpill.maxInlineChars === "number" && fileSpill.maxInlineChars > 0
          ? fileSpill.maxInlineChars
          : DEFAULT_NASH_CONTEXT_CONFIG.spill.maxInlineChars,
      maxArtifactBytes:
        typeof fileSpill.maxArtifactBytes === "number" && fileSpill.maxArtifactBytes > 0
          ? fileSpill.maxArtifactBytes
          : DEFAULT_NASH_CONTEXT_CONFIG.spill.maxArtifactBytes,
      maxSessionBytes:
        typeof fileSpill.maxSessionBytes === "number" && fileSpill.maxSessionBytes > 0
          ? fileSpill.maxSessionBytes
          : DEFAULT_NASH_CONTEXT_CONFIG.spill.maxSessionBytes,
      maxGlobalBytes:
        typeof fileSpill.maxGlobalBytes === "number" && fileSpill.maxGlobalBytes > 0
          ? fileSpill.maxGlobalBytes
          : DEFAULT_NASH_CONTEXT_CONFIG.spill.maxGlobalBytes,
      retentionDays:
        typeof fileSpill.retentionDays === "number" && fileSpill.retentionDays >= 0
          ? fileSpill.retentionDays
          : DEFAULT_NASH_CONTEXT_CONFIG.spill.retentionDays,
    },
    baseDir: fileContext.baseDir,
  };
}

/**
 * 获取当前全局生效的 Observability 与 OpenTelemetry 配置。
 */
export function getNashObservabilityConfig(
  options?: EnsureNashSettingsOptions
): ObservabilityConfig {
  const status = ensureNashSettings(options);
  const fileObs = status.settings.observability ?? {};
  const fileOtel = fileObs.otel ?? {};

  return {
    enabled: fileObs.enabled ?? DEFAULT_OBSERVABILITY_CONFIG.enabled,
    consoleSummary:
      fileObs.consoleSummary ?? DEFAULT_OBSERVABILITY_CONFIG.consoleSummary,
    otel: {
      enabled: fileOtel.enabled ?? DEFAULT_OBSERVABILITY_CONFIG.otel.enabled,
      endpoint:
        fileOtel.endpoint ?? DEFAULT_OBSERVABILITY_CONFIG.otel.endpoint,
      traces: fileOtel.traces ?? DEFAULT_OBSERVABILITY_CONFIG.otel.traces,
      metrics: fileOtel.metrics ?? DEFAULT_OBSERVABILITY_CONFIG.otel.metrics,
      logs: fileOtel.logs ?? DEFAULT_OBSERVABILITY_CONFIG.otel.logs,
      serviceName:
        fileOtel.serviceName ?? DEFAULT_OBSERVABILITY_CONFIG.otel.serviceName,
      timeoutMs:
        typeof fileOtel.timeoutMs === "number" && fileOtel.timeoutMs > 0
          ? fileOtel.timeoutMs
          : DEFAULT_OBSERVABILITY_CONFIG.otel.timeoutMs,
    },
  };
}
