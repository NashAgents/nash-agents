import type {
  ChatMessage,
  ChatMessageContentPart,
  ToolCall,
} from "../model/chat-completions-client.js";
import type { ToolResult } from "../tools/executor.js";
import type {
  ContextConfig,
  CompactionRecord,
  ProcessedToolResult,
  SessionSummary,
  SessionRecord,
} from "./types.js";
import type { SessionStore } from "./session/session-store.js";
import { LocalSessionStore } from "./session/local-session-store.js";
import type { SpillStore } from "./spill/spill-store.js";
import { LocalSpillStore } from "./spill/local-spill-store.js";
import { ToolResultManager } from "./tool-result-manager.js";
import { TokenMeter } from "./token-meter.js";
import { ToolResultPruner } from "./tool-result-pruner.js";
import { CompactionEngine } from "./compaction-engine.js";
import {
  DEFAULT_NASH_CONTEXT_CONFIG,
  DEFAULT_NASH_MODEL_CONFIG,
  type NashModelConfig,
} from "../config/nash-config.js";

import type { ProjectContext } from "../project/project-context.js";
import type { InstrumentationService } from "../observability/instrumentation-service.js";

export interface ContextManagerOptions {
  sessionId?: string;
  projectContext?: ProjectContext;
  baseDir?: string;
  config?: Partial<Omit<ContextConfig, "spill">> & {
    spill?: Partial<ContextConfig["spill"]>;
  };
  modelConfig?: Partial<NashModelConfig>;
  sessionStore?: SessionStore;
  spillStore?: SpillStore;
  tokenMeter?: TokenMeter;
  pruner?: ToolResultPruner;
  compactionEngine?: CompactionEngine;
  llmInvoker?: (messages: ChatMessage[]) => Promise<string>;
  instrumentationService?: InstrumentationService;
}

/**
 * ContextManager：Nash Agent 上下文与持久化会话总控制器
 */
export class ContextManager {
  private readonly config: ContextConfig;
  private readonly modelConfig: NashModelConfig;
  private readonly projectContext?: ProjectContext;
  private sessionStore: SessionStore;
  private readonly spillStore: SpillStore;
  private toolResultManager: ToolResultManager;
  private readonly tokenMeter: TokenMeter;
  private readonly pruner: ToolResultPruner;
  private compactionEngine: CompactionEngine;
  private readonly llmInvoker?: ContextManagerOptions["llmInvoker"];
  private instrumentationService?: InstrumentationService;

  private latestActiveMessages: ChatMessage[] = [];

