// SIMULATED_MODEL + REAL_COORDINATOR + REAL_LOCAL_WORKER + REAL_OS_SANDBOX:
// 真实 Coordinator、真实 WorkerRuntime、真实 WebSocket 协议、真实 PreToolSecurityMonitor 与
// 真实 OS 沙箱（macOS Seatbelt / Linux Bubblewrap）执行真实工具调用；模型由脚本化
// OpenAI-compatible SSE 提供，不代表真实模型能力，只用于确定性地驱动工具序列。
//
// 本用例验证任务级全访问授权的完整闭环：
//   workspace-write/deny/ask → 工作区外操作 → Web/API 审批 → 管理员「仅此任务启用全访问」
//   → Coordinator 持久化 → Worker 真实 ACK → 后续工具调用获得真实权限
//   → 同节点并行的未授权任务不受影响 → 任务结束后授权自动失效
// 权限结论以真实文件系统结果（工作区外文件是否存在）为准，而不是比较 Policy 对象。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { validateSandboxRequirements } from "../src/cluster/protocol/sandbox-requirements.js";
import type { ClusterApprovalRecord } from "../src/cluster/storage/cluster-store-types.js";

const SECURITY_PROMPT_MARKER = "You are a security monitor for autonomous AI coding agents";

interface ScriptedSecurityReview {
  at: number;
  prompt: string;
  verdict: string;
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function finalAnswer(content: string) {
  return { role: "assistant", content };
}

function sseResponse(message: unknown): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } }
  );
}

function jsonResponse(message: unknown): Response {
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  return new Response(JSON.stringify({ choices: [{ message }], usage }), {
    headers: { "Content-Type": "application/json" },
  });
}

function securityDecision(verdict: "ALLOW" | "BLOCK"): string {
  return [
    "<decision>",
    `  <verdict>${verdict}</verdict>`,
    `  <severity>${verdict === "BLOCK" ? 95 : 0}</severity>`,
    `  <category>${verdict === "BLOCK" ? "E2E Hard Block" : "Routine Operation"}</category>`,
    `  <ruleName>${verdict === "BLOCK" ? "E2E Block Rule" : "E2E Allow Rule"}</ruleName>`,
    `  <reason>${verdict === "BLOCK" ? "scripted hard block" : "task-scoped routine operation"}</reason>`,
    "  <decisionEvidence>isolated E2E fixture</decisionEvidence>",
    "  <authorizationBasis>task-scoped</authorizationBasis>",
    "</decision>",
  ].join("\n");
}

function toolResultContent(transcript: string, toolCallId: string): string | undefined {
  const messages = JSON.parse(transcript) as Array<{ role: string; tool_call_id?: string; content?: unknown }>;
  const message = messages.find((item) => item.role === "tool" && item.tool_call_id === toolCallId);
  return typeof message?.content === "string" ? message.content : undefined;
}

