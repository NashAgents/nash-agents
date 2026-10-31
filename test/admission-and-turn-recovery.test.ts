/**
 * #17 + #21 交互验收：
 * 1. 客户端断连后前台轮次必须收敛，会话可以直接再次对话，不需要人工取消；
 * 2. admission freeze 必须拒绝新工作，且只有真实排空（无活动轮次/任务/审批/Worker 运行）才允许停止；
 * 3. 两项能力同时生效：断连收敛后 drain 才能通过。
 */
import { randomBytes } from "node:crypto";
import { before as configureEnv, after as restoreEnv } from "node:test";
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { linkGoalRun, processGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { registerFixtureNodes } from "./helpers/registered-node.js";

const testPassword = randomBytes(24).toString("hex");
const previousPassword = process.env.DASHBOARD_PASS;
const previousGrace = process.env.NASH_TURN_DISCONNECT_GRACE_MS;
configureEnv(() => {
  process.env.DASHBOARD_PASS = testPassword;
  // 断连宽限缩短到 300ms，让验收在秒级完成；生产默认 60s。
  process.env.NASH_TURN_DISCONNECT_GRACE_MS = "300";
});
restoreEnv(() => {
  if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword;
  if (previousGrace === undefined) delete process.env.NASH_TURN_DISCONNECT_GRACE_MS; else process.env.NASH_TURN_DISCONNECT_GRACE_MS = previousGrace;
});

function request(urlStr: string, options: { method?: string; headers?: Record<string, string>; body?: any } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const headers = { ...options.headers };
    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(payload));
    }
    const req = http.request(urlStr, { method: options.method ?? "GET", headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let parsed: any = raw;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 发送请求后销毁套接字，模拟浏览器 / 反向代理客户端断开。 */
function sendThenDisconnect(urlStr: string, headers: Record<string, string>, body: unknown, afterMs: number) {
  return new Promise<void>((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request(urlStr, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) },
    }, (res) => { res.resume(); res.on("end", resolve); res.on("error", resolve); });
    req.on("error", () => resolve());
    req.write(payload);
    req.end();
    setTimeout(() => { try { req.destroy(); } catch {} resolve(); }, afterMs);
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("admission control and disconnected-turn recovery", () => {
  let coordinator: ClusterCoordinator;
  let baseUrl: string;
  let cookie: string;
  let csrf: string;
  let hanging: { release: () => void; aborted: Promise<void> }[] = [];
  let hangNextTurn = false;

  const authHeaders = () => ({ Cookie: cookie, "x-csrf-token": csrf });

  before(async () => {
    coordinator = new ClusterCoordinator({ ephemeral: true, listenHost: "127.0.0.1", listenPort: 0 });
    mock.method(coordinator.getMainAgent(), "chat", async (_conversationId: string, _text: string, options: any) => {
      if (!hangNextTurn) {
        return { assistantResponse: "直接回答，无需执行", state: "completed" as const, durationMs: 0 };
      }
      hangNextTurn = false;
      // 模拟长时间推理：只有 abortSignal 或显式释放才能结束本轮。
      await new Promise<void>((resolve, reject) => {
        const signal = options?.abortSignal;
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        hanging.push({ release: () => finish(), aborted: new Promise<void>(() => {}).then(() => {}) });
        signal?.addEventListener("abort", () => finish(new Error("aborted")), { once: true });
      });
      return { assistantResponse: "不应看到这一行", state: "completed" as const, durationMs: 1 };
    });
    const addr = await coordinator.start();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const login = await request(`${baseUrl}/api/auth/login`, { method: "POST", body: { username: "admin", password: testPassword } });
    assert.equal(login.status, 200);
    csrf = login.body.csrfToken;
    cookie = "";
    // login 的 Set-Cookie 需要在原始响应里取，重新登录并读取 headers
    const raw = await new Promise<{ status: number; setCookie: string; csrfToken: string }>((resolve, reject) => {
      const payload = JSON.stringify({ username: "admin", password: testPassword });
      const req = http.request(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } }, (res) => {
        let body = "";
        res.on("data", chunk => (body += chunk));
        res.on("end", () => {
          const setCookie = res.headers["set-cookie"]?.[0] ?? "";
          resolve({ status: res.statusCode ?? 0, setCookie: setCookie.split(";")[0]!, csrfToken: JSON.parse(body).csrfToken });
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    assert.match(raw.setCookie, /nash_session=sess-/);
    cookie = raw.setCookie;
    csrf = raw.csrfToken;
  });

  after(async () => {
    for (const entry of hanging) entry.release();
    await coordinator.stop();
  });

  async function createConversation(): Promise<string> {
    const res = await request(`${baseUrl}/api/cluster/conversations`, { method: "POST", headers: authHeaders(), body: { title: "admission fixture" } });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    return res.body.conversation.id ?? res.body.id;
  }

  async function postMessage(conversationId: string, content: string) {
    return await request(`${baseUrl}/api/cluster/conversations/${conversationId}/messages`, {
      method: "POST", headers: authHeaders(), body: { content },
    });
  }

  async function goals(conversationId: string) {
    const res = await request(`${baseUrl}/api/cluster/goal-runs?conversationId=${encodeURIComponent(conversationId)}`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    return res.body.goals as Array<{ goalRunId: string; status: string; executionState?: string; currentStage?: string }>;
  }

  async function admission() {
    const res = await request(`${baseUrl}/api/cluster/admission`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    return res.body;
  }

  test("client disconnect releases the conversation and converges its GoalRun without a manual cancel", async () => {
    const conversationId = await createConversation();
    hangNextTurn = true;
    await sendThenDisconnect(`${baseUrl}/api/cluster/conversations/${conversationId}/messages`, authHeaders(), { content: "执行一个很久的任务" }, 150);
    await sleep(1200);

    // 会话不再被占用：无需 cancel 即可继续对话
    const followUp = await postMessage(conversationId, "继续");
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));

    const list = await goals(conversationId);
    const first = list.find(goal => goal.goalRunId !== list[0]?.goalRunId) ?? list[list.length - 1]!;
    assert.ok(first, "the disconnected turn must still have a GoalRun");
    for (const goal of list) {
      if (goal.currentStage === "planning") continue;
      assert.ok(["completed", "cancelled", "failed", "waiting_approval", "outcome_unknown"].includes(goal.status) || goal.currentStage === "conversational",
        `goal ${goal.goalRunId} must not stay non-terminal after the client left (status=${goal.status})`);
    }
    // 断连轮次被明确标记为 detached，而不是伪装成用户取消或成功
    const conversation = await request(`${baseUrl}/api/cluster/conversations/${conversationId}`, { headers: authHeaders() });
    const detached = (conversation.body.conversation.messages as any[]).find(message => message.metadata?.state === "detached");
    assert.ok(detached, "the aborted turn must record why it stopped");
    assert.match(detached.content, /客户端已断开/);
  });

  test("a disconnect stops only the coordinator turn: dispatched work and pending approvals survive", async () => {
    const conversationId = await createConversation();
    const store = coordinator.getStore();
    await registerFixtureNodes(store, "worker-1");
    hangNextTurn = true;
    const post = sendThenDisconnect(`${baseUrl}/api/cluster/conversations/${conversationId}/messages`, authHeaders(), { content: "跨节点长任务" }, 900);
    await sleep(300);

    const goal = (await store.listGoalRuns!(conversationId))[0];
    assert.ok(goal, "the turn must create its GoalRun before it is interrupted");
    const task = await coordinator.getScheduler().createTask({ nodeId: "worker-1", projectId: "p", goal: "跨节点长任务" });
    await linkGoalRun(store, goal.goalRunId, "task", task.taskId);
    await store.saveApproval({
      approvalId: "appr-survive", taskId: task.taskId, runId: task.runId!, nodeId: "worker-1", agentId: "agent",
      capability: "filesystem.write", reason: "needs approval", status: "pending",
      requestedAt: Date.now(), expiresAt: Date.now() + 300_000,
    });

    await post;
    await sleep(1500);

    // 会话可直接继续，无需人工 cancel
    const followUp = await postMessage(conversationId, "继续");
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
    // 已派发的工作没有被断连连带取消，审批也没有被伪造裁决
    const survivor = await store.getTask(task.taskId);
    assert.ok(survivor && !["cancelled", "failed", "completed"].includes(survivor.status), `dispatched work must survive a client disconnect (status=${survivor?.status})`);
    assert.equal((await store.getApproval("appr-survive"))?.status, "pending");
    // 有真实工作未完成时，目标保持非终态并等待收敛，而不是被误标完成
    const after = await store.getGoalRun!(goal.goalRunId);
    assert.ok(after && !["completed", "cancelled", "failed"].includes(after.status), `a goal with live work must stay open (status=${after?.status})`);

    // 交互验证：#21 修复后，有未完成工作时 drain 仍然必须拒绝
    await request(`${baseUrl}/api/cluster/admission/freeze`, { method: "POST", headers: authHeaders(), body: { reason: "interaction" } });
    const blocked = await request(`${baseUrl}/api/cluster/admission/drain`, { method: "POST", headers: authHeaders(), body: { timeoutMs: 400 } });
    assert.equal(blocked.body.snapshot.readyToStop, false);
    const reasons = blocked.body.snapshot.unsettledReasons.join(";");
    assert.match(reasons, /active task/);
    assert.match(reasons, /pending approval/);
    assert.ok(blocked.body.snapshot.coordinator.activeTasks.some((entry: any) => entry.taskId === task.taskId));
    await request(`${baseUrl}/api/cluster/admission/unfreeze`, { method: "POST", headers: authHeaders(), body: {} });
  });

  test("freeze rejects new turns with ADMISSION_FROZEN and unfreeze restores admission", async () => {
    const conversationId = await createConversation();
    const freeze = await request(`${baseUrl}/api/cluster/admission/freeze`, { method: "POST", headers: authHeaders(), body: { reason: "test freeze" } });
    assert.equal(freeze.status, 200, JSON.stringify(freeze.body));
    assert.equal(freeze.body.admission.frozen, true);

    const rejected = await postMessage(conversationId, "冻结期间不应受理");
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "ADMISSION_FROZEN");

    const frozenSnapshot = await admission();
    assert.equal(frozenSnapshot.frozen, true);
    assert.equal(frozenSnapshot.frozenBy, "admin");

    const unfreeze = await request(`${baseUrl}/api/cluster/admission/unfreeze`, { method: "POST", headers: authHeaders(), body: {} });
    assert.equal(unfreeze.status, 200);
    const accepted = await postMessage(conversationId, "解冻后继续");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  });

  test("drain cannot succeed while a coordinator turn is still live, and succeeds once it is stopped", async () => {
    // 先收敛上一场景刻意留下的真实工作（取消任务、裁决审批），让排空有可证明的前提。
    const store = coordinator.getStore();
    for (const task of await store.listTasks({ limit: 200 })) {
      if (!["completed", "failed", "cancelled"].includes(task.status)) await store.updateTaskStatus(task.taskId, "cancelled", { error: "test teardown" });
    }
    for (const approval of await store.listPendingApprovals()) {
      await store.saveApproval({ ...approval, status: "resolved", decision: "deny", resolvedAt: Date.now(), resolvedBy: "test-teardown" });
    }
    for (const goal of await store.listGoalRuns!()) await processGoalRun(store, goal.goalRunId);

    const conversationId = await createConversation();
    hangNextTurn = true;
    const pending = postMessage(conversationId, "长时间推理中");
    await sleep(300);

    const live = await admission();
    assert.equal(live.settled, false);
    assert.match(live.unsettledReasons.join(";"), /live coordinator turn/);

    const freeze = await request(`${baseUrl}/api/cluster/admission/freeze`, { method: "POST", headers: authHeaders(), body: { reason: "drain test" } });
    assert.equal(freeze.status, 200);
    const refusedDrain = await request(`${baseUrl}/api/cluster/admission/drain`, { method: "POST", headers: authHeaders(), body: { timeoutMs: 600 } });
    assert.equal(refusedDrain.status, 200);
    assert.equal(refusedDrain.body.snapshot.readyToStop, false);
    assert.match(refusedDrain.body.snapshot.unsettledReasons.join(";"), /live coordinator turn/);

    // 查询参数形式的 timeoutMs 必须同样生效，不能静默退回 120s 默认值。
    const queryDrainStartedAt = Date.now();
    const queryDrain = await request(`${baseUrl}/api/cluster/admission/drain?timeoutMs=400`, { method: "POST", headers: authHeaders(), body: {} });
    assert.equal(queryDrain.body.snapshot.readyToStop, false);
    assert.ok(Date.now() - queryDrainStartedAt < 15000, "query timeoutMs must bound the drain");

    // 取消在途轮次（模拟执行被真实终止），随后排空必须成立
    const cancel = await request(`${baseUrl}/api/cluster/conversations/${conversationId}/cancel`, { method: "POST", headers: authHeaders(), body: {} });
    assert.equal(cancel.status, 200);
    await pending;
    await sleep(300);

    const drained = await request(`${baseUrl}/api/cluster/admission/drain`, { method: "POST", headers: authHeaders(), body: { timeoutMs: 15000 } });
    assert.equal(drained.body.snapshot.readyToStop, true, JSON.stringify(drained.body.snapshot));
    assert.equal(drained.body.snapshot.settled, true);
    assert.ok(drained.body.snapshot.settledStreak >= 2);

    const unfreeze = await request(`${baseUrl}/api/cluster/admission/unfreeze`, { method: "POST", headers: authHeaders(), body: {} });
    assert.equal(unfreeze.status, 200);
  });

  test("admission endpoints require an administrator session", async () => {
    const anonymous = await request(`${baseUrl}/api/cluster/admission`);
    assert.equal(anonymous.status, 401);
  });
});
