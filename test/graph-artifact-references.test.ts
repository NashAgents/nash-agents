import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { DagValidator } from "../src/cluster/graph/dag-validator.js";
import { WorkerGraphArtifacts } from "../src/cluster/worker/graph-artifacts.js";
import { completeSimulatedTask } from "./helpers/runtime-truth-fixtures.js";
import type { CreateTaskOptions } from "../src/cluster/coordinator/task-scheduler.js";
import { createHash } from "node:crypto";
import type { GraphProposalNode } from "../src/cluster/graph/types.js";
import type { GraphTaskContext } from "../src/cluster/protocol/types.js";

/**
 * 确定性产物引用：artifactId 唯一优先，其次 name + producerNodeId / producerTaskId。
 * 同名产物绝不自动取第一条或最后一条 —— 缺失与歧义都必须是结构化错误。
 * SIMULATED_INTEGRATION：真实 Orchestrator + 真实 ArtifactService + 模拟 Worker 传输。
 */

const SUMMARY = "summary-results";

function threeProducers(): GraphTaskContext["inputs"] {
  return ["alpha", "beta", "gamma"].map((name, index) => {
    const content = JSON.stringify({ producer: name });
    return {
      artifactId: `artifact-fixture-${name}`,
      name: SUMMARY,
      contentType: "application/json",
      content,
      producerNodeId: `task_summarize_${name}`,
      producerTaskId: `task-fixture-${index}`,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

function context(inputs = threeProducers(), outputs = [{ name: "join-report.md", contentType: "text/markdown" }]): GraphTaskContext {
  return { graphId: "graph-fixture-refs", graphRevision: 1, graphNodeId: "task_join", inputs, outputs };
}

function readTool(ctx: GraphTaskContext) {
  return new WorkerGraphArtifacts(ctx).tools().find((tool) => tool.name === "read_graph_artifact")!;
}

test("artifactId 是唯一首选定位，同名也不影响", () => {
  const read = readTool(context());
  const result = read.execute({ artifactId: "artifact-fixture-beta" }) as any;
  assert.equal(result.success, true);
  assert.equal(result.producerNodeId, "task_summarize_beta");
  assert.deepEqual(JSON.parse(result.content), { producer: "beta" });
});

test("name + producerNodeId 与 name + producerTaskId 都能唯一定位", () => {
  const read = readTool(context());
  const byNode = read.execute({ name: SUMMARY, producerNodeId: "task_summarize_gamma" }) as any;
  assert.equal(byNode.producerTaskId, "task-fixture-2");
  const byTask = read.execute({ name: SUMMARY, producerTaskId: "task-fixture-0" }) as any;
  assert.equal(byTask.producerNodeId, "task_summarize_alpha");
});

test("只给同名 name 时必须返回结构化歧义与全部候选，不能自动挑一个", () => {
  const read = readTool(context());
  const result = read.execute({ name: SUMMARY }) as any;
  assert.equal(result.success, false);
  assert.equal(result.code, "ARTIFACT_AMBIGUOUS");
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(
    result.candidates.map((item: any) => item.artifactId).sort(),
    ["artifact-fixture-alpha", "artifact-fixture-beta", "artifact-fixture-gamma"]
  );
  assert.equal(result.content, undefined, "歧义时绝不能返回任何一个候选的内容");
});

test("未知引用返回 ARTIFACT_NOT_FOUND 并列出可用产物", () => {
  const read = readTool(context());
  const result = read.execute({ artifactId: "artifact-fixture-missing" }) as any;
  assert.equal(result.success, false);
  assert.equal(result.code, "ARTIFACT_NOT_FOUND");
  assert.equal(result.available.length, 3);
  const byNode = read.execute({ name: SUMMARY, producerNodeId: "task_absent" }) as any;
  assert.equal(byNode.code, "ARTIFACT_NOT_FOUND");
});

test("既没 artifactId 也没 name 时要求显式引用", () => {
  const read = readTool(context());
  const result = read.execute({}) as any;
  assert.equal(result.success, false);
  assert.equal(result.code, "ARTIFACT_REFERENCE_REQUIRED");
});

test("Join 未声明上游产物引用时 DAG 校验拒绝", () => {
  const producer = (id: string): GraphProposalNode => ({
    nodeId: id, title: id, goal: id, operation: "analyze", dependencies: [],
    producedArtifacts: [{ name: SUMMARY, contentType: "application/json" }],
  });
  const join: GraphProposalNode = {
    nodeId: "join", title: "join", goal: "join", operation: "synthesize",
    dependencies: ["a", "b", "c"], dependencyType: "join",
    requiredArtifacts: [
      { name: SUMMARY, producerNodeId: "a" },
      { name: SUMMARY, producerNodeId: "b" },
    ],
  };
  const result = DagValidator.validateProposal([producer("a"), producer("b"), producer("c"), join]);
  assert.equal(result.valid, false);
  assert.match(String(result.reason), /Join node 'join' depends on 'c'/);
});

test("SIMULATED_INTEGRATION: 三个节点各自产出同名 summary-results，Join 读取全部三份", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nash-artifact-refs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new InMemoryClusterStore();
  const artifacts = new ArtifactService(store, directory);
  const sent: CreateTaskOptions[] = [];
  const scheduler = { createTask: async (options: CreateTaskOptions) => {
    const task = { taskId: `task-fixture-${sent.length}`, nodeId: options.nodeId, projectId: options.projectId, runId: "simulation", dispatchOptions: { graphContext: options.graphContext }, goal: options.goal, status: "running" as const, dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    sent.push(options); await options.beforeDispatch?.(task); await store.saveTask(task); return task;
  } };
  const validator = { validateCandidate: async () => ({ valid: true, code: "VALID" as const, reason: "test fixture" }) };
  const orchestrator = new DistributedGraphOrchestrator({ store, scheduler: scheduler as any, validator, artifactService: artifacts });

  const branch = (id: string, worker: string): GraphProposalNode => ({
    nodeId: id, title: id, goal: `${id} summary`, operation: "analyze",
    candidateNodeId: worker, candidateProjectId: `project-${worker}`, dependencies: [],
    producedArtifacts: [{ name: SUMMARY, contentType: "application/json" }],
    acceptanceCriteria: [{ type: "artifact_exists", expected: SUMMARY, description: "summary published" }],
  });
  const join: GraphProposalNode = {
    nodeId: "task_join", title: "join", goal: "join all summaries", operation: "synthesize",
    candidateNodeId: "worker-a", candidateProjectId: "project-worker-a",
    dependencies: ["task_summary_alpha", "task_summary_beta", "task_summary_gamma"],
    dependencyType: "join",
    requiredArtifacts: [
      { name: SUMMARY, producerNodeId: "task_summary_alpha" },
      { name: SUMMARY, producerNodeId: "task_summary_beta" },
      { name: SUMMARY, producerNodeId: "task_summary_gamma" },
    ],
    producedArtifacts: [{ name: "join-report.md", contentType: "text/markdown" }],
    acceptanceCriteria: [{ type: "artifact_exists", expected: "join-report.md", description: "join report published" }],
  };

  const graph = await orchestrator.createGraph({
    reasoning: "fixture", requiresMultiAgent: true, parentGoal: "three branch join",
    nodes: [branch("task_summary_alpha", "worker-a"), branch("task_summary_beta", "worker-b"), branch("task_summary_gamma", "worker-c"), join],
  });
  await orchestrator.startGraph(graph.graphId);
  assert.equal(sent.length, 3, "三个上游分支必须在任何完成之前全部派发");

  for (const [index, name] of ["alpha", "beta", "gamma"].entries()) {
    const worker = new WorkerGraphArtifacts(sent[index]!.graphContext!);
    worker.publish(SUMMARY, JSON.stringify({ producer: name }));
    const taskId = (await store.getGraphNode(graph.graphId, `task_summary_${name}`))!.taskId!;
    await completeSimulatedTask(store, orchestrator, graph.graphId, taskId, `${name} done`, worker.finish(`${name} done`));
  }

  assert.equal(sent.length, 4, "三个分支全部完成后才派发 Join");
  const joinContext = sent[3]!.graphContext!;
  assert.equal(joinContext.inputs.length, 3);
  assert.deepEqual(new Set(joinContext.inputs.map((item) => item.name)), new Set([SUMMARY]));
  assert.equal(new Set(joinContext.inputs.map((item) => item.artifactId)).size, 3);
  assert.equal(new Set(joinContext.inputs.map((item) => item.producerNodeId)).size, 3);
  assert.equal(new Set(joinContext.inputs.map((item) => item.producerTaskId)).size, 3);

  const read = readTool(joinContext);
  const contents = new Set<string>();
  for (const input of joinContext.inputs) {
    const result = read.execute({ artifactId: input.artifactId }) as any;
    assert.equal(result.success, true);
    contents.add(result.content);
  }
  assert.deepEqual(
    [...contents].map((content) => JSON.parse(content).producer).sort(),
    ["alpha", "beta", "gamma"]
  );
  // 只给同名 name 时必须要求进一步限定，而不是替模型猜一份。
  assert.equal((read.execute({ name: SUMMARY }) as any).code, "ARTIFACT_AMBIGUOUS");

  const joinTaskId = (await store.getGraphNode(graph.graphId, "task_join"))!.taskId!;
  const joinWorker = new WorkerGraphArtifacts(joinContext);
  joinWorker.publish("join-report.md", "# joined all three summaries");
  await completeSimulatedTask(store, orchestrator, graph.graphId, joinTaskId, "joined", joinWorker.finish("joined"));
  assert.equal((await store.getGraph(graph.graphId))!.status, "completed");
});