async function httpJson(
  url: string,
  init: { method: string; body?: unknown; bearer: string }
): Promise<{ status: number; body: any }> {
  const response = await fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${init.bearer}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

test(
  "SIMULATED_MODEL + REAL_LOCAL_WORKER: task-level full access is granted through approval, enforces real outside-workspace writes, stays isolated from a concurrent task, and expires with the task",
  {
    timeout: 180000,
    // 本用例用 POSIX shell 验证「授权前后真实工作区外写入」；Windows 原生沙箱目前不提供
    // 与 Seatbelt/Bubblewrap 等价的已验证网络隔离，无法给出同强度证据，交由 platform 专项验收。
    skip: process.platform === "win32"
      ? "Windows 原生沙箱缺少等价的内核级网络/文件隔离验证，真实权限 E2E 仅在 macOS/Linux 执行"
      : false,
  },
  async (t) => {
    const oldEnv = {
      NASH_HOME: process.env.NASH_HOME,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
      DEEPSEEK_API_FORMAT: process.env.DEEPSEEK_API_FORMAT,
    };
    const oldFetch = globalThis.fetch;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-grant-e2e-"));
    // 关键：工作区外目标必须位于「受控临时目录」之外，否则 macOS Seatbelt 的
    // workspace-write 策略本来就允许写 /tmp，无法证明授权前后权限真的发生变化。
    const outsideDir = fs.mkdtempSync(path.join(os.homedir(), ".nash-grant-e2e-outside-"));
    // WorkerRuntime 按 canonical project 路径串行调度，因此「同一 Worker 上并行两个 Task」
    // 必须落在两个不同项目上；它们仍共享同一个节点、同一个沙箱进程与同一份全局策略。
    const projectDir = path.join(root, "project");
    const projectBDir = path.join(root, "project-b");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(projectBDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "isolated task-grant fixture");
    fs.writeFileSync(path.join(projectBDir, "README.md"), "isolated task-grant fixture B");

    const outsideA1 = path.join(outsideDir, "a-pre-grant-bash.txt");
    const outsideA2 = path.join(outsideDir, "a-approval-write-file.txt");
    const outsideA3 = path.join(outsideDir, "a-post-grant-bash.txt");
    const outsideB1 = path.join(outsideDir, "b-denied-write-file.txt");
    const outsideB2 = path.join(outsideDir, "b-unauthorized-bash.txt");

    const securityReviews: ScriptedSecurityReview[] = [];
    const transcripts = new Map<string, string>();
    let lastTranscriptA = "";
    let lastTranscriptB = "";

    const scriptedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/chat/completions")) return oldFetch(input as any, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: unknown }>;
        stream?: boolean;
      };
      const messages = body.messages ?? [];
      const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      const transcript = JSON.stringify(messages);

      // 独立安全审查（非流式）：任务获得全访问后依然必须逐次经过安全模型审查。
      if (body.stream !== true && system.includes(SECURITY_PROMPT_MARKER)) {
        const verdict: "ALLOW" | "BLOCK" = "ALLOW";
        securityReviews.push({ at: Date.now(), prompt: transcript, verdict });
        return jsonResponse({ role: "assistant", content: securityDecision(verdict) });
      }

      if (transcript.includes("GRANT-A-TARGET")) {
        transcripts.set("A", transcript);
        if (!transcript.includes("a-step1-bash-outside")) {
          return sseResponse(toolCall("a-step1-bash-outside", "bash", { command: `printf 'A1' > '${outsideA1}'` }));
        }
        if (!transcript.includes("a-step2-write-outside")) {
          return sseResponse(toolCall("a-step2-write-outside", "write_file", { path: outsideA2, content: "A2" }));
        }
        if (!transcript.includes("a-step3-bash-outside")) {
          return sseResponse(toolCall("a-step3-bash-outside", "bash", { command: `printf 'A3' > '${outsideA3}'` }));
        }
        if (!transcript.includes("a-step4-hardblock")) {
          // 确定性硬拦截：即使任务持有全访问授权，也必须被安全边界阻断。
          return sseResponse(toolCall("a-step4-hardblock", "bash", { command: "chmod -R 777 /" }));
        }
        lastTranscriptA = transcript;
        return sseResponse(finalAnswer("TASK_A_DONE"));
      }

      if (transcript.includes("NOGRANT-B-TARGET")) {
        transcripts.set("B", transcript);
        if (!transcript.includes("b-step1-write-outside")) {
          return sseResponse(toolCall("b-step1-write-outside", "write_file", { path: outsideB1, content: "B1" }));
        }
        if (!transcript.includes("b-step2-bash-outside")) {
          return sseResponse(toolCall("b-step2-bash-outside", "bash", { command: `printf 'B2' > '${outsideB2}'` }));
        }
        lastTranscriptB = transcript;
        return sseResponse(finalAnswer("TASK_B_DONE"));
      }

      return sseResponse(finalAnswer("UNEXPECTED_PROMPT"));
    }) as typeof fetch;
    globalThis.fetch = scriptedFetch;

    process.env.NASH_HOME = path.join(root, "home");
    process.env.DEEPSEEK_API_KEY = randomBytes(24).toString("hex");
    process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.DEEPSEEK_MODEL = "scripted-e2e-model";
    process.env.DEEPSEEK_API_FORMAT = "completions";

    const adminApiKey = `admin-${randomBytes(16).toString("hex")}`;
    const coordinator = new ClusterCoordinator({
      ephemeral: true,
      customDir: path.join(root, "coordinator"),
      listenHost: "127.0.0.1",
      listenPort: 0,
      adminApiKey,
    });
    let worker: WorkerRuntime | undefined;
    let grantSkipped = false;

    t.after(async () => {
      try { await worker?.stop(); } catch { /* best effort */ }
      try { await coordinator.stop(); } catch { /* best effort */ }
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(oldEnv) as Array<[keyof typeof oldEnv, string | undefined]>) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    const { port } = await coordinator.start();
    const store = coordinator.getStore();
    worker = new WorkerRuntime({
      coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`,
      inviteCode: coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 }).inviteCode,
      customDir: path.join(root, "worker"),
      nodeId: "grant-worker",
    });
    const projectId = worker.projects.registerProject(projectDir, "grant-project").projectId;
    const projectBId = worker.projects.registerProject(projectBDir, "grant-project-b").projectId;
    await worker.start();

    const readyDeadline = Date.now() + 20000;
    let reason = "Worker catalog not yet received";
    while (Date.now() < readyDeadline) {
      const node = await store.getNode("grant-worker");
      const revision = await store.getCatalogRevision("grant-worker");
      const capability = revision?.capabilities.find((item) => item.category === "sandbox");
      const catalog = await store.listProjectsCatalog({ nodeId: "grant-worker" });
      const registered = catalog.some((item) => item.projectId === projectId) &&
        catalog.some((item) => item.projectId === projectBId);
      if (
        node && registered && capability && coordinator.getRegistry().getConnection("grant-worker") &&
        !validateSandboxRequirements(node.platform, capability, "workspace-write", "deny")
      ) break;
      const rejection = node ? validateSandboxRequirements(node.platform, capability, "workspace-write", "deny") : undefined;
      reason = rejection?.reason ?? "Waiting for authenticated Worker, registered project and verified sandbox capability";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const node = await store.getNode("grant-worker");
    const capability = (await store.getCatalogRevision("grant-worker"))?.capabilities.find(
      (item) => item.category === "sandbox"
    );
    if (!node || !capability || validateSandboxRequirements(node.platform, capability, "workspace-write", "deny")) {
      grantSkipped = true;
      t.skip(`本机没有可验证的 workspace-write/deny 原生沙箱能力，无法真实执行权限 E2E：${reason}`);
      return;
    }

    const settingsPath = path.join(root, "worker", "settings.json");
    const settingsBefore = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : undefined;

    // 计数真实到达 Coordinator 的审批：授权生效后，后续工具调用不得再产生逐次人工审批。
    const approvalsByTask = new Map<string, number>();
    const originalSaveApproval = store.saveApproval.bind(store);
    (store as unknown as { saveApproval: typeof store.saveApproval }).saveApproval = async (record: ClusterApprovalRecord) => {
      if (!(await store.getApproval(record.approvalId))) {
        approvalsByTask.set(record.taskId, (approvalsByTask.get(record.taskId) ?? 0) + 1);
      }
      return originalSaveApproval(record);
    };

    const taskA = await coordinator.getScheduler().createTask({
      nodeId: "grant-worker",
      projectId,
      goal: "GRANT-A-TARGET: 执行给定的工作区外文件操作序列并报告完成",
      maxSteps: 10,
    });
    const taskB = await coordinator.getScheduler().createTask({
      nodeId: "grant-worker",
      projectId: projectBId,
      goal: "NOGRANT-B-TARGET: 执行给定的工作区外文件操作序列并报告完成",
      maxSteps: 10,
    });
    assert.notEqual(taskA.taskId, taskB.taskId);

    // 等待同一个 Worker 上两个任务各自挂起的真实审批同时出现。
    const approvalsDeadline = Date.now() + 40000;
    let approvalA: any;
    let approvalB: any;
    while (Date.now() < approvalsDeadline) {
      const pending = await store.listPendingApprovals();
      approvalA = pending.find((item) => item.taskId === taskA.taskId);
      approvalB = pending.find((item) => item.taskId === taskB.taskId);
      if (approvalA && approvalB) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(approvalA, "Task A 未产生工作区外写入审批");
    assert.ok(approvalB, "Task B 未产生工作区外写入审批");
    assert.equal(approvalA.capability, "filesystem-outside-workspace");
    assert.equal(approvalB.capability, "filesystem-outside-workspace");
    assert.ok(approvalA.target.includes(outsideA2));
    assert.ok(approvalB.target.includes(outsideB1));

    // Web 控制台第三个按钮的真实 API：仅管理员可授予「仅此任务启用全访问」。
    const grantResponse = await httpJson(
      `http://127.0.0.1:${port}/api/cluster/approvals/${approvalA.approvalId}/grant-full-access`,
      { method: "POST", bearer: adminApiKey }
    );
    assert.equal(grantResponse.status, 200, JSON.stringify(grantResponse.body));
    assert.equal(grantResponse.body.applied, true, "授权必须由 Worker 真实 ACK 后才算生效");
    assert.equal(grantResponse.body.status, "applied");
    assert.equal(grantResponse.body.taskId, taskA.taskId);
    assert.equal(grantResponse.body.targetPolicy.filesystem.mode, "danger-full-access");
    assert.equal(grantResponse.body.targetPolicy.network.mode, "allow");
    assert.equal(grantResponse.body.targetPolicy.approval.mode, "auto-grant");

    const denyResponse = await httpJson(
      `http://127.0.0.1:${port}/api/cluster/approvals/${approvalB.approvalId}/resolve`,
      { method: "POST", bearer: adminApiKey, body: { decision: "deny", resolvedBy: "e2e-admin" } }
    );
    assert.equal(denyResponse.status, 200, JSON.stringify(denyResponse.body));

    const terminalDeadline = Date.now() + 60000;
    let recordA = await store.getTask(taskA.taskId);
    let recordB = await store.getTask(taskB.taskId);
    while (
      Date.now() < terminalDeadline &&
      (!recordA || !["completed", "failed", "cancelled"].includes(recordA.status) ||
        !recordB || !["completed", "failed", "cancelled"].includes(recordB.status))
    ) {
      await coordinator.getScheduler().flushOutbox();
      await new Promise((resolve) => setTimeout(resolve, 100));
      recordA = await store.getTask(taskA.taskId);
      recordB = await store.getTask(taskB.taskId);
    }
    assert.equal(recordA?.status, "completed", JSON.stringify({ status: recordA?.status, error: recordA?.error }));
    assert.equal(recordB?.status, "completed", JSON.stringify({ status: recordB?.status, error: recordB?.error }));
    assert.match(recordA?.finalAnswer ?? "", /TASK_A_DONE/);
    assert.match(recordB?.finalAnswer ?? "", /TASK_B_DONE/);

    // 1. 授权前：真实 OS 沙箱拒绝工作区外写入（bash 未获得人工审批）。
    assert.equal(fs.existsSync(outsideA1), false, "授权前的 bash 工作区外写入必须被真实沙箱拒绝");
    // 2. 授权过程：原审批以 grant-task-full-access 收敛，且写入真实发生。
    assert.equal(fs.existsSync(outsideA2), true, "授权确认后 write_file 必须真实写入工作区外文件");
    // 3. 授权后：后续 bash 工具调用获得真实权限，不再逐次人工审批。
    assert.equal(fs.existsSync(outsideA3), true, "授权后 bash 必须具备真实工作区外写入能力");
    // 4. 并行未授权任务：审批被拒绝，工作区外写入全部失败。
    assert.equal(fs.existsSync(outsideB1), false, "未授权任务不得写入工作区外文件");
    assert.equal(fs.existsSync(outsideB2), false, "未授权任务的 bash 写入必须被拒绝");
    // 5. 确定性硬拦截在授权下仍然有效，工具结果如实返回 BLOCK。
    assert.match(lastTranscriptA, /Security Monitor: BLOCK/, "全访问授权下确定性硬拦截必须仍然生效");
    const preGrantResult = toolResultContent(lastTranscriptA, "a-step1-bash-outside");
    const postGrantResult = toolResultContent(lastTranscriptA, "a-step3-bash-outside");
    const hardBlockResult = toolResultContent(lastTranscriptA, "a-step4-hardblock");
    assert.ok(preGrantResult, "授权前的 bash 结果必须真实回传");
    assert.match(preGrantResult!, /退出码/, "授权前的 bash 工作区外写入必须是非零退出码的真实失败");
    assert.ok(postGrantResult, "授权后的 bash 结果必须真实回传");
    assert.doesNotMatch(postGrantResult!, /退出码/, "授权后的 bash 工作区外写入必须是成功执行");
    assert.ok(hardBlockResult);
    assert.match(hardBlockResult!, /Security Monitor: BLOCK/);
    // 授权生效后不得再有任何逐次人工审批：整个任务期间只允许 1 条真实审批记录。
    assert.equal(approvalsByTask.get(taskA.taskId), 1, "授权生效后不得再产生逐次人工审批");
    assert.equal(approvalsByTask.get(taskB.taskId), 1, "未授权任务的审批只应出现一次");
    // 6. 授权后安全模型仍然逐次审查（网络/文件越界不等于免除审查）。
    assert.ok(
      securityReviews.some((review) => review.prompt.includes(outsideA3)),
      "授权生效后的 bash 工具调用必须仍然经过独立安全审查"
    );

    const storedApprovalA = await store.getApproval(approvalA.approvalId);
    const storedApprovalB = await store.getApproval(approvalB.approvalId);
    assert.equal(storedApprovalA?.decision, "grant-task-full-access");
    assert.equal(storedApprovalB?.decision, "deny");
    assert.ok(storedApprovalA?.grantId);

    const grantsA = await store.listTaskSecurityGrants!({ taskId: taskA.taskId });
    const grantsB = await store.listTaskSecurityGrants!({ taskId: taskB.taskId });
    assert.equal(grantsA.length, 1);
    assert.equal(grantsA[0]!.status, "expired", "任务终态后任务级授权必须自动失效");
    assert.equal(grantsA[0]!.appliesTo, "subsequent-tool-calls");
    assert.equal(grantsB.length, 0, "未授权任务不得产生任何授权记录");
    assert.equal(await store.getActiveTaskSecurityGrant!(taskA.taskId, taskA.runId!), null);

    // 7. 全局/节点策略未被授权污染。
    const settingsAfter = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : undefined;
    assert.equal(settingsAfter, settingsBefore, "任务级授权不得修改节点全局 settings.json");
    assert.equal(fs.existsSync(path.join(root, "worker", "product.db")), false, "任务级授权不得创建全局策略存储");

    // 8. 审批队列必须完全清空，不允许遗留挂起审批。
    const remaining = (await store.listPendingApprovals()).filter(
      (item) => item.taskId === taskA.taskId || item.taskId === taskB.taskId
    );
    assert.deepEqual(remaining, []);

    // 9. 跨 Run 不复用：任务 B 的不同 run 不存在可用授权。
    assert.equal(await store.getActiveTaskSecurityGrant!(taskB.taskId, taskB.runId!), null);
    assert.equal(fs.existsSync(path.join(outsideDir, "b-denied-write-file.txt")), false);

    // 10. Web 刷新一致：任务详情接口在任务终态后不再返回 activeGrant。
    const detailsA = await httpJson(`http://127.0.0.1:${port}/api/cluster/tasks/${taskA.taskId}`, {
      method: "GET",
      bearer: adminApiKey,
    });
    assert.equal(detailsA.status, 200, JSON.stringify(detailsA.body));
    assert.equal(detailsA.body.task.status, "completed");
    assert.equal(detailsA.body.activeGrant, null, "任务终态后 Web 不得再展示生效中的全访问授权");
    const detailsB = await httpJson(`http://127.0.0.1:${port}/api/cluster/tasks/${taskB.taskId}`, {
      method: "GET",
      bearer: adminApiKey,
    });
    assert.equal(detailsB.status, 200, JSON.stringify(detailsB.body));
    assert.equal(detailsB.body.activeGrant, null);

    if (!grantSkipped) {
      t.diagnostic(`platform=${process.platform} sandbox=${capability.structuredDetails?.backend ?? capability.name}`);
    }
  }
);

