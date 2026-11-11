import { callChatCompletions } from "../model/chat-completions-client.js";
import { resolveModelFormat, type ModelApiFormat } from "../model/model-adapter.js";
import { getNashModelConfig, type NashModelConfig } from "../config/nash-config.js";
import { currentModelContext } from "../product/runtime.js";

/**
 * 学习分析所需的最小模型调用抽象。
 *
 * 具体 Provider、协议与模型名全部由现有模型配置解析，调用方绝不写死。
 */
export interface LearningModelRequest {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LearningModelResponse {
  text: string;
  model?: string;
}

export type LearningModelCaller = (
  request: LearningModelRequest
) => Promise<LearningModelResponse>;

export const DEFAULT_LEARNING_TIMEOUT_MS = 20_000;

export class LearningModelUnavailableError extends Error {
  constructor(message = "No usable model configuration is available for run learning.") {
    super(message);
    this.name = "LearningModelUnavailableError";
  }
}

export interface LearningModelOverrides {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  format?: ModelApiFormat;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface ResolvedLearningModel {
  baseUrl: string;
  apiKey: string;
  model: string;
  format: ModelApiFormat;
  headers?: Record<string, string>;
  timeoutMs: number;
}

/**
 * 解析当前可用的模型配置。
 *
 * 优先使用当前 product model context（与主 Agent、Security Monitor 共用同一套配置），
 * 其次回退到 nash settings / 环境变量。协议格式继续走 resolveModelFormat 的自动识别。
 */
export function resolveLearningModelConfig(
  overrides?: LearningModelOverrides
): ResolvedLearningModel {
  const bound = currentModelContext()?.main;

  let baseUrl = overrides?.baseUrl ?? bound?.baseUrl;
  let apiKey = overrides?.apiKey ?? bound?.apiKey;
  let model = overrides?.model ?? bound?.model;
  let format = overrides?.format ?? bound?.format;
  let headers = overrides?.headers ?? bound?.headers;
  let timeoutMs = overrides?.timeoutMs ?? bound?.timeoutMs;

  if (!baseUrl || !apiKey || !model) {
    let system: NashModelConfig | undefined;
    try {
      system = getNashModelConfig();
    } catch {
      system = undefined;
    }
    baseUrl = baseUrl || system?.baseUrl;
    apiKey = apiKey || system?.apiKey;
    model = model || system?.model;
    format = format ?? system?.format;
    headers = headers ?? system?.headers;
    timeoutMs = timeoutMs ?? system?.timeoutMs;
  }

  if (!baseUrl || !apiKey || !model) {
    throw new LearningModelUnavailableError(
      "Run learning requires a configured base URL, API key and model."
    );
  }

  return {
    baseUrl,
    apiKey,
    model,
    format: resolveModelFormat(format, baseUrl),
    headers,
    timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_LEARNING_TIMEOUT_MS,
  };
}

/**
 * 默认模型调用器：单次非流式请求，受统一超时与调用方 AbortSignal 约束。
 */
export function createDefaultLearningModelCaller(
  overrides?: LearningModelOverrides
): LearningModelCaller {
  return async (request: LearningModelRequest): Promise<LearningModelResponse> => {
    const config = resolveLearningModelConfig({
      ...overrides,
      timeoutMs: request.timeoutMs ?? overrides?.timeoutMs,
    });

    const timeoutMs = Math.max(
      1,
      request.timeoutMs && request.timeoutMs > 0
        ? request.timeoutMs
        : config.timeoutMs
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    const response = await callChatCompletions(
      config.baseUrl,
      config.apiKey,
      {
        model: config.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        temperature: 0,
        stream: false,
      },
      {
        purpose: "learning",
        format: config.format,
        headers: config.headers,
        signal,
        timeoutMs,
      }
    );

    const text = response.choices?.[0]?.message?.content ?? "";
    return {
      text,
      model: response.model ?? config.model,
    };
  };
}
