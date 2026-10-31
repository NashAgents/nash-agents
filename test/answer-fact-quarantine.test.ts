import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFactCatalog,
  buildQuarantineSection,
  sanitizeAnswerFacts,
  verifyAnswerFacts,
} from "../src/cluster/coordinator/main-agent/answer-facts.js";
import { collectExecutionEvidence } from "../src/cluster/coordinator/main-agent/execution-evidence.js";

/**
 * 已被执行证据确定性证伪的断言不得继续作为正常正文展示。
 * 这里用固定的虚构 Fixture 校验「移除 + 隔离」的确定性行为。
 */

const START = 1793177600653;
const END = 1793177630660;
const REAL_SECONDS = "1793177600";
const FABRICATED = "1793177811";
const SHA = "7d5f97be1c1a4d3f8b2e6c5a9d0f1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";

function catalog() {
  const evidence = collectExecutionEvidence({
    tasks: [{
      taskId: "task-fixture-quarantine",
      kind: "graph_node",
      nodeId: "artifact-fixture-node-a",
      graphId: "graph-fixture-quarantine",
      graphNodeId: "exec-alpha",
      outcome: "completed",
      verificationStatus: "verified",
      createdAt: START,
      completedAt: END,
      artifacts: [{
        artifactId: "artifact-fixture-quarantine",
        name: "alpha-report",
        sha256: SHA,
        sizeBytes: 214,
        producerTaskId: "task-fixture-quarantine",
        producerNodeId: "artifact-fixture-node-a",
        createdAt: END,
      }],
    }],
  });
  return buildFactCatalog({ evidence, toolResults: [] });
}

test("被证伪的数字从正文移除，同一段落里的有效内容保留", () => {
  const answer = `分析已完成。真实开始时间是 ${REAL_SECONDS}。生成时间 ${FABRICATED}。结论：磁盘使用正常。`;
  const check = verifyAnswerFacts(answer, catalog());
  assert.equal(check.violations.length, 1);

  const { sanitized, quarantined } = sanitizeAnswerFacts(answer, check);
  assert.equal(sanitized.includes(FABRICATED), false, "冲突断言不得留在正文");
  assert.equal(sanitized.includes(REAL_SECONDS), true, "正确断言必须保留");
  assert.match(sanitized, /结论：磁盘使用正常/, "同段落的有效结论必须保留");
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0]!.claim.includes(FABRICATED), true);
  assert.equal(verifyAnswerFacts(sanitized, catalog()).violations.length, 0, "净化后必须通过核验");
});

test("表格行中的冲突数字整行移除，其他行不受影响", () => {
  const answer = [
    "| 节点 | 开始时间 |",
    "| --- | --- |",
    `| alpha | ${REAL_SECONDS} |`,
    `| beta | ${FABRICATED} |`,
  ].join("\n");
  const check = verifyAnswerFacts(answer, catalog());
  assert.equal(check.violations.length, 1);

  const { sanitized, quarantined } = sanitizeAnswerFacts(answer, check);
  assert.equal(sanitized.includes(FABRICATED), false);
  assert.equal(sanitized.includes(REAL_SECONDS), true);
  assert.match(sanitized, /\| 节点 \| 开始时间 \|/);
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0]!.segment, /beta/);
});

test("隔离说明同时给出真实值与原文片段，便于人工复核", () => {
  const answer = `报告生成时间 ${FABRICATED}。`;
  const check = verifyAnswerFacts(answer, catalog());
  const { quarantined } = sanitizeAnswerFacts(answer, check);
  const section = buildQuarantineSection(quarantined, check.unverifiable);
  assert.ok(section);
  assert.match(section!, /未通过核验/);
  assert.match(section!, /真实值/);
  assert.match(section!, new RegExp(FABRICATED));
  assert.match(section!, /原文片段/);
});

test("整篇断言都被证伪时正文为空，交给调用方给出明确占位", () => {
  const answer = `生成时间 ${FABRICATED}。`;
  const check = verifyAnswerFacts(answer, catalog());
  const { sanitized } = sanitizeAnswerFacts(answer, check);
  assert.equal(sanitized, "");
});

test("没有冲突时净化是恒等变换，不触碰正文", () => {
  const answer = `开始时间 ${REAL_SECONDS}，产物 alpha-report 的 SHA-256 为 ${SHA}。`;
  const check = verifyAnswerFacts(answer, catalog());
  assert.equal(check.violations.length, 0);
  const { sanitized, quarantined } = sanitizeAnswerFacts(answer, check);
  assert.equal(sanitized, answer);
  assert.equal(quarantined.length, 0);
});

test("正文里已找不到原文的冲突断言也必须留痕，不能悄悄消失", () => {
  const answer = "分析已完成。";
  const check = verifyAnswerFacts(answer, catalog());
  const quarantined = sanitizeAnswerFacts(answer, {
    ...check,
    violations: [{
      claim: FABRICATED, kind: "epoch", claimed: FABRICATED,
      expected: "真实记录", source: "execution_records", message: "时间戳与真实执行记录不一致。",
    }],
  });
  assert.equal(quarantined.quarantined.length, 1);
  assert.equal(quarantined.quarantined[0]!.segment, "");
  assert.equal(quarantined.sanitized, answer);
});