test(
  "REAL_COORDINATOR: an offline worker can never receive a task-level full-access grant, and the pending approval stays unresolved",
  { timeout: 120000 },
  async (t) => {
    const oldEnv = {
      NASH_HOME: process.env.NASH_HOME,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
      DEEPSEEK_API_FORMAT: process.env.DEEPSEEK_API_FORMAT,
    };
    const oldFetch = globalThis.fetch;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-grant-offline-"));
    const outsideDir = fs.mkdtempSync(path.join(os.homedir(), ".nash-grant-offline-outside-"));
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "offline grant fixture");
    const outsideTarget = path.join(outsideDir, "offline-write.txt");

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/chat/completions")) return oldFetch(input as any, init);
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }>; stream?: boolean };
      const messages = body.messages ?? [];
      const system = messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
      const transcript = JSON.stringify(messages);
      if (body.stream !== true && system.includes(SECURITY_PROMPT_MARKER)) {
        return jsonResponse({ role: "assistant", content: securityDecision("ALLOW") });
      }
      if (!transcript.includes("offline-write-outside")) {
        return sseResponse(toolCall("offline-write-outside", "write_file", { path: outsideTarget, content: "offline" }));
      }
      return sseResponse(finalAnswer("OFFLINE_DONE"));
    }) as typeof fetch;
    process.env.NASH_HOME = path.join(root, "home");
    process.env.DEEPSEEK_API_KEY = randomBytes(24).toString("hex");
    process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.DEEPSEEK_MODEL = "scripted-e2e-model";
    process.env.DEEPSEEK_API_FORMAT = "completions";

    const adminApiKey = `admin-${randomBytes(16).toString("hex")}`;
    const coordinator = new ClusterCoordinator({
      ephemeral: true,
      customDir: path.join(root, "coordinator"),
      listenHost: "127.0.0.1",
      listenPort: 0,
      adminApiKey,
    });
    let worker: WorkerRuntime | undefined;
    t.after(async () => {
      try { await worker?.stop(); } catch { /* best effort */ }
      try { await coordinator.stop(); } catch { /* best effort */ }
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(oldEnv) as Array<[keyof typeof oldEnv, string | undefined]>) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    const { port } = await coordinator.start();
    const store = coordinator.getStore();
    worker = new WorkerRuntime({
      coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`,
      inviteCode: coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 }).inviteCode,
      customDir: path.join(root, "worker"),
      nodeId: "offline-worker",
    });
    const projectId = worker.projects.registerProject(projectDir, "offline-project").projectId;
    await worker.start();

    const readyDeadline = Date.now() + 20000;
    let capabilityRejection: string | undefined = "Worker catalog not yet received";
    while (Date.now() < readyDeadline) {
      const node = await store.getNode("offline-worker");
      const capability = (await store.getCatalogRevision("offline-worker"))?.capabilities.find((item) => item.category === "sandbox");
      const registered = (await store.listProjectsCatalog({ nodeId: "offline-worker" })).some((item) => item.projectId === projectId);
      capabilityRejection = node ? validateSandboxRequirements(node.platform, capability, "workspace-write", "deny")?.reason : undefined;
      if (node && registered && capability && coordinator.getRegistry().getConnection("offline-worker") && !capabilityRejection) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!coordinator.getRegistry().getConnection("offline-worker") || capabilityRejection) {
      t.skip(`本机没有可验证的原生沙箱能力，无法建立授权前置条件：${capabilityRejection ?? "Worker not connected"}`);
      return;
    }

    const task = await coordinator.getScheduler().createTask({
      nodeId: "offline-worker",
      projectId,
      goal: "OFFLINE-GRANT-TARGET: 尝试工作区外写入",
      maxSteps: 5,
    });
    const approvalDeadline = Date.now() + 30000;
    let approval: any;
    while (Date.now() < approvalDeadline) {
      approval = (await store.listPendingApprovals()).find((item) => item.taskId === task.taskId);
      if (approval) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(approval, "任务必须真实挂起一个工作区外写入审批");

    await worker.stop();
    worker = undefined;
    const offlineDeadline = Date.now() + 10000;
    while (Date.now() < offlineDeadline && coordinator.getRegistry().getConnection("offline-worker")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(coordinator.getRegistry().getConnection("offline-worker"), undefined, "Worker 必须已离线");

    const grantResponse = await httpJson(
      `http://127.0.0.1:${port}/api/cluster/approvals/${approval.approvalId}/grant-full-access`,
      { method: "POST", bearer: adminApiKey }
    );
    // 节点离线时绝不允许伪造授权成功；若任务已被收敛为 outcome_unknown，则必须明确拒绝。
    assert.ok([503, 409].includes(grantResponse.status), JSON.stringify(grantResponse.body));
    assert.match(String(grantResponse.body?.error ?? ""), /不在线|outcome_unknown|终态/);
    assert.equal((await store.listTaskSecurityGrants!({ taskId: task.taskId })).length, 0, "离线的 Worker 不得产生授权记录");
    const storedApproval = await store.getApproval(approval.approvalId);
    assert.equal(storedApproval?.status, "pending", "授权失败后审批必须保持挂起，等待人工处理");
    assert.notEqual((await store.getTask(task.taskId))?.status, "completed");
    assert.equal(fs.existsSync(outsideTarget), false, "离线节点不可能真正执行提权后的写入");
    t.diagnostic(`offline grant rejected with HTTP ${grantResponse.status}`);
  }
);
