import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAnswerEvidence, annotateAnswer } from "../src/cluster/coordinator/main-agent/answer-evidence.js";

test("全部节点完成时放行，不附加任何范围说明", () => {
  const guard = evaluateAnswerEvidence({
    goalEvaluation: { completionStatus: "completed", completedNodeIds: ["n1", "n2"] },
    nodeResults: [{ nodeId: "n1", status: "completed" }, { nodeId: "n2", status: "completed" }],
  });
  assert.equal(guard.verdict, "pass");
  assert.deepEqual(guard.inconclusiveNodeIds, []);
  assert.equal(guard.annotation, undefined);
});

test("一个节点超时不得被当成已完成：回答必须标注范围缺口", () => {
  const guard = evaluateAnswerEvidence({
    scoutEvidence: {
      nodeReports: [
        { nodeId: "node-a", outcome: "completed" },
        { nodeId: "node-b", outcome: "timed_out" },
      ],
      inconclusiveNodeIds: ["node-b"],
    },
  });
  assert.equal(guard.verdict, "partial");
  assert.deepEqual(guard.completedNodeIds, ["node-a"]);
  assert.deepEqual(guard.inconclusiveNodeIds, ["node-b"]);
  assert.ok(guard.annotation);
  assert.match(guard.annotation!, /未得出结论/);
  assert.match(guard.annotation!, /node-b/);
  assert.match(guard.annotation!, /不得表述为/);

  const annotated = annotateAnswer("未发现知识库项目。", guard);
  assert.ok(annotated.startsWith("【证据范围（确定性校验）】"), "annotation must be prepended");
  assert.ok(annotated.includes("未发现知识库项目。"), "model text is preserved, not rewritten");
});

test("没有任何节点得出结论时判定为 unknown", () => {
  const guard = evaluateAnswerEvidence({
    nodeResults: [{ nodeId: "n1", status: "failed" }, { nodeId: "n2", status: "blocked" }],
  });
  assert.equal(guard.verdict, "unknown");
  assert.deepEqual(guard.completedNodeIds, []);
  assert.deepEqual(guard.inconclusiveNodeIds.sort(), ["n1", "n2"]);
});

test("任务图未建立时不得声称目标已完成", () => {
  const guard = evaluateAnswerEvidence({ graphExecutionAttempted: true, graphCreated: false });
  assert.equal(guard.verdict, "unknown");
  assert.ok(guard.annotation);
  assert.match(guard.annotation!, /任务图未建立/);
});

test("探查范围不成立（无在线节点 / 已知节点离线）时判定为 unknown", () => {
  const guard = evaluateAnswerEvidence({ scoutEvidence: { scopeStatus: "no_online_nodes" } });
  assert.equal(guard.verdict, "unknown");
  assert.match(guard.annotation!, /未执行有效节点扫描/);

  const offline = evaluateAnswerEvidence({ scoutEvidence: { scopeStatus: "known_nodes_offline" } });
  assert.equal(offline.verdict, "unknown");
});

test("已完成节点优先：同一节点既报完成又出现在缺口列表时不重复计入缺口", () => {
  const guard = evaluateAnswerEvidence({
    goalEvaluation: { completedNodeIds: ["n1"], pendingNodeIds: ["n1"] },
  });
  assert.equal(guard.verdict, "pass");
  assert.deepEqual(guard.inconclusiveNodeIds, []);
});

test("没有执行证据时不干扰回答", () => {
  const guard = evaluateAnswerEvidence({});
  assert.equal(guard.verdict, "pass");
  assert.equal(annotateAnswer("普通回答", guard), "普通回答");
});
