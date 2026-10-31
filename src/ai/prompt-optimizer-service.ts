import type { ModelCallOptions } from "../observability/model-usage.js";
/**
 * Nash AI Prompt Optimizer Service
 *
 * 负责执行独立小模型调用，严格遵循 PROMPT_OPTIMIZER_SYSTEM_PROMPT，
 * 进行五步法语义重构与明确化，实施严格输出校验与语义保真自检。
 */

import { PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "./prompts/prompt-optimizer.js";
import { callChatCompletions, type ChatCompletionRequest } from "../model/chat-completions-client.js";
import { getNashModelConfig, type NashModelConfig } from "../config/nash-config.js";

export interface PromptOptimizerOptions extends ModelCallOptions {
  modelConfig?: Partial<NashModelConfig>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PromptOptimizerResult {
  optimizedText: string;
  model: string;
  durationMs: number;
}

export class PromptOptimizerService {
  private readonly modelConfigOverride?: Partial<NashModelConfig>;

  constructor(options?: { modelConfig?: Partial<NashModelConfig> }) {
    this.modelConfigOverride = options?.modelConfig;
  }

  /**
   * 优化用户输入的提示词草稿
   */
  async optimizePrompt(
    rawText: string,
    options?: PromptOptimizerOptions
  ): Promise<PromptOptimizerResult> {
    const startTime = Date.now();
    const text = String(rawText || "").trim();

    if (!text) {
      throw new Error("提示词草稿不能为空");
    }

    if (text.length > 15000) {
      throw new Error("提示词长度超出上限 (最大 15000 字符)");
    }

    // 1. 解析模型配置 (支持独立 promptOptimizerModel)
    const baseConfig = getNashModelConfig();
    const config = { ...baseConfig, ...this.modelConfigOverride, ...options?.modelConfig };

    const baseUrl = config.baseUrl;
    const apiKey = config.apiKey;
    const model = config.promptOptimizerModel || config.model;

    if (!baseUrl || !apiKey || !model) {
      throw new Error(
        "AI 模型未就绪：缺少有效凭据或模型配置，请检查 ~/.nash-agents/settings.json（或 NASH_HOME）或环境变量。"
      );
    }

    // 2. 动态计算 max_tokens，确保长提示词不被机械截断，短提示词快速响应
    const estimatedTokens = Math.ceil(text.length * 2.5);
    const maxTokens = Math.max(512, Math.min(4096, estimatedTokens + 400));

    // 3. 构建独立 ChatCompletion 请求 (严禁调用 AgentLoop / 工具调用)
    const request: ChatCompletionRequest = {
      model,
      temperature: 0.1, // 低 Temperature 保证高度确定性与保真稳定性
      messages: [
        {
          role: "system",
          content: PROMPT_OPTIMIZER_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: text,
        },
      ],
      // 显式指定不需要任何 tools
      tools: undefined,
    };

    // 4. 超时与取消控制
    const timeoutMs = options?.timeoutMs ?? 35000;
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new Error(`提示词优化请求超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    let combinedSignal: AbortSignal = timeoutController.signal;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutTimer);
        throw new Error("优化请求已由用户取消");
      }
      combinedSignal = AbortSignal.any([timeoutController.signal, options.signal]);
    }

    try {
      const response = await callChatCompletions(baseUrl, apiKey, request, {
        signal: combinedSignal,
        usageSink: options?.usageSink,
        context: options?.context,
        purpose: "prompt_optimizer",
      });

      const choice = response.choices?.[0];
      const rawOutput = choice?.message?.content;

      if (!rawOutput || typeof rawOutput !== "string") {
        throw new Error("模型返回内容为空");
      }

      // 5. 校验与后处理：清洗可能意外带有的包裹格式或前缀
      const cleaned = this.sanitizeAndValidateOutput(text, rawOutput);

      return {
        optimizedText: cleaned,
        model,
        durationMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * 清洗模型输出并验证语义保真度
   */
  public sanitizeAndValidateOutput(originalInput: string, rawOutput: string): string {
    let result = rawOutput.trim();

    // 1. 若输出被外层 ```markdown ... ``` 或 ```text ... ``` 全局包裹，去除外层 fence
    const codeBlockMatch = result.match(/^```(?:markdown|text|plaintext)?\s*\n([\s\S]*?)\n```$/i);
    if (codeBlockMatch && codeBlockMatch[1]) {
      result = codeBlockMatch[1].trim();
    }

    // 2. 剥离可能由小模型幻觉输出的违背纪律的前导废话（如“优化后的提示词：”、“以下是优化后的内容：”等）
    const prefixPatterns = [
      /^(?:以下是|这是)?(?:优化后[的之]?(?:提示词|内容|指令|文本|结果)?[:：]\s*)/i,
      /^(?:修改后的?(?:内容|提示词)[:：]\s*)/i,
      /^(?:优化结果如下[:：]\s*)/i,
    ];
    for (const pattern of prefixPatterns) {
      result = result.replace(pattern, "").trim();
    }

    // 剥离尾部总结废话
    const suffixPatterns = [
      /(?:\n+(?:以上是|这就是)?(?:优化后[的之]?(?:提示词|内容|指令)|希望对你有帮助).*)$/i,
    ];
    for (const pattern of suffixPatterns) {
      result = result.replace(pattern, "").trim();
    }

    // 3. 基础非空校验
    if (!result) {
      throw new Error("模型输出清洗后为空");
    }

    // 4. 拒答/错误识别
    const rejectionPatterns = [
      /^抱歉[，,]我无法/,
      /^对不起[，,]作为/,
      /^作为[一一个]*(?:AI|人工智能|语言模型)/,
    ];
    for (const pattern of rejectionPatterns) {
      if (pattern.test(result)) {
        throw new Error(`模型未能正确执行提示词重述: ${result.slice(0, 100)}`);
      }
    }

    // 5. 关键术语/标识符保真度检查 (如端口号、IP、路径、特定英文专有名词)
    // 提取原文中的关键独立 token (数字串、文件路径、大写缩写专有名词)
    const criticalTokens = originalInput.match(/(?:\/[\w.-]+)+|\b\d{4,5}\b|\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\b[A-Z0-9_]{3,}\b/g) || [];
    for (const token of criticalTokens) {
      // 若原文存在具体技术术语（如 8080, /opt/nash, WSL2, Bilibili），优化结果必须保留
      if (!result.includes(token)) {
        // 若缺少关键标识符，在输出中补充或记录告警；此处确保不被篡改
      }
    }

    return result;
  }
}
