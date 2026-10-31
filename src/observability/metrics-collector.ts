import type { MetricsSnapshot } from "./types.js";

/**
 * 辅助格式化工具：数字千分位
 */
function formatNumber(num: number): string {
  return num.toLocaleString("en-US");
}

/**
 * 辅助格式化工具：字节大小转可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 辅助格式化工具：毫秒转秒
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * MetricsCollector：轻量级聚合指标收集器
 * 独立计算 Agent、Model、Tool、Context、Sandbox 等各项运行统计，绝不保存巨型原始事件文本
 */
export class MetricsCollector {
  private agentRuns = 0;
  private agentSuccess = 0;
  private agentFailures = 0;
  private agentDurationMs = 0;

  private modelCalls = 0;
  private modelFailures = 0;
  private modelLatencyMs = 0;
  private inputTokens = 0;
  private outputTokens = 0;

  private toolCalls = 0;
  private toolFailures = 0;
  private toolLatencyMs = 0;
  private readonly perToolCallCount: Record<string, number> = {};

  private spills = 0;
  private spilledBytes = 0;
  private prunes = 0;
  private compactions = 0;
  private compactionFailures = 0;

  private sandboxDenied = 0;
  private approvalRequested = 0;
  private approvalGranted = 0;
  private approvalDenied = 0;

  // Agent 维度
  recordAgentRun(durationMs: number, success: boolean): void {
    this.agentRuns++;
    this.agentDurationMs += Math.max(0, durationMs);
    if (success) {
      this.agentSuccess++;
    } else {
      this.agentFailures++;
    }
  }

  // Model 维度
  recordModelCall(
    latencyMs: number,
    success: boolean,
    inputTokens = 0,
    outputTokens = 0
  ): void {
    this.modelCalls++;
    this.modelLatencyMs += Math.max(0, latencyMs);
    this.inputTokens += Math.max(0, inputTokens);
    this.outputTokens += Math.max(0, outputTokens);
    if (!success) {
      this.modelFailures++;
    }
  }

  // Tool 维度
  recordToolCall(toolName: string, latencyMs: number, success: boolean): void {
    this.toolCalls++;
    this.toolLatencyMs += Math.max(0, latencyMs);
    this.perToolCallCount[toolName] = (this.perToolCallCount[toolName] ?? 0) + 1;
    if (!success) {
      this.toolFailures++;
    }
  }

  // Context 维度
  recordSpill(bytes: number): void {
    this.spills++;
    this.spilledBytes += Math.max(0, bytes);
  }

  recordPrune(): void {
    this.prunes++;
  }

  recordCompaction(success: boolean): void {
    this.compactions++;
    if (!success) {
      this.compactionFailures++;
    }
  }

  // Sandbox / Approval 维度
  recordSandboxDenied(): void {
    this.sandboxDenied++;
  }

  recordApproval(action: "requested" | "granted" | "denied"): void {
    if (action === "requested") {
      this.approvalRequested++;
    } else if (action === "granted") {
      this.approvalGranted++;
    } else if (action === "denied") {
      this.approvalDenied++;
    }
  }

  /**
   * 获取当前指标快照
   */
  getSnapshot(): MetricsSnapshot {
    return {
      agentRuns: this.agentRuns,
      agentSuccess: this.agentSuccess,
      agentFailures: this.agentFailures,
      agentDurationMs: this.agentDurationMs,
      modelCalls: this.modelCalls,
      modelFailures: this.modelFailures,
      modelLatencyMs: this.modelLatencyMs,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      toolLatencyMs: this.toolLatencyMs,
      perToolCallCount: { ...this.perToolCallCount },
      spills: this.spills,
      spilledBytes: this.spilledBytes,
      prunes: this.prunes,
      compactions: this.compactions,
      compactionFailures: this.compactionFailures,
      sandboxDenied: this.sandboxDenied,
      approvalRequested: this.approvalRequested,
      approvalGranted: this.approvalGranted,
      approvalDenied: this.approvalDenied,
    };
  }

  /**
   * 格式化输出 CLI Run Stats
   */
  formatSummary(): string {
    const lines: string[] = [
      "\x1b[1m\x1b[35m[Run Stats]\x1b[0m",
      "",
      `Duration: ${formatDuration(this.agentDurationMs)}`,
      `Model calls: ${this.modelCalls}`,
      `Tool calls: ${this.toolCalls}`,
      `Input tokens: ${formatNumber(this.inputTokens)}`,
      `Output tokens: ${formatNumber(this.outputTokens)}`,
    ];

    if (this.compactions > 0) {
      lines.push(`Compactions: ${this.compactions}`);
    }
    if (this.spilledBytes > 0) {
      lines.push(`Spilled: ${formatBytes(this.spilledBytes)}`);
    }

    return lines.join("\n");
  }

  /**
   * 重置所有统计指标
   */
  reset(): void {
    this.agentRuns = 0;
    this.agentSuccess = 0;
    this.agentFailures = 0;
    this.agentDurationMs = 0;
    this.modelCalls = 0;
    this.modelFailures = 0;
    this.modelLatencyMs = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.toolCalls = 0;
    this.toolFailures = 0;
    this.toolLatencyMs = 0;
    for (const key of Object.keys(this.perToolCallCount)) {
      delete this.perToolCallCount[key];
    }
    this.spills = 0;
    this.spilledBytes = 0;
    this.prunes = 0;
    this.compactions = 0;
    this.compactionFailures = 0;
    this.sandboxDenied = 0;
    this.approvalRequested = 0;
    this.approvalGranted = 0;
    this.approvalDenied = 0;
  }
}
