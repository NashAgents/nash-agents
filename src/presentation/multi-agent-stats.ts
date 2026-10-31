/**
 * 单个 Agent 的执行指标统计
 */
export interface SingleAgentMetrics {
  agentId: string;
  name: string;
  role?: string;
  modelCalls: number;
  modelFailures: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  tokensAvailable: boolean;
  durationMs: number;
  status: string;
}

/**
 * 全局多 Agent 聚合统计结果
 */
export interface AggregatedRunStats {
  totalAgents: number;
  runningAgents: number;
  completedAgents: number;
  failedAgents: number;
  totalModelCalls: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensAvailable: boolean;
  wallClockDurationMs: number;
  perAgentStats: SingleAgentMetrics[];
}

/**
 * MultiAgentMetricsCollector - 跟踪与聚合所有并发/串行 Agent 的资源消耗与壁钟时间
 */
export class MultiAgentMetricsCollector {
  private readonly agentMetrics = new Map<string, SingleAgentMetrics>();
  private runStartTime = Date.now();

  startRun(): void {
    this.runStartTime = Date.now();
    this.agentMetrics.clear();
  }

  ensureAgent(agentId: string, name?: string, role?: string): SingleAgentMetrics {
    let metrics = this.agentMetrics.get(agentId);
    if (!metrics) {
      metrics = {
        agentId,
        name: name ?? agentId,
        role,
        modelCalls: 0,
        modelFailures: 0,
        toolCalls: 0,
        toolFailures: 0,
        inputTokens: 0,
        outputTokens: 0,
        tokensAvailable: false,
        durationMs: 0,
        status: "running",
      };
      this.agentMetrics.set(agentId, metrics);
    }
    return metrics;
  }

  recordModelCall(
    agentId: string,
    inputTokens: number,
    outputTokens: number,
    latencyMs: number,
    success: boolean,
    hasUsage = true
  ): void {
    const metrics = this.ensureAgent(agentId);
    metrics.modelCalls++;
    if (!success) metrics.modelFailures++;

    if (hasUsage && (inputTokens > 0 || outputTokens > 0)) {
      metrics.inputTokens += inputTokens;
      metrics.outputTokens += outputTokens;
      metrics.tokensAvailable = true;
    }
    metrics.durationMs += latencyMs;
  }

  recordToolCall(
    agentId: string,
    toolName: string,
    latencyMs: number,
    success: boolean
  ): void {
    const metrics = this.ensureAgent(agentId);
    metrics.toolCalls++;
    if (!success) metrics.toolFailures++;
  }

  updateAgentStatus(agentId: string, status: string, durationMs?: number): void {
    const metrics = this.ensureAgent(agentId);
    metrics.status = status;
    if (durationMs !== undefined) {
      metrics.durationMs = durationMs;
    }
  }

  getPerAgentStats(): SingleAgentMetrics[] {
    return Array.from(this.agentMetrics.values()).map((m) => ({ ...m }));
  }

  getAggregatedStats(wallClockMs?: number): AggregatedRunStats {
    const wallClockDurationMs = wallClockMs ?? Math.max(0, Date.now() - this.runStartTime);
    const perAgent = this.getPerAgentStats();

    let totalModelCalls = 0;
    let totalToolCalls = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let tokensAvailable = false;
    let runningAgents = 0;
    let completedAgents = 0;
    let failedAgents = 0;

    for (const m of perAgent) {
      totalModelCalls += m.modelCalls;
      totalToolCalls += m.toolCalls;
      totalInputTokens += m.inputTokens;
      totalOutputTokens += m.outputTokens;
      if (m.tokensAvailable) tokensAvailable = true;
      if (m.status === "running") runningAgents++;
      else if (m.status === "completed") completedAgents++;
      else if (m.status === "failed" || m.status === "interrupted") failedAgents++;
    }

    return {
      totalAgents: Math.max(1, perAgent.length),
      runningAgents,
      completedAgents,
      failedAgents,
      totalModelCalls,
      totalToolCalls,
      totalInputTokens,
      totalOutputTokens,
      tokensAvailable,
      wallClockDurationMs,
      perAgentStats: perAgent,
    };
  }

  /**
   * 格式化输出产品级简洁的 Run Summary
   */
  formatSummary(wallClockMs?: number): string {
    const stats = this.getAggregatedStats(wallClockMs);
    const lines: string[] = [];

    const durationSec = Math.floor(stats.wallClockDurationMs / 1000);
    const agentLabel = stats.totalAgents === 1 ? "1 agent" : `${stats.totalAgents} agents`;
    const toolLabel = `${stats.totalToolCalls} tools`;
    const timeLabel = `${durationSec}s`;

    lines.push("\x1b[1mRun summary\x1b[0m");
    lines.push(`  ${agentLabel} · ${toolLabel} · ${timeLabel}`);

    let tokenPart = "tokens unavailable";
    if (stats.tokensAvailable) {
      const inStr = stats.totalInputTokens >= 1000
        ? `${(stats.totalInputTokens / 1000).toFixed(1)}k in`
        : `${stats.totalInputTokens} in`;
      const outStr = stats.totalOutputTokens >= 1000
        ? `${(stats.totalOutputTokens / 1000).toFixed(1)}k out`
        : `${stats.totalOutputTokens} out`;
      tokenPart = `${inStr} · ${outStr}`;
    }

    const modelLabel = `${stats.totalModelCalls} model calls`;
    lines.push(`  ${modelLabel} · ${tokenPart}`);

    return lines.join("\n");
  }

  /**
   * 格式化输出详细的各 Agent 细项（用于 /stats 或 /agent 诊断）
   */
  formatDetailedStats(wallClockMs?: number): string {
    const stats = this.getAggregatedStats(wallClockMs);
    const lines: string[] = [];

    lines.push(this.formatSummary(wallClockMs));
    lines.push("");

    if (stats.perAgentStats.length > 0) {
      lines.push("\x1b[1mPer-Agent Breakdown\x1b[0m");
      for (const m of stats.perAgentStats) {
        const roleStr = m.role ? ` <${m.role}>` : "";
        const tokenStr = m.tokensAvailable
          ? `${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out`
          : "unavailable";
        lines.push(`  • ${m.name}${roleStr} (${m.status})`);
        lines.push(`      Calls: ${m.modelCalls} model / ${m.toolCalls} tool`);
        lines.push(`      Tokens: ${tokenStr}`);
      }
    }

    return lines.join("\n");
  }
}

/**
 * 格式化耗时为人类友好的简洁字符串 (如 12s, 1m 24s, 24m 19s, 1h 5m 20s)
 */
export function formatDurationHuman(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours}h ${remainingMins}m ${secs}s`;
}

/**
 * 格式化 Token 数量为人类友好的紧凑字符串 (如 128 tokens, 25.1k tokens, 1.2M tokens)
 */
export function formatTokensHuman(tokens: number): string {
  const count = Math.max(0, Math.round(tokens));
  if (count < 1000) {
    return `${count} tokens`;
  }
  if (count < 1000000) {
    const k = (count / 1000).toFixed(1).replace(/\.0$/, "");
    return `${k}k tokens`;
  }
  const m = (count / 1000000).toFixed(1).replace(/\.0$/, "");
  return `${m}M tokens`;
}

