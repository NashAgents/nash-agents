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
import { GraphReplanner } from "../src/cluster/graph/graph-replanner.js";

// Real local Worker runtimes, WebSockets and native AgentLoop; the model is simulated.
test("SIMULATED_MODEL + LOCAL_WORKERS: three workers recover a graph and keep a background Scout on its GoalRun", { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-goal-workers-"));
  const oldKey = process.env.DEEPSEEK_API_KEY, oldHome = process.env.NASH_HOME, oldUrl = process.env.DEEPSEEK_BASE_URL, oldFormat = process.env.DEEPSEEK_API_FORMAT, oldFetch = globalThis.fetch;
  process.env.NASH_HOME = path.join(root, "home");
  process.env.DEEPSEEK_API_KEY = randomBytes(24).toString("hex");
  process.env.DEEPSEEK_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.DEEPSEEK_API_FORMAT = "completions";
  let release!: () => void;
  const waitForScout = new Promise<void>(resolve => { release = resolve; });
  let scoutStarted!: () => void;
  const scoutEntered = new Promise<void>(resolve => { scoutStarted = resolve; });
  let firstSourceTask: string | undefined;
  globalThis.fetch = async (input, init) => {
    if (!String(input).includes("/chat/completions")) return oldFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const transcript = JSON.stringify(body.messages ?? []);
    const plain = (body.messages ?? []).map((message: any) => typeof message.content === "string" ? message.content : "").join("\n");
    const sourceTask = plain.match(/"taskId":"(task-[^"]+)"/)?.[1];
    if (plain.includes("source-recovery-sentinel") && sourceTask) {
      firstSourceTask ??= sourceTask;
      if (sourceTask === firstSourceTask) return new Response(JSON.stringify({ error: { message: "controlled failure" } }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    const scout = transcript.includes("scout-background-sentinel");
    const submitted = transcript.includes("scout-submit-test");
    if (scout && !submitted) { scoutStarted(); await waitForScout; }
    const message = plain.includes("source-recovery-sentinel") && !transcript.includes("graph-publish-test")
      ? { role: "assistant", content: null, tool_calls: [{ id: "graph-publish-test", type: "function", function: { name: "publish_artifact", arguments: JSON.stringify({ name: "result.md", content: "verified fixture" }) } }] }
      : plain.includes("join-recovery-sentinel") && !transcript.includes("graph-read-test")
        ? { role: "assistant", content: null, tool_calls: [{ id: "graph-read-test", type: "function", function: { name: "read_graph_artifact", arguments: JSON.stringify({ name: "result.md", producerNodeId: "source" }) } }] }
      : scout && !submitted
      ? { role: "assistant", content: null, tool_calls: [{ id: "scout-submit-test", type: "function", function: { name: "submit_discovery_report", arguments: JSON.stringify({ candidates: [], summary: "Limited inspection" }) } }] }
      : { role: "assistant", content: "Controlled model response" };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    return new Response(JSON.stringify({ choices: [{ message }], usage }), { headers: { "Content-Type": "application/json" } });
  };
  const coordinator = new ClusterCoordinator({ ephemeral: true, customDir: path.join(root, "coordinator"), listenHost: "127.0.0.1", listenPort: 0 });
  const workers: WorkerRuntime[] = [];
  t.after(async () => {
    release();
    try { await Promise.allSettled(workers.map(worker => worker.stop())); await coordinator.stop(); }
    finally {
      globalThis.fetch = oldFetch;
      for (const [key, value] of [["DEEPSEEK_API_KEY", oldKey], ["NASH_HOME", oldHome], ["DEEPSEEK_BASE_URL", oldUrl], ["DEEPSEEK_API_FORMAT", oldFormat]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  const { port } = await coordinator.start(), store = coordinator.getStore();
  const projects: string[] = [];
  for (let index = 0; index < 3; index++) {
    const project = path.join(root, `project-${index}`); fs.mkdirSync(project); fs.writeFileSync(path.join(project, "README.md"), "isolated fixture");
    const worker = new WorkerRuntime({ coordinatorUrl: `ws://127.0.0.1:${port}/ws/cluster`, inviteCode: coordinator.getInviteManager().createInvite({ role: "worker", maxUses: 1 }).inviteCode, customDir: path.join(root, `worker-${index}`), nodeId: `worker-${index}` });
    workers.push(worker); projects.push(worker.projects.registerProject(project, `project-${index}`).projectId); await worker.start();
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const ready = await Promise.all(workers.map(async (_, index) => {
      const nodeId = `worker-${index}`, node = await store.getNode(nodeId), revision = await store.getCatalogRevision(nodeId);
      const capability = revision?.capabilities.find(item => item.category === "sandbox");
      const project = (await store.listProjectsCatalog({ nodeId })).some(item => item.projectId === projects[index]);
      return Boolean(node && project && capability && coordinator.getRegistry().getConnection(nodeId) && !validateSandboxRequirements(node.platform, capability, "read-only", "deny"));
    }));
    if (ready.every(Boolean)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (let index = 0; index < 3; index++) {
    const nodeId = `worker-${index}`, node = await store.getNode(nodeId), revision = await store.getCatalogRevision(nodeId);
    assert.ok(node && revision?.capabilities.some(item => item.category === "sandbox" && !validateSandboxRequirements(node.platform, item, "read-only", "deny")), `Worker ${nodeId} lacks a verified sandbox`);
    assert.ok((await store.listProjectsCatalog({ nodeId })).some(item => item.projectId === projects[index]));
  }
  await store.createGoalRun!({ goalRunId: "goal-local-workers", conversationId: "conversation", userMessageId: "message", rootGoal: "inspect", status: "running", currentStage: "awaiting_verification", linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null, reportRevision: 0, revision: 1, createdAt: Date.now(), updatedAt: Date.now() });
  const tasks = await defaultTraceContext.run({ projectId: "p", sessionId: "conversation", traceId: "trace", goalRunId: "goal-local-workers" }, () => Promise.all(workers.map((_, index) => coordinator.getScheduler().createTask({ nodeId: `worker-${index}`, projectId: projects[index]!, goal: index === 2 ? "scout-background-sentinel" : "inspect", contextOverrides: index === 2 ? { isDiscovery: true, readOnly: true } : { readOnly: true } }))));
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([scoutEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Scout did not reach model")), 10000); })]); }
  finally { clearTimeout(timer); }
  assert.equal((await processGoalRun(store, "goal-local-workers")).status, "running");
  assert.equal((await store.getGoalRun!("goal-local-workers"))?.finalReport, undefined);
  const orchestrator = coordinator.getGraphOrchestrator();
  const graph = await defaultTraceContext.run({ projectId: "p", sessionId: "conversation", traceId: "trace", goalRunId: "goal-local-workers" }, () => orchestrator.createGraph({ parentGoal: "inspect and join", reasoning: "controlled recovery", requiresMultiAgent: true, nodes: [
    { nodeId: "source", title: "source", goal: "source-recovery-sentinel", operation: "analyze", dependencies: [], candidateNodeId: "worker-1", candidateProjectId: projects[1], producedArtifacts: [{ name: "result.md", contentType: "text/markdown" }], acceptanceCriteria: [{ type: "artifact_exists", expected: "result.md", description: "report" }] },
    { nodeId: "join", title: "join", goal: "join-recovery-sentinel", operation: "analyze", dependencies: ["source"], candidateNodeId: "worker-0", candidateProjectId: projects[0], requiredArtifacts: [{ name: "result.md", producerNodeId: "source" }] },
  ] }));
  await orchestrator.startGraph(graph.graphId);
  const failedDeadline = Date.now() + 12000;
  while (Date.now() < failedDeadline && (await store.getGraphNode?.(graph.graphId, "source"))?.status !== "failed") await new Promise(resolve => setTimeout(resolve, 50));
  const failed = await store.getGraphNode?.(graph.graphId, "source");
  assert.equal(failed?.status, "failed");
  const prompts: string[] = [];
  const replanner = new GraphReplanner(store, orchestrator, { chat: async (messages: any[]) => {
    prompts.push(messages[1].content);
    return { content: JSON.stringify(prompts.length === 1 ? { reason: "invalid", rewireDependencies: [{ nodeId: "join", removeDependencies: ["source"] }] } : { reason: "retry", retryNodeIds: ["source"] }) };
  } } as any);
  assert.equal((await replanner.replanWithLlm({ graphId: graph.graphId, trigger: "task_failed", failedNodeId: "source" })).success, true);
  const graphDeadline = Date.now() + 15000;
  while (Date.now() < graphDeadline && (await store.getGraph?.(graph.graphId))?.status !== "completed") {
    for (const approval of await store.listPendingApprovals()) {
      const task = await store.getTask(approval.taskId);
      assert.equal(task?.dispatchOptions?.graphContext?.graphId, graph.graphId);
      await store.resolveApproval(approval.approvalId, "allow-once", "isolated-test-user");
      await coordinator.getScheduler().queueApprovalResolution(approval.approvalId);
    }
    await coordinator.getScheduler().flushOutbox();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const finalGraph = await store.getGraph?.(graph.graphId);
  assert.equal(finalGraph?.status, "completed", JSON.stringify({ graph: finalGraph?.status, nodes: (await store.listGraphNodes?.(graph.graphId))?.map(node => ({ id: node.nodeId, status: node.status, error: node.error, taskId: node.taskId })), tasks: (await store.listTasks()).map(task => ({ id: task.taskId, status: task.status, error: task.error })), events: (await store.listGraphEvents?.(graph.graphId))?.slice(-5) }));
  const attempts = await store.listGraphTaskAttempts!(graph.graphId, "source");
  assert.deepEqual(attempts.map(task => task.status), ["failed", "completed"]);
  assert.equal(attempts[1]?.dispatchOptions?.graphContext?.retryOfTaskId, attempts[0]?.taskId);
  assert.equal((await store.listArtifacts!(graph.graphId)).length, 1);
  assert.equal((await store.listGraphEvents!(graph.graphId)).filter(event => event.eventType === "graph.replan_rejected").length, 1);
  assert.equal((await processGoalRun(store, "goal-local-workers")).status, "running");
  assert.equal((await store.getGoalRun!("goal-local-workers"))?.finalReport, undefined);
  release();
  const finishDeadline = Date.now() + 12000;
  while (Date.now() < finishDeadline && !(await Promise.all(tasks.map(task => store.getTask(task.taskId)))).every(task => task?.status === "completed")) await new Promise(resolve => setTimeout(resolve, 50));
  const results = await Promise.all(tasks.map(task => store.getTask(task.taskId)));
  assert.deepEqual(results.map(task => task?.status), ["completed", "completed", "completed"]);
  const reportDeadline = Date.now() + 12000;
  while (Date.now() < reportDeadline && !(await store.getGoalRun!("goal-local-workers"))?.finalReport) await new Promise(resolve => setTimeout(resolve, 50));
  const revised = (await store.getGoalRun!("goal-local-workers"))!;
  assert.equal(revised.status, "partially_completed");
  assert.equal(revised.linkedGraphIds.length, 1);
  assert.equal(revised.linkedTaskIds.length, 6);
  assert.deepEqual(revised.reportEvidence?.scoutEvents?.map(event => event.taskId), [tasks[2]!.taskId]);
  assert.equal(revised.reportRevision, 1);
  assert.equal((await processGoalRun(store, "goal-local-workers")).reportRevision, revised.reportRevision);
});