  constructor(options?: ContextManagerOptions) {
    this.projectContext = options?.projectContext;
    this.llmInvoker = options?.llmInvoker;
    this.instrumentationService = options?.instrumentationService;
    const rawContext = options?.config ?? {};
    const rawSpill = rawContext.spill ?? {};

    this.config = {
      autoCompact:
        rawContext.autoCompact ?? DEFAULT_NASH_CONTEXT_CONFIG.autoCompact,
      keepRecentMessages:
        rawContext.keepRecentMessages ??
        DEFAULT_NASH_CONTEXT_CONFIG.keepRecentMessages,
      spill: {
        enabled:
          rawSpill.enabled ?? DEFAULT_NASH_CONTEXT_CONFIG.spill.enabled,
        maxInlineChars:
          rawSpill.maxInlineChars ??
          DEFAULT_NASH_CONTEXT_CONFIG.spill.maxInlineChars,
        maxArtifactBytes:
          rawSpill.maxArtifactBytes ??
          DEFAULT_NASH_CONTEXT_CONFIG.spill.maxArtifactBytes,
        maxSessionBytes:
          rawSpill.maxSessionBytes ??
          DEFAULT_NASH_CONTEXT_CONFIG.spill.maxSessionBytes,
        maxGlobalBytes:
          rawSpill.maxGlobalBytes ??
          DEFAULT_NASH_CONTEXT_CONFIG.spill.maxGlobalBytes,
        retentionDays:
          rawSpill.retentionDays ??
          DEFAULT_NASH_CONTEXT_CONFIG.spill.retentionDays,
      },
      baseDir: options?.baseDir ?? rawContext.baseDir,
    };

    const rawModel = options?.modelConfig ?? {};
    this.modelConfig = {
      baseUrl: rawModel.baseUrl ?? DEFAULT_NASH_MODEL_CONFIG.baseUrl,
      apiKey: rawModel.apiKey ?? DEFAULT_NASH_MODEL_CONFIG.apiKey,
      model: rawModel.model ?? DEFAULT_NASH_MODEL_CONFIG.model,
      contextWindow:
        rawModel.contextWindow ?? DEFAULT_NASH_MODEL_CONFIG.contextWindow,
      compactionThreshold:
        rawModel.compactionThreshold ??
        DEFAULT_NASH_MODEL_CONFIG.compactionThreshold,
    };

    this.sessionStore =
      options?.sessionStore ??
      new LocalSessionStore({
        sessionId: options?.sessionId,
        projectContext: this.projectContext,
        baseDir: this.config.baseDir,
      });

    this.spillStore =
      options?.spillStore ??
      new LocalSpillStore({
        projectContext: this.projectContext,
        baseDir: this.config.baseDir,
        policy: this.config.spill,
      });

    this.toolResultManager = new ToolResultManager({
      spillStore: this.spillStore,
      policy: this.config.spill,
      sessionId: this.sessionStore.sessionId,
    });

    this.tokenMeter =
      options?.tokenMeter ??
      new TokenMeter({
        contextWindow: this.modelConfig.contextWindow,
        compactionThreshold: this.modelConfig.compactionThreshold,
      });

    this.pruner =
      options?.pruner ??
      new ToolResultPruner();

    this.compactionEngine =
      options?.compactionEngine ??
      new CompactionEngine({
        baseUrl: this.modelConfig.baseUrl,
        apiKey: this.modelConfig.apiKey,
        model: this.modelConfig.model,
        keepRecentMessages: this.config.keepRecentMessages,
        llmInvoker: options?.llmInvoker,
        instrumentationService: this.instrumentationService,
      });
  }

  setInstrumentationService(service: InstrumentationService): void {
    this.instrumentationService = service;
    // 重新创建带有 instrumentation 的 CompactionEngine
    this.compactionEngine = new CompactionEngine({
      baseUrl: this.modelConfig.baseUrl,
      apiKey: this.modelConfig.apiKey,
      model: this.modelConfig.model,
      keepRecentMessages: this.config.keepRecentMessages,
      llmInvoker: this.llmInvoker,
      instrumentationService: service,
    });
  }

  get sessionId(): string {
    return this.sessionStore.sessionId;
  }

  getProjectContext(): ProjectContext | undefined {
    return this.projectContext;
  }

  getSession(): SessionStore {
    return this.sessionStore;
  }

  getSpillStore(): SpillStore {
    return this.spillStore;
  }

  getTokenMeter(): TokenMeter {
    return this.tokenMeter;
  }

  getPruner(): ToolResultPruner {
    return this.pruner;
  }

  getCompactionEngine(): CompactionEngine {
    return this.compactionEngine;
  }

  getConfig(): ContextConfig {
    return this.config;
  }

  /**
   * 获取当前激活的上下文消息队列
   */
  getActiveMessages(): ChatMessage[] {
    return [...this.latestActiveMessages];
  }

  /**
   * 覆盖当前激活的上下文消息队列
   */
  setActiveMessages(messages: ChatMessage[]): void {
    this.latestActiveMessages = [...messages];
  }

  /**
   * 向当前激活的上下文消息队列追加一条消息
   * 若上下文尚未初始化，先安全执行恢复再追加，保证后续模型调用能无缝引用
   */
  async appendActiveMessage(message: ChatMessage): Promise<void> {
    if (this.latestActiveMessages.length === 0) {
      await this.restoreActiveMessages();
    }
    this.latestActiveMessages.push(message);
  }

