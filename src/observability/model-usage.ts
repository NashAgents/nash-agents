import { randomUUID, createHash } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../model/chat-completions-client.js";
import { ConservativeTokenEstimator } from "../context/token-meter.js";
import type { TraceContextPayload } from "./trace-context.js";
import { defaultTraceContext } from "./trace-context.js";

export type RequestPurpose = "agent" | "planner" | "replanner" | "goal_review" | "security" | "compaction" | "title" | "prompt_optimizer" | "unspecified";
export interface ModelUsageRecord {
  accountingId: string;
  traceId?: string; spanId: string; parentSpanId?: string;
  conversationId?: string; graphId?: string; graphRevision?: number;
  taskId?: string; agentId?: string; nodeId?: string; runId?: string; executionAttempt?: number;
  provider: string; providerResolution?: "endpoint_hostname"; providerModel?: string; httpStatus?: number; model: string; modelRequestId?: string; purpose: RequestPurpose;
  startedAt: number; endedAt?: number; durationMs?: number; ttftMs?: number;
  status: "started" | "completed" | "failed" | "cancelled" | "timed_out";
  errorType?: string; retryCount: number;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null; reasoningTokens: number | null;
  usageSource: "PROVIDER_REPORTED" | "UNAVAILABLE";
  usageCompleteness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  context: { source: "LOCALLY_ESTIMATED"; method: string; estimatedTokens: Record<string, number>; requestSha256: string; bytes: number };
}
export type ModelUsageSink = (record: ModelUsageRecord) => void | Promise<void>;
export interface ModelCallOptions { signal?: AbortSignal; purpose?: RequestPurpose; usageSink?: ModelUsageSink; retryCount?: number; context?: Partial<TraceContextPayload>; headers?: Record<string, string>; timeoutMs?: number }

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeProviderUsage(usage: ChatCompletionResponse["usage"], completed: boolean) {
  const inputTokens = count(usage?.prompt_tokens);
  const outputTokens = count(usage?.completion_tokens);
  const totalTokens = count(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  return { inputTokens, outputTokens, totalTokens,
    cacheReadTokens: count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.cached_tokens),
    cacheWriteTokens: count(usage?.prompt_tokens_details?.cache_write_tokens),
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens),
    usageSource: usage ? "PROVIDER_REPORTED" as const : "UNAVAILABLE" as const,
    usageCompleteness: !usage ? "UNAVAILABLE" as const : completed && inputTokens !== null && outputTokens !== null ? "COMPLETE" as const : "PARTIAL" as const,
  };
}

/** Counts and digests only. Prompt text, tool arguments, URLs and credentials never enter the ledger. */
export function attributeContext(request: ChatCompletionRequest): ModelUsageRecord["context"] {
  const estimator = new ConservativeTokenEstimator();
  const estimatedTokens: Record<string, number> = {
    // 基础角色大类（向后兼容）
    system: 0,
    user: 0,
    conversation: 0,
    tool_results: 0,
    tool_schemas: 0,
    protocol: 3,
    // 细分子维度归因（深度可观测性）
    system_prompt: 0,
    developer_instructions: 0,
    user_goal: 0,
    task_context: 0,
    artifact_content: 0,
    artifact_metadata: 0,
    federated_memory: 0,
    retrieved_knowledge: 0,
    planning_context: 0,
    replanning_context: 0,
    conversation_history: 0,
    security_context: 0,
  };

  for (const message of request.messages) {
    const tokens = estimator.estimateMessages([message]) - 3;
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content || "");
    const role = message.role;

    if (role === "system") {
      estimatedTokens.system = (estimatedTokens.system ?? 0) + tokens;
      if (text.includes("Repository Instructions") || text.includes("AGENTS.md") || text.includes("CLAUDE.md")) {
        estimatedTokens.developer_instructions = (estimatedTokens.developer_instructions ?? 0) + tokens;
      } else if (text.includes("Federated Memory") || text.includes("Recalled Memory") || text.includes("Persistent Knowledge")) {
        estimatedTokens.federated_memory = (estimatedTokens.federated_memory ?? 0) + tokens;
      } else if (text.includes("Security Policy") || text.includes("Pre-Tool Security Monitor")) {
        estimatedTokens.security_context = (estimatedTokens.security_context ?? 0) + tokens;
      } else {
        estimatedTokens.system_prompt = (estimatedTokens.system_prompt ?? 0) + tokens;
      }
    } else if (role === "tool") {
      estimatedTokens.tool_results = (estimatedTokens.tool_results ?? 0) + tokens;
      if (text.includes("Artifact") || text.includes("read_graph_artifact") || text.includes("publish_artifact")) {
        estimatedTokens.artifact_content = (estimatedTokens.artifact_content ?? 0) + tokens;
      }
    } else if (role === "user") {
      estimatedTokens.user = (estimatedTokens.user ?? 0) + tokens;
      if (text.includes("[Task:") || text.includes("Graph:") || text.includes("Acceptance Criteria:")) {
        estimatedTokens.task_context = (estimatedTokens.task_context ?? 0) + tokens;
      } else if (text.includes("Goal:") || text.includes("goal")) {
        estimatedTokens.user_goal = (estimatedTokens.user_goal ?? 0) + tokens;
      } else {
        estimatedTokens.conversation_history = (estimatedTokens.conversation_history ?? 0) + tokens;
      }
    } else {
      estimatedTokens.conversation = (estimatedTokens.conversation ?? 0) + tokens;
      if (text.includes("Replan") || text.includes("replan")) {
        estimatedTokens.replanning_context = (estimatedTokens.replanning_context ?? 0) + tokens;
      } else {
        estimatedTokens.conversation_history = (estimatedTokens.conversation_history ?? 0) + tokens;
      }
    }
  }

  estimatedTokens.tool_schemas = request.tools?.length ? estimator.estimateText(JSON.stringify(request.tools)) : 0;
  const raw = JSON.stringify(request);
  return {
    source: "LOCALLY_ESTIMATED",
    method: "ConservativeTokenEstimator:cjk/1.5,other/3.8; 14 granular categories derived from message provenance and content semantics; exact ledger separated from provider token counts",
    estimatedTokens,
    requestSha256: createHash("sha256").update(raw).digest("hex"),
    bytes: Buffer.byteLength(raw),
  };
}

