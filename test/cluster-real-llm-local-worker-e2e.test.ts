// REAL_LLM + REAL_SANDBOX + REAL_LOCAL_WORKER: a real model drives the native AgentLoop of a real
// local Worker over the real cluster WebSocket protocol, and the GoalRun report must be produced
// from attempt-bound evidence. It is not a four-node production E2E and makes no claim about remote
// hosts. Runs only when a real provider is exported, e.g.
//   DEEPSEEK_BASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... DEEPSEEK_API_FORMAT=completions \
//   NASH_RUN_REAL_LLM_TESTS=1 node --import tsx --test test/cluster-real-llm-local-worker-e2e.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import { WorkerRuntime } from "../src/cluster/worker/worker-runtime.js";
import { defaultTraceContext } from "../src/observability/trace-context.js";
import { processGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import { validateSandboxRequirements } from "../src/cluster/protocol/sandbox-requirements.js";

const realModel = Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_BASE_URL && process.env.DEEPSEEK_MODEL);

test("REAL_LLM + REAL_SANDBOX + REAL_LOCAL_WORKER: a verified receipt closes the GoalRun", {
  skip: process.env.NASH_RUN_REAL_LLM_TESTS !== "1" || !realModel
    ? "Requires NASH_RUN_REAL_LLM_TESTS=1 and an exported real model configuration"
    : false,
  timeout: 240000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-real-llm-worker-"));
  const oldHome = process.env.NASH_HOME;
  process.env.NASH_HOME = path.join(root, "home");
  const token = `token-${randomBytes(6).toString("hex")}`;
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "answer.txt"), `${token}\n`, "utf-8");
  const coordinator = new ClusterCoordinator({ ephemeral: true, customDir: path.join(root, "coordinator"), listenHost: "127.0.0.1", listenPort: 0 });
  let worker: WorkerRuntime | undefined;
  t.after(async () => {
    try { await worker?.stop(); await coordinator.stop(); }
    finally {
      if (oldHome === undefined) delete process.env.NASH_HOME; else process.env.NASH_HOME = oldHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const { port } = await coordinator.start();
  const store = coordinator.getStore();
  worker = new WorkerRuntime({
    coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`,
    inviteCode: coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 }).inviteCode,
    customDir: path.join(root, "worker"),
    nodeId: "worker-real",
  });
  const projectId = worker.projects.registerProject(projectDir, "project-real").projectId;
  await worker.start();

  const readyDeadline = Date.now() + 20000;
  let reason = "Worker catalog not yet received";
  while (Date.now() < readyDeadline) {
    const node = await store.getNode("worker-real");
    const revision = await store.getCatalogRevision("worker-real");
    const capability = revision?.capabilities.find(item => item.category === "sandbox");
    const registered = (await store.listProjectsCatalog({ nodeId: "worker-real" })).some(item => item.projectId === projectId);
    const rejection = node ? validateSandboxRequirements(node.platform, capability, "read-only", "deny") : undefined;
    if (node && registered && capability && coordinator.getRegistry().getConnection("worker-real") && !rejection) break;
    reason = rejection?.reason ?? "Waiting for authenticated Worker, registered project and verified sandbox capability";
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const node = await store.getNode("worker-real");
  const capability = (await store.getCatalogRevision("worker-real"))?.capabilities.find(item => item.category === "sandbox");
  assert.ok(node && capability && !validateSandboxRequirements(node.platform, capability, "read-only", "deny"), `Worker sandbox unavailable: ${reason}`);

  await store.createGoalRun!({
    goalRunId: "goal-real", conversationId: "conversation", userMessageId: "message",
    rootGoal: "读取项目中的 answer.txt 并原样回答其内容", status: "running", currentStage: "awaiting_verification",
    linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  const orchestrator = coordinator.getGraphOrchestrator();
  const graph = await defaultTraceContext.run({ projectId: projectId, sessionId: "conversation", traceId: "trace-real", goalRunId: "goal-real" }, () =>
    orchestrator.createGraph({
      parentGoal: "读取项目中的 answer.txt 并原样回答其内容", reasoning: "single-node real execution", requiresMultiAgent: true,
      nodes: [{
        nodeId: "read-answer", title: "read answer", goal: "必须调用 bash 工具执行 `cat answer.txt`，然后只回答该文件的完整内容",
        operation: "analyze", dependencies: [], candidateNodeId: "worker-real", candidateProjectId: projectId,
      }],
    }));
  await orchestrator.startGraph(graph.graphId);

  const deadline = Date.now() + 200000;
  let graphRecord = await store.getGraph?.(graph.graphId);
  while (Date.now() < deadline && !["completed", "failed", "cancelled", "partially_completed"].includes(graphRecord!.status)) {
    for (const approval of await store.listPendingApprovals()) {
      await store.resolveApproval(approval.approvalId, "allow-once", "isolated-live-test");
      await coordinator.getScheduler().queueApprovalResolution(approval.approvalId);
    }
    await coordinator.getScheduler().flushOutbox();
    await new Promise(resolve => setTimeout(resolve, 200));
    graphRecord = await store.getGraph?.(graph.graphId);
  }

  const nodeRecord = await store.getGraphNode?.(graph.graphId, "read-answer");
  const task = nodeRecord?.taskId ? await store.getTask?.(nodeRecord.taskId) : undefined;
  assert.equal(graphRecord?.status, "completed", JSON.stringify({ graph: graphRecord?.status, node: nodeRecord?.status, error: nodeRecord?.error, task: task?.status, taskError: task?.error }));
  assert.equal(task?.status, "completed");
  // The sandboxed read actually happened: the answer comes from the file, not from the model.
  assert.match(task?.finalAnswer ?? "", new RegExp(token), `Worker answer did not contain the fixture token: ${task?.finalAnswer}`);

  const goal = await processGoalRun(store, "goal-real");
  assert.equal(goal.status, "completed", JSON.stringify({ checks: goal.reportEvidence?.coverageChecks }));
  assert.equal(goal.reportEvidence?.coverage?.completion, "completed");
  assert.deepEqual(goal.reportEvidence?.coverageChecks?.map(check => [check.graphNodeId, check.status]), [["read-answer", "verified"]]);
  assert.match(goal.finalReport!, /目标已完成/);
});
