import { test } from "node:test";
import assert from "node:assert/strict";
import type { SequencedEvent } from "../src/cluster/protocol/types.js";
import { classifyToolAttempts } from "../src/cluster/graph/failure-recovery.js";

/**
 * FINDING-2 回归：一次 Tool Attempt 失败不等于 Agent Task 失败。
 * 真实 E2E 里 node3 第一次命令用了 PowerShell 语法而失败，改对命令后成功并产出可验证产物，
 * 但整个节点仍被判 failed —— 这里固定住新的确定性判定规则。
 */

interface Builder {
  events: SequencedEvent[];
  event: (eventType: string, data: Record<string, unknown>) => SequencedEvent;
  attempt: (id: string, options: { success: boolean; toolName?: string; error?: string; output?: string; exitCode?: number; interrupted?: boolean; mutates?: string }) => SequencedEvent;
}

function builder(taskCompleted = true): Builder {
  const events: SequencedEvent[] = [];
  const event = (eventType: string, data: Record<string, unknown>) => {
    const created = { seq: events.length + 1, taskId: "task-x", runId: "run-x", nodeId: "node-x", timestamp: 100, eventType, data } as unknown as SequencedEvent;
    events.push(created);
    return created;
  };
  const attempt: Builder["attempt"] = (id, options) => {
    event("tool.started", { toolCallId: id, toolName: options.toolName ?? "bash", rawArgs: "{}" });
    if (typeof options.exitCode === "number") {
      event(options.exitCode === 0 ? "job.completed" : "job.failed", { toolCallId: id, command: "cmd", exitCode: options.exitCode });
    }
    // 真实的写副作用发生在调用执行期间，即 tool.started 与 tool.result 之间。
    if (options.mutates) event("file.modified", { relativePath: options.mutates, afterSha256: "b".repeat(64) });
    return event("tool.result", {
      source: "ToolExecutor",
      toolCallId: id,
      toolName: options.toolName ?? "bash",
      success: options.success,
      exitCode: options.exitCode,
      error: options.error,
      output: options.output,
      interrupted: options.interrupted,
    });
  };
  if (taskCompleted) event("task.completed", {});
  return { events, event, attempt };
}

test("瞬时失败 + 后续成功重试 + 无工作区副作用 → 判为已恢复，不否决任务", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, exitCode: 1, error: "syntax error near unexpected token" });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0]!.classification, "recovered_inert_attempt");
  assert.equal(result.recovered[0]!.failedToolCallId, "call-1");
  assert.equal(result.recovered[0]!.recoveredByToolCallId, "call-2");
});

test("失败尝试改动了工作区 → 不可豁免", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, exitCode: 1, mutates: "a.txt" });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.unresolved[0]!.classification, "workspace_mutated");
});

test("确定性安全硬拦截永远不可被后续成功覆盖", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, error: "SecurityBlockError: 破坏性删除根目录", output: "[Security Monitor: BLOCK] 操作被安全审查拦截" });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.unresolved[0]!.classification, "security_blocked");
});

test("审批拒绝不可被模型自我修复覆盖", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, error: "ApprovalDeniedError: 用户未批准执行该高风险操作", output: "[Security Monitor: REQUIRE_APPROVAL] 用户未批准" });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.unresolved[0]!.classification, "security_blocked");
});

test("中断的尝试不可豁免（结果未知）", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, interrupted: true });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.unresolved[0]!.classification, "interrupted");
});

test("失败后没有任何成功重试 → 不可豁免", () => {
  const b = builder();
  const failed = b.attempt("call-1", { success: false, exitCode: 1 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.unresolved[0]!.classification, "no_successful_retry");
});

test("任务没有成功收尾时，任何豁免都不成立", () => {
  const b = builder(false); // 没有 task.completed
  const failed = b.attempt("call-1", { success: false, exitCode: 1 });
  b.attempt("call-2", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [failed]);
  assert.equal(result.recovered.length, 0);
  assert.equal(result.unresolved[0]!.classification, "no_successful_retry");
});

test("多次失败混合时逐项分类，历史事实完整保留", () => {
  const b = builder();
  const first = b.attempt("call-1", { success: false, exitCode: 1 });      // 可恢复
  const second = b.attempt("call-2", { success: false, error: "SecurityBlockError: 越权访问", output: "[Security Monitor: BLOCK]" }); // 不可恢复
  b.attempt("call-3", { success: true, exitCode: 0 });
  const result = classifyToolAttempts(b.events, [first, second]);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.attempts, 3);
  assert.equal(result.failedAttempts, 2);
  assert.equal(result.unresolved[0]!.failedToolCallId, "call-2");
});