export class ModelRequestObservation {
  readonly record: ModelUsageRecord;
  private readonly monotonicStart = performance.now();
  private finished = false;
  private readonly sink?: ModelUsageSink;
  private usage?: ChatCompletionResponse["usage"];
  constructor(baseUrl: string, request: ChatCompletionRequest, private readonly options?: ModelCallOptions) {
    const context = { ...defaultTraceContext.get(), ...options?.context };
    this.sink = options?.usageSink ?? context?.modelUsageSink;
    let provider = "unknown";
    try { provider = new URL(baseUrl).hostname; } catch { /* Do not persist an invalid URL containing credentials. */ }
    this.record = { accountingId: randomUUID(), traceId: context?.traceId, spanId: randomUUID(), parentSpanId: context?.spanId,
      conversationId: context?.conversationId, graphId: context?.graphId, graphRevision: context?.graphRevision,
      taskId: context?.taskId, agentId: context?.agentId, nodeId: context?.nodeId, runId: context?.runId, executionAttempt: context?.executionAttempt,
      provider, providerResolution: "endpoint_hostname", model: request.model, purpose: options?.purpose ?? context?.modelPurpose ?? "unspecified", startedAt: Date.now(), status: "started",
      retryCount: options?.retryCount ?? 0, ...normalizeProviderUsage(undefined, false), context: attributeContext(request) };
  }
  async started(): Promise<void> { await this.publish(); }
  responseHeaders(response: Response): void { this.record.httpStatus = response.status; this.record.modelRequestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined; }
  chunk(chunk: { model?: string; id?: string; choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] } }>; usage?: ChatCompletionResponse["usage"] }): void {
    if (chunk.model) this.record.providerModel = chunk.model;
    if (chunk.id) this.record.modelRequestId = chunk.id;
    // Streaming usage is a cumulative snapshot, never a delta to add again.
    if (chunk.usage) this.usage = chunk.usage;
    if (this.record.ttftMs === undefined && chunk.choices?.some((choice) => choice.delta?.content || choice.delta?.reasoning_content || choice.delta?.tool_calls?.length)) this.record.ttftMs = performance.now() - this.monotonicStart;
  }
  async finish(status: ModelUsageRecord["status"], error?: unknown): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (error) this.record.errorType = error instanceof Error ? error.name : "UnknownError";
    if (this.options?.signal?.aborted) status = /(?:TimeoutError|Timeout)$/.test(this.options.signal.reason?.name ?? "") ? "timed_out" : "cancelled";
    Object.assign(this.record, normalizeProviderUsage(this.usage, status === "completed"), { status, endedAt: Date.now(), durationMs: Math.max(0, performance.now() - this.monotonicStart) });
    await this.publish();
  }
  private async publish(): Promise<void> {
    try { await this.sink?.(structuredClone(this.record)); } catch { /* Telemetry failure cannot bypass or change execution policy. */ }
  }
}

/** One request identity per HTTP attempt; provider IDs are descriptive and may be reused by gateways. */
export function aggregateModelUsage(records: ModelUsageRecord[]) {
  const unique = new Map<string, ModelUsageRecord>();
  for (const record of records) {
    const old = unique.get(record.accountingId);
    if (!old || old.status === "started") unique.set(record.accountingId, record);
  }
  const requests = [...unique.values()];
  const known = (key: "inputTokens" | "outputTokens" | "totalTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens") => {
    const values = requests.map((record) => record[key]).filter((value): value is number => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const fingerprints = new Map<string, number>();
  for (const request of requests) {
    const key = `${request.taskId ?? request.conversationId}/${request.agentId}/${request.graphRevision}/${request.context.requestSha256}`;
    fingerprints.set(key, (fingerprints.get(key) ?? 0) + 1);
  }
  return { repeatedIdenticalContexts: [...fingerprints.values()].reduce((sum,count) => sum + Math.max(0,count-1),0), requests, modelCalls: requests.length, inputTokens: known("inputTokens"), outputTokens: known("outputTokens"), totalTokens: known("totalTokens"),
    cacheReadTokens: known("cacheReadTokens"), cacheWriteTokens: known("cacheWriteTokens"), reasoningTokens: known("reasoningTokens"),
    incompleteRequests: requests.filter((record) => record.usageCompleteness !== "COMPLETE").length,
    completeness: requests.length && requests.every((record) => record.usageCompleteness === "COMPLETE") ? "COMPLETE" : requests.length ? "PARTIAL" : "NO_DATA",
    tokenSemantics: "cache and reasoning tokens are provider subsets; never added to input/output totals; costs unavailable without trusted pricing" };
}