  /**
   * 切换至目标 Session 并恢复其上下文状态 (支持传入特定的 sessionsDir 如 Legacy 目录)
   */
  async switchSession(
    sessionId: string,
    options?: { sessionsDir?: string }
  ): Promise<SessionSummary> {
    this.sessionStore = new LocalSessionStore({
      sessionId,
      projectContext: this.projectContext,
      sessionsDir: options?.sessionsDir,
      baseDir: this.config.baseDir,
    });

    this.toolResultManager = new ToolResultManager({
      spillStore: this.spillStore,
      policy: this.config.spill,
      sessionId: this.sessionStore.sessionId,
    });

    this.latestActiveMessages = [];
    return await this.sessionStore.getSummary();
  }

  /**
   * 从 Durable Session 历史中恢复 Active Context
   * 若历史中存在 CompactionRecord，将自动采用 [Summary + 后续最近消息] 的精简格式恢复
   */
  async restoreActiveMessages(systemPrompt?: string): Promise<ChatMessage[]> {
    const records = await this.sessionStore.getRecords();
    if (records.length === 0) {
      this.latestActiveMessages = systemPrompt
        ? [{ role: "system", content: systemPrompt }]
        : [];
      return this.latestActiveMessages;
    }

    const compactionHistory = await this.sessionStore.getCompactionHistory();
    const messages: ChatMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }

