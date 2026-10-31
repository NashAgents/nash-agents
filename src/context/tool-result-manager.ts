import { createHash } from "node:crypto";
import type { ToolResult } from "../tools/executor.js";
import type { SpillStore } from "./spill/spill-store.js";
import type { SpillPolicy, ProcessedToolResult, SpillRef } from "./types.js";
import { DEFAULT_SPILL_POLICY } from "./spill/spill-policy.js";
import { AdaptiveContextManager } from "./adaptive-context-manager.js";

export interface ToolResultManagerOptions {
  spillStore: SpillStore;
  policy?: Partial<SpillPolicy>;
  sessionId?: string;
  previewChars?: number;
}

export class ToolResultManager {
  private readonly spillStore: SpillStore;
  private readonly policy: SpillPolicy;
  private sessionId: string;
  private readonly previewChars: number;
  private readonly adaptiveManager: AdaptiveContextManager;

  constructor(options: ToolResultManagerOptions) {
    this.spillStore = options.spillStore;
    this.policy = {
      ...DEFAULT_SPILL_POLICY,
      ...options.policy,
    };
    this.sessionId = options.sessionId ?? "default";
    this.previewChars = options.previewChars ?? 500;
    this.adaptiveManager = new AdaptiveContextManager({
      spillStore: this.spillStore,
      sessionId: this.sessionId,
      defaultInlineBudgetChars: 4000,
      maxInlineChars: this.policy.maxInlineChars,
      previewEdgeChars: this.previewChars,
    });
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.adaptiveManager.setSessionId(sessionId);
  }

  /**
   * 处理工具执行结果：自适应判断内联、结构化提炼或外部 Spill 归档
   */
  async process(
    toolName: string,
    toolCallId: string,
    result: ToolResult,
    options?: { commandHint?: string }
  ): Promise<ProcessedToolResult> {
    const rawOutput = result.output ?? "";
    const originalChars = rawOutput.length;

    // 核心保护：read_tool_result 本身绝不递归进行 Spill 存储，避免循环膨胀
    if (toolName === "read_tool_result") {
      return {
        content: rawOutput,
        offloaded: false,
        originalChars,
        rawResult: result,
      };
    }

    if (!this.policy.enabled) {
      return {
        content: rawOutput,
        offloaded: false,
        originalChars,
        rawResult: result,
      };
    }

    const adaptiveRes = await this.adaptiveManager.processResult(
      toolName,
      toolCallId,
      result,
      { commandHint: options?.commandHint, isError: !result.success }
    );

    return {
      content: adaptiveRes.content,
      offloaded: adaptiveRes.mode !== "direct_inline",
      originalChars,
      spillRef: adaptiveRes.spillRef,
      rawResult: result,
    };
  }
}
