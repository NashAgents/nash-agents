import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { validateSandboxRequirements } from "../src/cluster/protocol/sandbox-requirements.js";

describe("SIMULATED_INTEGRATION: Nash Cluster real WebSocket protocol with local Workers", () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;
  let coordinatorPort: number;
  let tempDir: string;
  let projectDir: string;
  const initialApiKey = process.env.DEEPSEEK_API_KEY;
  let modelFetch: ReturnType<typeof mock.method>;

  async function waitForExecutionReadiness(nodeId: string, projectId: string) {
    const deadline = Date.now() + 10000;
    let reason = "Worker catalog not yet received";
    while (Date.now() < deadline) {
      const store = coordinator.getStore();
      const node = await store.getNode(nodeId);
      const revision = await store.getCatalogRevision(nodeId);
      const project = (await store.listProjectsCatalog({ nodeId })).find(item => item.projectId === projectId);
      const capability = revision?.capabilities.find(item => item.category === "sandbox");
      const rejection = node ? validateSandboxRequirements(node.platform, capability, "workspace-write", "deny") : undefined;
      if (coordinator.getRegistry().getConnection(nodeId) && node && project && capability && !rejection) return;
      reason = rejection?.reason ?? "Waiting for authenticated Worker, registered project and verified sandbox catalog";
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`Worker execution precondition unavailable: ${reason}`);
  }

  before(async () => {
    process.env.DEEPSEEK_API_KEY = "fixture-model-key";
    const originalFetch = globalThis.fetch;
    modelFetch = mock.method(globalThis, "fetch", ((input, init) => {
      if (!String(input).endsWith("/chat/completions")) return originalFetch(input, init);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-cluster-e2e-"));
    projectDir = path.join(tempDir, "sample-project");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Sample Project for Cluster Test\n");

    // 随机空闲端口启动 Coordinator
    coordinator = new ClusterCoordinator({
      ephemeral: true,
      listenHost: "127.0.0.1",
      listenPort: 0, // 动态端口
      nodeId: "test-coordinator",
      name: "Test Coordinator",
    });

    const bound = await coordinator.start();
    coordinatorPort = bound.port;
    coordinatorUrl = `ws://127.0.0.1:${coordinatorPort}/ws/cluster`;
  });

  after(async () => {
    try { await coordinator.stop(); }
    finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
      modelFetch?.mock.restore();
      if (initialApiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = initialApiKey;
    }
  });

  it("场景 A: 节点应能使用 InviteCode 配对并保持在线心跳", async () => {
    // 1. 生成一次性邀请码
    const invite = coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 });
    assert.ok(invite.inviteCode.startsWith("nash-inv-"));

    const workerDir = path.join(tempDir, "worker-1");
    fs.mkdirSync(workerDir, { recursive: true });

    // 2. 启动 Worker 并使用邀请码配对
    const worker = new WorkerRuntime({
      coordinatorUrl,
      inviteCode: invite.inviteCode,
      customDir: workerDir,
      nodeId: "test-worker-1",
      name: "Test Worker 1",
    });

    await worker.start();

    // 等待 WebSocket 认证完成
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(worker.isConnected, true);

    // 检查 Coordinator 上的节点列表
    const conn = coordinator.getRegistry().getConnection("test-worker-1");
    assert.ok(conn);
    assert.equal(conn.nodeId, "test-worker-1");
    assert.equal(conn.generation, 1);

    await worker.stop();
  });

  it("场景 B: 节点重连后应复用同一 Node ID 且代际递增", async () => {
    const workerDir = path.join(tempDir, "worker-2");
    fs.mkdirSync(workerDir, { recursive: true });

    const invite = coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 });

    const worker = new WorkerRuntime({
      coordinatorUrl,
      inviteCode: invite.inviteCode,
      customDir: workerDir,
      nodeId: "test-worker-2",
      name: "Test Worker 2",
    });

    await worker.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(worker.isConnected, true);

    const firstConn = coordinator.getRegistry().getConnection("test-worker-2");
    assert.equal(firstConn?.generation, 1);

    // 模拟临时断网并重连
    await worker.stop();
    await new Promise((r) => setTimeout(r, 100));

    // 重新启动 Worker（复用已保存的 Token）
    const reconnectedWorker = new WorkerRuntime({
      coordinatorUrl,
      customDir: workerDir,
      nodeId: "test-worker-2",
    });

    await reconnectedWorker.start();
    await new Promise((r) => setTimeout(r, 200));

    const secondConn = coordinator.getRegistry().getConnection("test-worker-2");
    assert.ok(secondConn);
    assert.equal(secondConn.generation, 2); // 代际递增
    assert.equal(secondConn.nodeId, "test-worker-2"); // Node ID 不变

    await reconnectedWorker.stop();
  });

  it("场景 C: Coordinator 派发任务至远程 Worker，Worker 接收并上报启动证据", async (t) => {
    const workerDir = path.join(tempDir, "worker-3");
    fs.mkdirSync(workerDir, { recursive: true });

    const invite = coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 });
    const worker = new WorkerRuntime({
      coordinatorUrl,
      inviteCode: invite.inviteCode,
      customDir: workerDir,
      nodeId: "test-worker-3",
      name: "Test Worker 3",
    });

    t.after(() => worker.stop());

    // 授权项目
    const regProj = worker.projects.registerProject(projectDir, "sample-project");
    await worker.start();
    await waitForExecutionReadiness("test-worker-3", regProj.projectId);

    // 派发任务
    const task = await coordinator.getScheduler().createTask({
      nodeId: "test-worker-3",
      projectId: regProj.projectId,
      goal: "Check README file content",
      maxSteps: 1, timeoutMs: 5000,
    });

    assert.equal(task.nodeId, "test-worker-3");
    assert.equal(task.projectId, regProj.projectId);

    // Protocol acceptance is proven by the durable start event, even when a missing
    // model configuration terminates the run before a fixed sleep would observe it.
    let events = await coordinator.getStore().getEventsForTask(task.taskId);
    const deadline = Date.now() + 5000;
    while (!events.some(e => e.eventType === "task.started") && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      events = await coordinator.getStore().getEventsForTask(task.taskId);
    }
    assert.ok(events.some(e => e.eventType === "task.started"), "Worker must emit a real sequenced start event");

    await worker.stop();
  });

  it("场景 D: 远程控制测试 (Steer / Interrupt / Cancel)", async (t) => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "fixture-model-key";
    t.after(() => { if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey; });
    let modelStarted!: () => void;
    const ready = new Promise<void>(resolve => { modelStarted = resolve; });
    const originalFetch = globalThis.fetch;
    const fetchMock = mock.method(globalThis, "fetch", ((input, init) => {
      if (!String(input).endsWith("/chat/completions")) return originalFetch(input, init);
      modelStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch);
    t.after(() => fetchMock.mock.restore());
    const workerDir = path.join(tempDir, "worker-4");
    fs.mkdirSync(workerDir, { recursive: true });

    const invite = coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 });
    const worker = new WorkerRuntime({
      coordinatorUrl,
      inviteCode: invite.inviteCode,
      customDir: workerDir,
      nodeId: "test-worker-4",
      name: "Test Worker 4",
    });

    const regProj = worker.projects.registerProject(projectDir, "sample-project");
    await worker.start();
    await waitForExecutionReadiness("test-worker-4", regProj.projectId);

    try {
      const task = await coordinator.getScheduler().createTask({
        nodeId: "test-worker-4",
        projectId: regProj.projectId,
        goal: "Long running execution test",
      });

      let readyTimeout: NodeJS.Timeout | undefined;
      try { await Promise.race([ready, new Promise((_, reject) => { readyTimeout = setTimeout(() => reject(new Error("Worker did not reach the controlled model boundary")), 5000); })]); }
      finally { clearTimeout(readyTimeout); }

      // 1. 发送 Steer
      const steerRes = await coordinator.getScheduler().sendControl(task.taskId, "steer", {
        steerContent: "Focus on testing README rather than build files",
      });
      assert.equal(steerRes.success, true);

      // 2. 发送 Interrupt
      const intRes = await coordinator.getScheduler().sendControl(task.taskId, "interrupt");
      assert.equal(intRes.success, false); // 当前停留在模型请求阶段，没有可中断的工具。

      // 3. 发送 Cancel
      const cancelRes = await coordinator.getScheduler().sendControl(task.taskId, "cancel", {
        reason: "User cancelled from CLI",
      });
      assert.equal(cancelRes.success, true);

      // 等待 Worker 确认控制或校验处于 cancelling/cancelled 状态
      await new Promise((r) => setTimeout(r, 200));
      const cancelledTask = await coordinator.getStore().getTask(task.taskId);
      assert.ok(["cancelling", "cancelled"].includes(cancelledTask?.status || ""));
    } finally {
      await worker.stop();
    }
  });
});
