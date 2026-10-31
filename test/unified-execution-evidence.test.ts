import { test } from "node:test";
import assert from "node:assert/strict";
import { collectExecutionEvidence, outcomeFromTaskStatus } from "../src/cluster/coordinator/main-agent/execution-evidence.js";
import { evaluateEvidenceSet, annotateAnswer } from "../src/cluster/coordinator/main-agent/answer-evidence.js";

/**
 * 统一执行证据集合回归：
 * 早先闸门只读「当前任务图 + Scout」，导致同一轮内真实成功的普通任务被漏出已完成范围
 * （输出「已完成：（无）」），也让「部分任务未执行」有机会被说成全集群完成。
 */

test("回归 4：普通 Task 成功且没有 DAG 时，必须计入已完成范围", () => {
  const set = collectExecutionEvidence({
    tasks: [{ taskId: "task-plain-1", kind: "plain_task", nodeId: "node-a", outcome: "completed", verificationStatus: "verified" }],
    onlineNodeIds: ["node-a"],
  });
  assert.deepEqual(set.completedTaskIds, ["task-plain-1"]);

  const guard = evaluateEvidenceSet(set);
  assert.equal(guard.verdict, "pass");
  assert.deepEqual(guard.completedNodeIds, ["task-plain-1"]);
  assert.equal(guard.annotation, undefined);
  assert.equal(guard.coverage?.completedTasks, 1);
  assert.ok(guard.coverage?.kinds.includes("plain_task"));
});

test("回归 5：Scout 成功 + 普通 Task 失败，必须准确区分而不是一锅端", () => {
  const set = collectExecutionEvidence({
    tasks: [
      { taskId: "task-scout-1", kind: "scout", nodeId: "node-a", outcome: "completed", verificationStatus: "verified" },
      { taskId: "task-plain-2", kind: "plain_task", nodeId: "node-b", outcome: "failed", detail: "tool failed" },
    ],
    onlineNodeIds: ["node-a", "node-b"],
  });
  const guard = evaluateEvidenceSet(set);
  assert.equal(guard.verdict, "partial");
  assert.deepEqual(guard.completedNodeIds.sort(), ["node-a"]);
  assert.deepEqual(guard.inconclusiveNodeIds.sort(), ["task-plain-2"]);
  assert.match(guard.annotation!, /task-plain-2/);
  assert.match(guard.annotation!, /不得表述为/);
});

test("回归 6：部分任务未执行时不得声称全集群完成", () => {
  const set = collectExecutionEvidence({
    tasks: [
      { taskId: "task-done", kind: "graph_node", graphNodeId: "n1", nodeId: "node-a", outcome: "completed" },
      { taskId: "task-waiting", kind: "graph_node", graphNodeId: "n2", nodeId: "node-b", outcome: "pending" },
      { taskId: "task-never", kind: "graph_node", graphNodeId: "n3", nodeId: "node-c", outcome: "unknown" },
    ],
    graph: { graphId: "graph-x", completionStatus: "partially_completed" },
    onlineNodeIds: ["node-a", "node-b", "node-c"],
  });
  const guard = evaluateEvidenceSet(set);
  assert.equal(guard.verdict, "partial");
  assert.deepEqual(guard.completedNodeIds, ["n1"]);
  assert.deepEqual(guard.inconclusiveNodeIds.sort(), ["n2", "n3"]);
  assert.match(guard.annotation!, /目标状态：partially_completed/);
  // 回答原文不被改写，只前置确定性说明。
  const annotated = annotateAnswer("三个节点全部完成，集群状态一致。", guard);
  assert.ok(annotated.startsWith("【证据范围（确定性校验）】"));
  assert.ok(annotated.includes("三个节点全部完成，集群状态一致。"));
});

test("回归 8：已完成任务的证据不因其他节点失败而丢失", () => {
  const set = collectExecutionEvidence({
    tasks: [
      { taskId: "task-ok-1", kind: "graph_node", graphNodeId: "n1", nodeId: "node-a", outcome: "completed" },
      { taskId: "task-ok-2", kind: "plain_task", nodeId: "node-a", outcome: "completed" },
      { taskId: "task-bad", kind: "graph_node", graphNodeId: "n2", nodeId: "node-b", outcome: "failed" },
    ],
    onlineNodeIds: ["node-a", "node-b"],
  });
  const guard = evaluateEvidenceSet(set);
  assert.deepEqual(guard.completedNodeIds.sort(), ["n1", "task-ok-2"]);
  assert.deepEqual(guard.inconclusiveNodeIds, ["n2"]);
  // 同一 Worker 上的两次成功不得因为别的节点失败而被抹掉。
  const workerA = set.workers.find((worker) => worker.nodeId === "node-a");
  assert.deepEqual(workerA?.completedTaskIds.sort(), ["task-ok-1", "task-ok-2"]);
});

test("Artifact 证据不冒充节点结论，但会作为独立证据条目录入", () => {
  const set = collectExecutionEvidence({
    tasks: [{
      taskId: "task-art",
      kind: "graph_node",
      graphNodeId: "n1",
      nodeId: "node-a",
      outcome: "failed",
      artifacts: [{ artifactId: "art-1", name: "report", sha256: "a".repeat(64), sizeBytes: 10, producerTaskId: "task-art" }],
    }],
  });
  const guard = evaluateEvidenceSet(set);
  assert.equal(guard.verdict, "unknown");
  assert.deepEqual(guard.completedNodeIds, [], "产物本身不能把失败节点变成已完成");
  assert.equal(set.artifacts.length, 1);
  assert.ok(set.entries.some((entry) => entry.kind === "artifact" && entry.sourceArtifact?.artifactId === "art-1"));
});

test("Outcome Unknown 一律收敛为未得出结论，绝不乐观推断", () => {
  assert.equal(outcomeFromTaskStatus("outcome_unknown"), "unknown");
  assert.equal(outcomeFromTaskStatus("running"), "pending");
  assert.equal(outcomeFromTaskStatus("cancelled"), "failed");
  assert.equal(outcomeFromTaskStatus("completed"), "completed");
  assert.equal(outcomeFromTaskStatus(undefined), "unknown");

  const set = collectExecutionEvidence({
    tasks: [{ taskId: "task-u", kind: "plain_task", nodeId: "node-a", outcome: outcomeFromTaskStatus("outcome_unknown") }],
  });
  assert.equal(evaluateEvidenceSet(set).verdict, "unknown");
});

test("轮次级事实：尝试建图但未建成时目标视为未执行", () => {
  const set = collectExecutionEvidence({ tasks: [], turn: { graphExecutionAttempted: true, graphCreated: false } });
  const guard = evaluateEvidenceSet(set);
  assert.equal(guard.verdict, "unknown");
  assert.match(guard.annotation!, /任务图未建立/);
});

test("空证据集合不干扰普通回答", () => {
  const guard = evaluateEvidenceSet(collectExecutionEvidence({}));
  assert.equal(guard.verdict, "pass");
  assert.equal(annotateAnswer("普通回答", guard), "普通回答");
});
