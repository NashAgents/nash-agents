/**
 * F7: Security-LLM 审查在多节点并发下的韧性、Fail-Closed 语义与审批过期收敛。
 *
 * 全部使用本地 http 服务器与内存存储，绝不调用真实模型或真实集群。
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { registerFixtureNodes } from "./helpers/registered-node.js";
import { PreToolSecurityMonitor, ReviewLimiter, SecurityEvaluator, type SecurityContext } from "../src/security/index.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import type { ClusterTaskRecord } from "../src/cluster/storage/cluster-store-types.js";
import { TaskSupervisor } from "../src/cluster/coordinator/task-supervisor.js";
import type { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { EventBus } from "../src/observability/event-bus.js";
import { RemoteApprovalProvider } from "../src/cluster/worker/remote-approval-provider.js";
import { applyWorkerApprovalExpiry } from "../src/cluster/coordinator/approval-expiry.js";
import type { RemoteApprovalExpiredPayload } from "../src/cluster/protocol/types.js";

const ONLINE = { getConnection: () => ({ generation: 1 }) } as unknown as NodeRegistry;
const OFFLINE = { getConnection: () => undefined } as unknown as NodeRegistry;

/** 需要真实模型审查（不满足确定性 Fast Path）的高危工具上下文。 */
function reviewContext(command = "ls -la /tmp"): SecurityContext {
  const rawArgs = JSON.stringify({ command });
  return {
    toolName: "bash",
    toolArgs: { command },
    rawArgs,
    argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
    agentIdentity: { agentId: "main", nodeType: "worker" },
    userAuthorizationContext: { userIntent: "巡检临时目录" },
  };
}

function decisionBody(verdict: string, severity = 0): string {
  return JSON.stringify({
    id: "review-response",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: `<verdict>${verdict}</verdict><severity>${severity}</severity><category>Routine Operation</category><reason>model decision</reason>`,
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

function reviewServer(t: TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse, attempt: number) => void) {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    attempts++;
    handler(req, res, attempts);
  });
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return {
    server,
    get attempts() { return attempts; },
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      return `http://127.0.0.1:${port}/v1`;
    },
  };
}

async function seededStore(...tasks: ClusterTaskRecord[]): Promise<InMemoryClusterStore> {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  for (const task of tasks) await store.saveTask(task);
  return store;
}

const baseTask = (overrides: Partial<ClusterTaskRecord> = {}): ClusterTaskRecord => ({
  taskId: `f7-${Math.random().toString(16).slice(2, 10)}`,
  runId: "run-f7",
  nodeId: "worker",
  projectId: "project-f7",
  goal: "goal",
  status: "waiting_approval",
  dispatchAttempt: 1,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now(),
  ...overrides,
});

test("429 后重试成功：最终裁决来自模型而不是本地降级", async (t) => {
  const srv = reviewServer(t, (_req, res, attempt) => {
    if (attempt === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(decisionBody("ALLOW"));
  });
  const baseUrl = await srv.listen();
  const monitor = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 2000, totalTimeoutMs: 8000,
  });

  const decision = await monitor.evaluateToolCall(reviewContext());

  assert.equal(srv.attempts, 2, "429 必须被重试一次");
  assert.equal(decision.verdict, "ALLOW");
  assert.equal(decision.decisionSource, "LLM_MONITOR");
  assert.equal(decision.reviewUnavailable, undefined);
});

test("连续 5xx 后高风险工具仍然 Fail-Closed 为 REQUIRE_APPROVAL，绝不降级为放行", async (t) => {
  const srv = reviewServer(t, (_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream exploded" }));
  });
  const baseUrl = await srv.listen();
  const monitor = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 2000, totalTimeoutMs: 8000,
  });

  const decision = await monitor.evaluateToolCall(reviewContext("rm -rf build"));

  assert.equal(srv.attempts, 3, "最多 1 次首发 + 2 次重试");
  assert.equal(decision.verdict, "REQUIRE_APPROVAL");
  assert.equal(decision.reviewUnavailable, true);
  assert.equal(decision.decisionSource, "SYSTEM_FAILURE", "降级结论不得被审计记录为 LLM_MONITOR");
});

test("网络错误同样有界重试并保持 Fail-Closed，不形成重试风暴", async (t) => {
  const srv = reviewServer(t, (req) => {
    req.socket.destroy();
  });
  const baseUrl = await srv.listen();
  const monitor = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 2000, totalTimeoutMs: 8000,
  });

  const decision = await monitor.evaluateToolCall(reviewContext());

  assert.equal(srv.attempts, 3, "网络错误只允许有界重试，不得无限重投");
  assert.equal(decision.verdict, "REQUIRE_APPROVAL");
  assert.equal(decision.reviewUnavailable, true);
  assert.equal(decision.decisionSource, "SYSTEM_FAILURE");
});

