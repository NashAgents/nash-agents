import type { ModelCallOptions } from "../observability/model-usage.js";
/**
 * Nash AI Session Title Generation Service
 *
 * 负责在用户发送消息后，异步通过独立小模型为当前会话生成精炼自然的标题。
 * 严格遵循 SESSION_TITLE_SYSTEM_PROMPT 规则：纯单行文本，无 Markdown/XML/代码/引号，约 10 个汉字或 5 个词。
 */

import { SESSION_TITLE_SYSTEM_PROMPT } from "./prompts/session-title.js";
import { callChatCompletions, type ChatCompletionRequest } from "../model/chat-completions-client.js";
import { getNashModelConfig, type NashModelConfig } from "../config/nash-config.js";

export interface SessionTitleOptions extends ModelCallOptions {
  modelConfig?: Partial<NashModelConfig>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SessionTitleResult {
  title: string;
  model: string;
  durationMs: number;
}

export class SessionTitleService {
  private readonly modelConfigOverride?: Partial<NashModelConfig>;

  constructor(options?: { modelConfig?: Partial<NashModelConfig> }) {
    this.modelConfigOverride = options?.modelConfig;
  }

  /**
   * 从会话历史中的人类消息生成自然语言标题
   */
  async generateTitle(
    messages: Array<{ sender: string; content: string }>,
    options?: SessionTitleOptions
  ): Promise<SessionTitleResult> {
    const startTime = Date.now();

    // 1. 严格筛选出真实人类 (user) 输入消息，杜绝 Agent 内部执行日志或工具结果污染标题语义
    const humanMessages = messages
      .filter((m) => m && m.sender === "user" && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => m.content.trim());

    if (humanMessages.length === 0) {
      return {
        title: "新任务会话",
        model: "fallback",
        durationMs: 0,
      };
    }

    // 2. 组装模型输入：按时间序将所有人类意图呈现
    // 若会话非常长，取首条意图 + 最近 3 条人类补充意图
    let selectedHumanMessages: string[];
    if (humanMessages.length <= 4) {
      selectedHumanMessages = humanMessages;
    } else {
      selectedHumanMessages = [
        humanMessages[0]!,
        ...humanMessages.slice(-3),
      ];
    }

    const formattedConversation = selectedHumanMessages
      .map((content) => `Human: ${content}`)
      .join("\n\n");

    // 3. 模型配置获取
    const baseConfig = getNashModelConfig();
    const config = { ...baseConfig, ...this.modelConfigOverride, ...options?.modelConfig };

    const baseUrl = config.baseUrl;
    const apiKey = config.apiKey;
    const model = config.sessionTitleModel || config.model;

    if (!baseUrl || !apiKey || !model) {
      // 优雅降级：若未配置可用模型，使用首条提问截断作为保底，不抛出异常阻断
      const fallback = this.fallbackTitle(humanMessages[0]!);
      return {
        title: fallback,
        model: "fallback-truncated",
        durationMs: Date.now() - startTime,
      };
    }

    const request: ChatCompletionRequest = {
      model,
      temperature: 0.1, // 低温度保证高度确定性
      messages: [
        {
          role: "system",
          content: SESSION_TITLE_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: formattedConversation,
        },
      ],
      tools: undefined,
    };

    const timeoutMs = options?.timeoutMs ?? 12000;
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => {
      timeoutController.abort(new Error(`标题生成请求超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    let combinedSignal: AbortSignal = timeoutController.signal;
    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutTimer);
        throw new Error("标题生成请求已取消");
      }
      combinedSignal = AbortSignal.any([timeoutController.signal, options.signal]);
    }

    try {
      const response = await callChatCompletions(baseUrl, apiKey, request, {
        signal: combinedSignal,
        usageSink: options?.usageSink,
        context: options?.context,
        purpose: "title",
      });

      const choice = response.choices?.[0];
      const rawOutput = choice?.message?.content;

      if (!rawOutput || typeof rawOutput !== "string") {
        throw new Error("标题生成输出为空");
      }

      const sanitized = this.sanitizeTitleOutput(rawOutput, humanMessages[0]!);

      return {
        title: sanitized,
        model,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      // 优雅降级：标题生成失败不能导致系统崩溃，采用保底逻辑
      const fallback = this.fallbackTitle(humanMessages[0]!);
      return {
        title: fallback,
        model: "fallback-error",
        durationMs: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  }

  /**
   * 清洗模型输出为标准的纯文本自然语言单行标题
   */
  public sanitizeTitleOutput(raw: string, fallbackPrompt: string): string {
    let title = raw.trim();

    // 1. 移除外层引号、反引号、代码块
    title = title.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
    title = title.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "").trim();

    // 2. 移除常见的引导前缀 (如 "Title: ", "会话标题：", "标题：", "- ", "1. ")
    title = title.replace(/^(?:Title|Session Title|会话标题|任务标题|标题)[:：]\s*/i, "").trim();
    title = title.replace(/^[-*•#\d.]+\s+/, "").trim();

    // 3. 剥离 Markdown 样式与 XML 标签
    title = title.replace(/[*_~`]/g, "");
    title = title.replace(/<[^>]+>/g, "").trim();

    // 4. 取第一行，禁止多行
    const firstLine = title.split(/\r?\n/)[0]?.trim() || "";
    title = firstLine;

    // 5. 移除末尾标点符号
    title = title.replace(/[。，,.:;!！?？]+$/, "").trim();

    // 6. 校验长度与有效性
    if (!title || title.length === 0) {
      return this.fallbackTitle(fallbackPrompt);
    }

    // 保护常见专有名词的前提下，限制最大长度（避免小模型失控输出一大段说明）
    if (title.length > 36) {
      title = title.slice(0, 32).trim() + "…";
    }

    return title;
  }

  private fallbackTitle(prompt: string): string {
    const cleaned = prompt.replace(/\s+/g, " ").trim();
    return cleaned.slice(0, 20) || "新任务";
  }
}
