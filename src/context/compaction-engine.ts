import crypto from "node:crypto";
import {
  callChatCompletions,
  type ChatMessage,
  type ChatCompletionRequest,
} from "../model/chat-completions-client.js";
import type { CompactionRecord } from "./types.js";
import { COMPACTION_SYSTEM_PROMPT } from "./compaction-prompt.js";
import type { InstrumentationService } from "../observability/instrumentation-service.js";

export interface CompactionEngineOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  keepRecentMessages?: number;
  llmInvoker?: (messages: ChatMessage[]) => Promise<string>;
  instrumentationService?: InstrumentationService;
}

export interface CompactionExecutionResult {
  compactedMessages: ChatMessage[];
  record: CompactionRecord;
}

function stringifyMessageContent(content?: string | Array<{ type: string; text?: string }> | null): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p.type === "text" && p.text) return p.text;
        if (p.type === "image_url") return "[Image Attachment]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

export class CompactionEngine {
  private readonly baseUrl?: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly keepRecentMessages: number;
  private readonly llmInvoker?: (messages: ChatMessage[]) => Promise<string>;
  private readonly instrumentationService?: InstrumentationService;

  constructor(options?: CompactionEngineOptions) {
    this.baseUrl = options?.baseUrl;
    this.apiKey = options?.apiKey;
    this.model = options?.model;
    this.keepRecentMessages = options?.keepRecentMessages ?? 30;
    this.llmInvoker = options?.llmInvoker;
    this.instrumentationService = options?.instrumentationService;
  }

  /**
   * 执行完整的历史上下文压缩
   */
  async compact(messages: ChatMessage[], signal?: AbortSignal): Promise<CompactionExecutionResult> {
    signal?.throwIfAborted();
    if (messages.length <= 2) {
      throw new Error("消息数量过少，无需或无法执行上下文压缩。");
    }

    // 1. 拆分 System Prompt
    let systemMessage: ChatMessage | undefined;
    let nonSystemStartIndex = 0;

    if (messages[0]?.role === "system") {
      systemMessage = messages[0];
      nonSystemStartIndex = 1;
    }

    const workingMessages = messages.slice(nonSystemStartIndex);

    // 2. 确定切分点 (splitIndex) 并维护 tool_call / tool_result 对应完整性
    let splitIndex = Math.max(0, workingMessages.length - this.keepRecentMessages);

    // 边界保护：若 splitIndex 指向 tool 消息，向左回溯找到触发该工具的 assistant 消息
    while (splitIndex > 0 && workingMessages[splitIndex]?.role === "tool") {
      splitIndex--;
    }

    // 如果待压缩的历史消息为空，无法压缩
    if (splitIndex <= 0) {
      // 至少切出前半部分进行压缩
      splitIndex = Math.floor(workingMessages.length / 2);
      while (splitIndex > 0 && workingMessages[splitIndex]?.role === "tool") {
        splitIndex--;
      }
      if (splitIndex <= 0) {
        splitIndex = 1;
        while (workingMessages[splitIndex]?.role === "tool") splitIndex++;
      }
    }

    const messagesToCompact = workingMessages.slice(0, splitIndex);
    const recentMessages = workingMessages.slice(splitIndex);

    // 3. 检查待压缩历史中是否包含此前的 Compaction Summary（多次压缩 Consolidated 场景）
    let previousSummaryText = "";
    let previousConsolidatedCount = 0;

    const filteredToCompact: ChatMessage[] = [];
    for (const msg of messagesToCompact) {
      const content = stringifyMessageContent(msg.content);
      if (
        content.startsWith("[Context Summary of Previous Conversation]")
      ) {
        previousSummaryText +=
          (previousSummaryText ? "\n\n" : "") +
          content.replace(
            "[Context Summary of Previous Conversation]\n\n",
            ""
          );
        previousConsolidatedCount++;
      } else {
        filteredToCompact.push(msg);
      }
    }

    // 4. 格式化待压缩的对话文本
    const historyLines: string[] = [];
    if (previousSummaryText) {
      historyLines.push(
        "=== PREVIOUS CONSOLIDATED SUMMARY ===",
        previousSummaryText,
        "",
        "=== NEW CONVERSATION HISTORY SINCE PREVIOUS SUMMARY ==="
      );
    }

    for (const msg of filteredToCompact) {
      const roleTag = msg.role.toUpperCase();
      const contentText = stringifyMessageContent(msg.content);
      if (msg.tool_calls) {
        const callsDesc = msg.tool_calls
          .map(
            (c) =>
              `ToolCall: ${c.function.name}(${c.function.arguments || ""}) [id: ${c.id}]`
          )
          .join("\n");
        historyLines.push(`[${roleTag}]\n${contentText}\n${callsDesc}`);
      } else if (msg.role === "tool") {
        historyLines.push(
          `[TOOL_RESULT (call_id: ${msg.tool_call_id})]\n${contentText}`
        );
      } else {
        historyLines.push(`[${roleTag}]\n${contentText}`);
      }
    }

    const promptPayload: ChatMessage[] = [
      {
        role: "system",
        content: COMPACTION_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `Please compact the following conversation history into the standard 12-section summary according to your instructions:\n\n${historyLines.join(
          "\n\n"
        )}`,
      },
    ];

    // 5. 触发 LLM 纯文本摘要请求（绝不包含任何 tools 或 tool_choice）
    let summary: string;

    const doCall = async (): Promise<string> => {
      if (this.llmInvoker) {
        return await this.llmInvoker(promptPayload);
      } else {
        if (!this.baseUrl || !this.apiKey || !this.model) {
          throw new Error(
            "CompactionEngine 缺少模型调用凭据 (baseUrl, apiKey, model)，且未注入 llmInvoker。"
          );
        }

        const req: ChatCompletionRequest = {
          model: this.model,
          messages: promptPayload,
          temperature: 0.2,
        };

        const resp = await callChatCompletions(
          this.baseUrl,
          this.apiKey,
          req,
          { signal, purpose: "compaction" }
        );

        return resp.choices[0]?.message?.content ?? "";
      }
    };

    if (this.instrumentationService) {
      summary = await this.instrumentationService.runSpan(
        "model.call:compaction",
        {
          "gen_ai.system": "deepseek",
          "gen_ai.request.model": this.model || "custom",
        },
        doCall,
        { eventTypePrefix: "model" }
      );
    } else {
      summary = await doCall();
    }

    if (!summary || summary.trim().length === 0) {
      throw new Error("Compaction 失败：模型返回了空摘要。");
    }

    const recordId = crypto.randomUUID();
    const record: CompactionRecord = {
      id: recordId,
      type: "compaction",
      summary: summary.trim(),
      compactedRange: {
        startIndex: nonSystemStartIndex,
        endIndex: nonSystemStartIndex + splitIndex - 1,
      },
      consolidatedCount: previousConsolidatedCount + 1,
      createdAt: Date.now(),
    };

    // 6. 构造压缩后的 Active Context
    const summaryMessage: ChatMessage = {
      role: "user",
      content: `[Context Summary of Previous Conversation]\n\n${summary.trim()}`,
    };

    const newActiveMessages: ChatMessage[] = [];
    if (systemMessage) {
      newActiveMessages.push(systemMessage);
    }
    newActiveMessages.push(summaryMessage);
    newActiveMessages.push(...recentMessages);

    return {
      compactedMessages: newActiveMessages,
      record,
    };
  }
}