test("调用方中止立即生效：不重试、不返回任何本地放行结论", async (t) => {
  let release: (() => void) | undefined;
  const srv = reviewServer(t, (_req, res) => {
    // 保持响应悬挂，直到测试主动中止。
    release = () => { try { res.destroy(); } catch {} };
  });
  const baseUrl = await srv.listen();
  const monitor = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 5000, totalTimeoutMs: 10000,
  });

  const controller = new AbortController();
  const started = Date.now();
  const pending = monitor.evaluateToolCall(reviewContext(), controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort(new DOMException("caller aborted", "AbortError"));

  await assert.rejects(pending, (error: unknown) => (error as Error)?.name === "AbortError");
  assert.ok(Date.now() - started < 4000, "中止必须立即返回，而不是等到总预算耗尽");
  assert.equal(srv.attempts, 1, "中止后绝不允许再次发起请求");
  release?.();
});

test("共享并发限流器把在途安全审查收敛到上限，排队期间仍响应取消", async (t) => {
  let active = 0;
  let peak = 0;
  const srv = reviewServer(t, (_req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(decisionBody("ALLOW"));
    }, 40);
  });
  const baseUrl = await srv.listen();

  const limiter = new ReviewLimiter(2);
  const monitorA = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 5000, totalTimeoutMs: 15000, reviewLimiter: limiter,
  });
  const monitorB = new PreToolSecurityMonitor({
    enabled: true, cacheEnabled: false, baseUrl, apiKey: "sk-test-f7", model: "test-reviewer",
    format: "completions", timeoutMs: 5000, totalTimeoutMs: 15000, reviewLimiter: limiter,
  });

  const contexts = Array.from({ length: 6 }, (_v, i) => reviewContext(`ls -la /tmp/f7-${i}`));
  const decisions = await Promise.all([
    ...contexts.slice(0, 3).map((ctx) => monitorA.evaluateToolCall(ctx)),
    ...contexts.slice(3).map((ctx) => monitorB.evaluateToolCall(ctx)),
  ]);

  assert.equal(srv.attempts, 6);
  assert.ok(peak <= 2, `在途安全审查峰值 ${peak} 不得超过配置上限 2`);
  assert.deepEqual(decisions.map((d) => d.verdict), ["ALLOW", "ALLOW", "ALLOW", "ALLOW", "ALLOW", "ALLOW"]);

  // 排队中的调用必须能在自己的信号中止时立刻出队，且不占用槽位。
  const queueLimiter = new ReviewLimiter(1);
  let releaseBlocker: (() => void) | undefined;
  const blocker = queueLimiter.run(undefined, () => new Promise<void>((resolve) => { releaseBlocker = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const queuedController = new AbortController();
  const queued = queueLimiter.run(queuedController.signal, async () => "never");
  assert.equal(queueLimiter.queued, 1);
  queuedController.abort(new DOMException("queued aborted", "AbortError"));
  await assert.rejects(queued, (error: unknown) => (error as Error)?.name === "AbortError");
  assert.equal(queueLimiter.queued, 0, "中止的排队调用必须出队");
  releaseBlocker?.();
  await blocker;
  assert.equal(queueLimiter.inFlight, 0);
});

test("审批等待超时会显式通知 Coordinator，且持久化记录不再 pending", async (t) => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const taskId = "task-approval-timeout";
  const runId = "run-approval-timeout";
  const task = baseTask({ taskId, runId });
  await store.saveTask(task);
  const approvalId = "appr-f7-timeout";
  const now = Date.now();
  await store.saveApproval({
    approvalId, taskId, runId, nodeId: "worker", agentId: "main",
    capability: "network", reason: "需要联网", status: "pending", requestedAt: now, expiresAt: now + 600000,
  });

  const sent: Array<{ type: string; payload: any }> = [];
  const provider = new RemoteApprovalProvider(
    taskId, runId, "worker", "coordinator",
    1000, // 生产下限内的最短审批等待上限，便于快速验证超时通知
  );
  provider.setWebSocket({
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  } as never);
  t.after(() => provider.cancelPending());

  const decision = await provider.askApproval({ id: approvalId, capability: "network", reason: "需要联网" });
  assert.equal(decision, "deny", "审批超时必须 Fail-Closed");

  const expiredMessage = sent.find((message) => message.type === "approval.expired");
  assert.ok(expiredMessage, "Worker 必须主动通知 Coordinator 审批已超时");
  assert.equal(expiredMessage!.payload.approvalId, approvalId);
  assert.equal(expiredMessage!.payload.reason, "worker-timeout");
  assert.equal(expiredMessage!.payload.decision, "deny");

  assert.equal((await store.getApproval(approvalId))?.status, "pending", "通知前记录仍是 pending");

  const result = await applyWorkerApprovalExpiry(store, expiredMessage!.payload as RemoteApprovalExpiredPayload);
  assert.equal(result?.resumed, true);
  const resolved = await store.getApproval(approvalId);
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.decision, "deny");
  assert.equal(resolved?.resolvedBy, "worker-timeout");
  assert.equal((await store.listPendingApprovals()).some((a) => a.approvalId === approvalId), false);
  assert.equal((await store.getTask(task.taskId))?.status, "running", "Worker 仍在执行，任务回到 running");
});