    if (compactionHistory.length > 0) {
      // 获取最近一次 Compaction 记录
      const latestCompaction = compactionHistory[compactionHistory.length - 1]!;

      // 找到该 Compaction 记录在 JSONL 中的物理位置
      let lastCompactionIdx = -1;
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r && r.type === "compaction" && r.id === latestCompaction.id) {
          lastCompactionIdx = i;
          break;
        }
      }

      // 1. 获取在 Compaction 发生前已经写入但未被压缩的前置与后置消息
      const recordsBeforeCompaction =
        lastCompactionIdx !== -1 ? records.slice(0, lastCompactionIdx) : [];
      const convRecordsBefore = recordsBeforeCompaction.filter(
        (r) => r.type === "user" || r.type === "assistant" || r.type === "tool_result"
      );

      // 2. 获取在 Compaction 发生之后追加的新记录
      const recordsAfterCompaction =
        lastCompactionIdx !== -1 ? records.slice(lastCompactionIdx + 1) : [];
      const convRecordsAfter = recordsAfterCompaction.filter(
        (r) => r.type === "user" || r.type === "assistant" || r.type === "tool_result"
      );

      if (latestCompaction.activeMessages) {
        messages.push(...structuredClone(latestCompaction.activeMessages), ...LocalSessionStore.recordsToChatMessages(convRecordsAfter));
        this.latestActiveMessages = messages;
        return messages;
      }

      // 确定被压缩的起止位置 (优先使用稳定 Record ID，回退任意索引范围并对齐边界)
      let fromIdx = 0;
      let toIdx = convRecordsBefore.length - 1;

      if (latestCompaction.coveredFromRecordId && latestCompaction.coveredToRecordId) {
        const f = convRecordsBefore.findIndex((r) => r.id === latestCompaction.coveredFromRecordId);
        const t = convRecordsBefore.findIndex((r) => r.id === latestCompaction.coveredToRecordId);
        if (f !== -1 && t !== -1 && f <= t) {
          fromIdx = f;
          toIdx = t;
        }
      } else {
        const range = latestCompaction.compactedRange;
        fromIdx = Math.max(0, Math.min(range.startIndex, convRecordsBefore.length));
        toIdx = Math.max(fromIdx, Math.min(range.endIndex, convRecordsBefore.length - 1));
      }

      const keptPrefixRecords = convRecordsBefore.slice(0, fromIdx);
      const keptSuffixRecords = convRecordsBefore.slice(toIdx + 1);

      const recordToChatMessage = (rec: SessionRecord): ChatMessage => {
        if (rec.type === "user") {
          return { role: "user", content: rec.content };
        } else if (rec.type === "assistant") {
          return {
            role: "assistant",
            content: rec.content,
            tool_calls: rec.toolCalls,
          };
        } else if (rec.type === "tool_result") {
          return {
            role: "tool",
            tool_call_id: rec.toolCallId,
            content: rec.offloaded
              ? `[Spilled Tool Result]\nSpillRef: ${rec.spillRef}\nPreview: ${rec.preview}`
              : rec.content ?? "",
          };
        }
        return { role: "user", content: "" };
      };

      // 1. 保留前缀未压缩消息 (若有)
      for (const r of keptPrefixRecords) {
        messages.push(recordToChatMessage(r));
      }

      // 2. 插入被压缩区间的总结消息
      messages.push({
        role: "user",
        content: `[Context Summary of Previous Conversation]\n${latestCompaction.summary}`,
      });

      // 3. 保留后缀未压缩消息 (recentMessages)
      for (const r of keptSuffixRecords) {
        messages.push(recordToChatMessage(r));
      }

      // 4. 追加 Compaction 之后产生的新记录
      for (const r of convRecordsAfter) {
        messages.push(recordToChatMessage(r));
      }
    } else {
      const historyChatMessages = await this.sessionStore.toChatMessages();
      for (const msg of historyChatMessages) {
        messages.push(msg);
      }
    }

    this.latestActiveMessages = messages;
    return this.latestActiveMessages;
  }

  /**
   * 为当前轮次的自然语言输入构建完整的 Chat 消息列表（支持多轮对话与已 Resume 会话历史无缝衔接）
   */
  async buildChatMessages(
    userInput: string | ChatMessageContentPart[],
    systemPrompt: string
  ): Promise<ChatMessage[]> {
    if (this.latestActiveMessages.length === 0) {
      await this.restoreActiveMessages(systemPrompt);
    }

    // 确保首条一定是 system prompt
    if (
      this.latestActiveMessages.length === 0 ||
      this.latestActiveMessages[0].role !== "system"
    ) {
      this.latestActiveMessages.unshift({
        role: "system",
        content: systemPrompt,
      });
    } else {
      this.latestActiveMessages[0] = { role: "system", content: systemPrompt };
    }

    this.latestActiveMessages.push({
      role: "user",
      content: userInput,
    });

    return [...this.latestActiveMessages];
  }

  /**
   * 记录用户消息至 Durable Session
   */
  async recordUserMessage(
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.sessionStore.appendUserMessage(content, metadata);
  }

  /**
   * 记录 Assistant 消息至 Durable Session
   */
  async recordAssistantMessage(
    content: string | null,
    toolCalls?: ToolCall[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.sessionStore.appendAssistantMessage(
      content,
      toolCalls,
      metadata
    );
  }

  /**
   * 处理工具执行结果：
   * 1. 判断并执行 Spill 外部持久化
   * 2. 写入 Durable Session JSONL（大文件不重复存储，仅保留 preview + spillRef）
   * 3. 返回供 Active Context 使用的结构
   */
  async processToolResult(
    toolName: string,
    toolCallId: string,
    rawResult: ToolResult
  ): Promise<ProcessedToolResult> {
    const processed = await this.toolResultManager.process(
      toolName,
      toolCallId,
      rawResult
    );

    // 写入 Durable Session
    await this.sessionStore.appendToolResult(toolCallId, toolName, {
      content: processed.offloaded ? undefined : processed.content,
      preview: processed.spillRef
        ? rawResult.output.slice(0, 500)
        : undefined,
      spillRef: processed.spillRef?.locator,
      originalChars: processed.originalChars,
      offloaded: processed.offloaded,
      success: rawResult.success,
      executionTimeMs: rawResult.executionTimeMs,
    });

    if (processed.offloaded && processed.spillRef && this.instrumentationService) {
      this.instrumentationService.emitEvent("context.spilled", {
        toolName,
        toolCallId,
        bytes: processed.spillRef.bytes,
        chars: processed.spillRef.chars,
        locator: processed.spillRef.locator,
      });
      this.instrumentationService.metricsCollector?.recordSpill(
        processed.spillRef.bytes
      );
    }

    return processed;
  }

  /**
   * 调用模型前的上下文准备管线 (Preflight Pipeline)：
   *
   * 流程：
   * messages
   *    ↓
   * TokenMeter 测量压力
   *    ↓
   * 未超阈值 -> 直接返回
   *    ↓
   * 超阈值 -> ToolResultPruner 优先修剪旧工具输出
   *    ↓
   * 再次测量 -> 若降到阈值以下直接返回
   *    ↓
   * 仍超阈值 -> CompactionEngine 生成 12 模块结构化摘要
   *    ↓
   * 记录 CompactionRecord 至 Durable Session (不破坏原始完整历史)
   *    ↓
   * 返回 Summary + Recent Messages
   */
  async prepare(messages: ChatMessage[], signal?: AbortSignal): Promise<ChatMessage[]> {
    signal?.throwIfAborted();
    this.latestActiveMessages = messages;

    // 1. 若关闭了自动压缩，直接放行
    if (!this.config.autoCompact) {
      return messages;
    }

    // 2. TokenMeter 初始测量
    const initialMetrics = this.tokenMeter.measure(messages);
    if (!initialMetrics.shouldCompact) {
      return messages;
    }

    // 3. 第一阶段治理：ToolResultPruner 修剪旧 ToolResult
    const pruneResult = this.pruner.prune(messages);
    let workingMessages = pruneResult.messages;

    if (pruneResult.prunedCount > 0 && this.instrumentationService) {
      this.instrumentationService.emitEvent("context.pruned", {
        prunedCount: pruneResult.prunedCount,
        freedChars: pruneResult.freedChars,
      });
      this.instrumentationService.metricsCollector?.recordPrune();
    }

    // 4. 修剪后再次测量
    const afterPruneMetrics = this.tokenMeter.measure(workingMessages);
    if (!afterPruneMetrics.shouldCompact) {
      this.latestActiveMessages = workingMessages;
      return workingMessages;
    }

    // 5. 第二阶段治理：全量 Compaction
    let compactionResult: import("./compaction-engine.js").CompactionExecutionResult;
    if (this.instrumentationService) {
      compactionResult = await this.instrumentationService.runSpan(
        "context.compact",
        {
          keepRecentMessages: this.config.keepRecentMessages,
        },
        async () => {
          this.instrumentationService?.emitEvent("context.compaction.started", {
            keepRecentMessages: this.config.keepRecentMessages,
          });
          try {
            const res = await this.compactionEngine.compact(workingMessages, signal);
            this.instrumentationService?.emitEvent("context.compaction.completed", {
              summaryLength: res.record.summary.length,
              consolidatedCount: res.record.consolidatedCount,
            });
            this.instrumentationService?.metricsCollector?.recordCompaction(true);
            return res;
          } catch (err: unknown) {
            this.instrumentationService?.emitEvent("context.compaction.failed", {
              error: err instanceof Error ? err.message : String(err),
            });
            this.instrumentationService?.metricsCollector?.recordCompaction(false);
            throw err;
          }
        }
      );
    } else {
      compactionResult = await this.compactionEngine.compact(workingMessages, signal);
    }

    // 记录 Compaction Record 到 Durable Session
    await this.sessionStore.appendCompactionRecord(
      compactionResult.record.summary,
      compactionResult.record.compactedRange,
      compactionResult.record.consolidatedCount,
      undefined,
      compactionResult.compactedMessages.filter((message) => message.role !== "system")
    );

    this.latestActiveMessages = compactionResult.compactedMessages;
    return compactionResult.compactedMessages;
  }

  /**
   * 手动触发立即压缩（供 CLI `/compact` 命令或外部 API 调用）
   */
  async compactNow(messages?: ChatMessage[]): Promise<CompactionRecord | null> {
    const targetMessages = messages ?? this.latestActiveMessages;
    if (targetMessages.length <= 2) {
      return null;
    }

    const compactionResult =
      await this.compactionEngine.compact(targetMessages);

    await this.sessionStore.appendCompactionRecord(
      compactionResult.record.summary,
      compactionResult.record.compactedRange,
      compactionResult.record.consolidatedCount,
      undefined,
      compactionResult.compactedMessages.filter((message) => message.role !== "system")
    );

    this.latestActiveMessages = compactionResult.compactedMessages;
    return compactionResult.record;
  }
}
