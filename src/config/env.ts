import type { ModelApiFormat } from "../model/model-adapter.js";
import { getNashModelConfig } from "./nash-config.js";

export interface EnvConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow?: number;
  compactionThreshold?: number;
  format?: ModelApiFormat;
  timeoutMs?: number;
  streaming?: boolean;
  toolCalling?: boolean;
  headers?: Record<string, string>;
}

/**
 * 获取当前系统的运行配置。
 * 优先读取 NASH_HOME/settings.json（默认 ~/.nash-agents）与环境变量中的配置。
 */
export function getEnvConfig(): EnvConfig {
  const modelConfig = getNashModelConfig();

  if (!modelConfig.baseUrl) {
    throw new Error(
      "Missing required baseUrl. Run nash init or configure the model in the Nash Agents control plane."
    );
  }

  if (!modelConfig.apiKey) {
    throw new Error(
      "Missing required API key. Run nash init or configure the model in the Nash Agents control plane."
    );
  }

  if (!modelConfig.model) {
    throw new Error(
      "Missing required model. Run nash init or configure the model in the Nash Agents control plane."
    );
  }

  return {
    baseUrl: modelConfig.baseUrl,
    apiKey: modelConfig.apiKey,
    model: modelConfig.model,
    contextWindow: modelConfig.contextWindow,
    compactionThreshold: modelConfig.compactionThreshold,
    format: modelConfig.format,
    timeoutMs: modelConfig.timeoutMs,
    streaming: modelConfig.streaming,
    toolCalling: modelConfig.toolCalling,
    headers: modelConfig.headers,
  };
}