test("Coordinator 过期扫描把悬挂的 waiting_approval 任务收敛为 failed 并推送事件", async (t) => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const taskId = "task-expired-approval";
  const runId = "run-expired";
  const task = baseTask({ taskId, runId });
  await store.saveTask(task);
  const approvalId = "appr-f7-expired";
  await store.saveApproval({
    approvalId, taskId, runId, nodeId: "worker", agentId: "main",
    capability: "network", reason: "需要联网", status: "pending",
    requestedAt: Date.now() - 600000, expiresAt: Date.now() - 1000,
  });

  const bus = new EventBus();
  const events: Array<{ type: string; data: any }> = [];
  t.after(bus.subscribe("*", (event) => { events.push({ type: event.type, data: event.data }); }));

  const supervisor = new TaskSupervisor(store, ONLINE, 1000, { sendControl: async () => ({ success: true }) } as never, bus);
  await supervisor.superviseTasks();

  const stored = await store.getTask(task.taskId);
  assert.equal(stored?.status, "failed");
  assert.match(String(stored?.error), /expired/i);
  assert.match(String(stored?.error), /approval-timeout/);

  const approval = await store.getApproval(approvalId);
  assert.equal(approval?.status, "resolved");
  assert.equal(approval?.decision, "deny");
  assert.equal((await store.listPendingApprovals()).length, 0);

  assert.ok(events.some((event) => event.type === "task.failed" && event.data.taskId === task.taskId), "必须推送 task.failed");
  assert.ok(events.some((event) => event.type === "approval.resolved" && event.data.approvalId === approvalId), "必须推送 approval.resolved");
});

test("等待审批期间 Worker 连接消失：任务收敛为 outcome_unknown，绝不永久跳过", async (t) => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const task = baseTask({ taskId: "task-approval-offline", runId: "run-offline" });
  await store.saveTask(task);

  const bus = new EventBus();
  const events: Array<{ type: string; data: any }> = [];
  t.after(bus.subscribe("*", (event) => { events.push({ type: event.type, data: event.data }); }));

  const supervisor = new TaskSupervisor(store, OFFLINE, 1000, { sendControl: async () => ({ success: true }) } as never, bus);
  await supervisor.superviseTasks();

  const stored = await store.getTask(task.taskId);
  assert.equal(stored?.status, "outcome_unknown");
  assert.match(String(stored?.error), /disconnected while awaiting approval/i);
  assert.ok(events.some((event) => event.type === "task.outcome_unknown" && event.data.taskId === task.taskId));
});

test("Worker 在线且审批未过期时，waiting_approval 依然不消耗任何执行预算", async (t) => {
  const store = new InMemoryClusterStore();
  await registerFixtureNodes(store, "worker");
  const taskId = "task-approval-waiting";
  const runId = "run-waiting";
  const task = baseTask({ taskId, runId, createdAt: Date.now() - 86_400_000 });
  await store.saveTask(task);
  await store.saveApproval({
    approvalId: "appr-f7-still-pending", taskId, runId, nodeId: "worker", agentId: "main",
    capability: "network", reason: "需要联网", status: "pending",
    requestedAt: Date.now(), expiresAt: Date.now() + 300000,
  });

  const cancels: string[] = [];
  const supervisor = new TaskSupervisor(store, ONLINE, 1000, {
    sendControl: async (taskId: string) => { cancels.push(taskId); return { success: true }; },
  } as never);
  await supervisor.superviseTasks();

  assert.deepEqual(cancels, []);
  assert.equal((await store.getTask(task.taskId))?.status, "waiting_approval");
  assert.equal((await store.getApproval("appr-f7-still-pending"))?.status, "pending");
});
