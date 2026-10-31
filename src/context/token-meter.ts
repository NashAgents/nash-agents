import type { ChatMessage } from "../model/chat-completions-client.js";
import type { TokenUsageMetrics } from "./types.js";

/**
 * Token 估算器接口 SPI
 */
export interface TokenEstimator {
  /**
   * 估算一组 ChatMessage 消息占用的 Token 数量
   */
  estimateMessages(messages: ChatMessage[]): number;

  /**
   * 估算纯文本字符串占用的 Token 数量
   */
  estimateText(text: string): number;
}

/**
 * 基于字符特征与协议开销的保守 Token 估算器
 *
 * 设计原理：
 * - 英文单词平均约 4 字符 / Token；
 * - 中文及多字节字符通常约 1.5 ~ 2 字符 / Token；
 * - 每条消息额外附加 4 Tokens 的 role/name/delimiter 协议开销；
 * - 工具调用参数附加 JSON 结构开销。
 */
export class ConservativeTokenEstimator implements TokenEstimator {
  private readonly cjkCharRatio: number;
  private readonly defaultCharRatio: number;
  private readonly messageOverheadTokens: number;

  constructor(options?: {
    cjkCharRatio?: number;
    defaultCharRatio?: number;
    messageOverheadTokens?: number;
  }) {
    this.cjkCharRatio = options?.cjkCharRatio ?? 1.5;
    this.defaultCharRatio = options?.defaultCharRatio ?? 3.8;
    this.messageOverheadTokens = options?.messageOverheadTokens ?? 4;
  }

  estimateText(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }

    let cjkCount = 0;
    let otherCount = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // CJK 统一表意符号及常用亚洲字符范围
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x20000 && code <= 0x2a6df) ||
        (code >= 0xf900 && code <= 0xfaff)
      ) {
        cjkCount++;
      } else {
        otherCount++;
      }
    }

    const estimated =
      Math.ceil(cjkCount / this.cjkCharRatio) +
      Math.ceil(otherCount / this.defaultCharRatio);

    return Math.max(1, estimated);
  }

  estimateMessages(messages: ChatMessage[]): number {
    if (!messages || messages.length === 0) {
      return 0;
    }

    let total = 3; // primer overhead

    for (const msg of messages) {
      total += this.messageOverheadTokens;

      if (msg.content) {
        if (typeof msg.content === "string") {
          total += this.estimateText(msg.content);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === "text") {
              total += this.estimateText(part.text);
            } else if (part.type === "image_url") {
              // 多模态图像估算（约 1000 tokens）
              total += 1000;
            }
          }
        }
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          total += 4; // tool call structure
          total += this.estimateText(tc.function.name);
          if (tc.function.arguments) {
            total += this.estimateText(tc.function.arguments);
          }
        }
      }

      if (msg.tool_call_id) {
        total += 2;
      }
    }

    return total;
  }
}

export interface TokenMeterOptions {
  contextWindow: number;
  compactionThreshold: number;
  estimator?: TokenEstimator;
}

/**
 * Token 压力测量器：负责精准度量 Active Context 占用与压缩阈值判断
 */
export class TokenMeter {
  readonly contextWindow: number;
  readonly compactionThreshold: number;
  private readonly estimator: TokenEstimator;

  constructor(options: TokenMeterOptions) {
    if (options.contextWindow <= 0) {
      throw new Error(`Invalid contextWindow: ${options.contextWindow}`);
    }
    if (options.compactionThreshold <= 0 || options.compactionThreshold > 1) {
      throw new Error(
        `Invalid compactionThreshold: ${options.compactionThreshold} (must be in range (0, 1])`
      );
    }

    this.contextWindow = options.contextWindow;
    this.compactionThreshold = options.compactionThreshold;
    this.estimator = options.estimator ?? new ConservativeTokenEstimator();
  }

  /**
   * 测量给定消息集的 Token 占用及压力指标
   */
  measure(messages: ChatMessage[]): TokenUsageMetrics {
    const estimatedInputTokens = this.estimator.estimateMessages(messages);
    const usageRatio = estimatedInputTokens / this.contextWindow;
    const shouldCompact = usageRatio >= this.compactionThreshold;

    return {
      contextWindow: this.contextWindow,
      estimatedInputTokens,
      usageRatio,
      compactionThreshold: this.compactionThreshold,
      shouldCompact,
    };
  }

  /**
   * 快速判断是否需要执行压缩
   */
  shouldCompact(messages: ChatMessage[]): boolean {
    return this.measure(messages).shouldCompact;
  }

  /**
   * 获取底层估算器实例
   */
  getEstimator(): TokenEstimator {
    return this.estimator;
  }
}
