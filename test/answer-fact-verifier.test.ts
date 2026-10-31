import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFactCatalog, verifyAnswerFacts, extractAnswerClaims } from "../src/cluster/coordinator/main-agent/answer-facts.js";
import { collectExecutionEvidence } from "../src/cluster/coordinator/main-agent/execution-evidence.js";

/**
 * 真实 E2E 暴露的事实不一致：产物/文件里写的是 1793177600…，最终回答却生成了 1793177811…。
 * 这里用当时真实的数值形态做回归，确保这类断言不会被放行。
 */
const NODE0_START = 1793177600653;
const NODE0_END = 1793177630660;
const NODE1_START = 1793177601272;
const NODE1_END = 1793177631279;

const ARTIFACT_SHA = "7d5f97be1c1a4d3f8b2e6c5a9d0f1e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";

function fixtureCatalog() {
  const evidence = collectExecutionEvidence({
    tasks: [
      {
        taskId: "task-fixture-001",
        kind: "graph_node",
        nodeId: "artifact-fixture-node-a",
        graphId: "graph-fixture-001",
        graphNodeId: "exec-node0",
        outcome: "completed",
        verificationStatus: "verified",
        createdAt: NODE0_START,
        completedAt: NODE0_END,
        artifacts: [
          {
            artifactId: "artifact-fixture-001",
            name: "node0-report",
            sha256: ARTIFACT_SHA,
            sizeBytes: 214,
            producerTaskId: "task-fixture-001",
            producerNodeId: "artifact-fixture-node-a",
            createdAt: NODE0_END,
          },
        ],
      },
    ],
  });
  const toolResults = [
    {
      sourceId: "tool:read_graph_artifact:call-1",
      sourceLabel: "工具 read_graph_artifact 返回",
      artifactId: "artifact-fixture-001",
      text: JSON.stringify({
        content: `node0 start=${NODE0_START} end=${NODE0_END}\nnode1 start=${NODE1_START} end=${NODE1_END}`,
      }),
    },
  ];
  return buildFactCatalog({ evidence, toolResults });
}

test("回归 1：原始时间戳与最终回答不一致时验证器必须拒绝", () => {
  const catalog = fixtureCatalog();
  const result = verifyAnswerFacts("node0 汇报时间戳 1793177811，node1 时间戳 1793177601。", catalog);
  assert.equal(result.verdict, "violations");
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.claim, /1793177811/);
  assert.match(result.violations[0]!.message, /时间戳与真实执行记录不一致/);
  // 期望值必须给出真实记录，供人工核对，而不是只说「错了」。
  assert.match(result.violations[0]!.expected, /1793177\d{5}/);
});

test("回归 2：正确时间戳通过，且不产生误报", () => {
  const catalog = fixtureCatalog();
  const result = verifyAnswerFacts("node0 开始于 1793177600，node1 开始于 1793177601。", catalog);
  assert.equal(result.verdict, "pass", JSON.stringify(result.violations));
  assert.equal(result.violations.length, 0);
});

test("回归 3：合法的时间换算与区间差值通过（秒/毫秒互转、30.007 秒由起止差值得出）", () => {
  const catalog = fixtureCatalog();
  // 毫秒时间戳
  assert.equal(verifyAnswerFacts(`node0 毫秒时间戳 ${NODE0_START}`, catalog).violations.length, 0);
  // 由两个真实时间戳相减得到的时长
  assert.equal(verifyAnswerFacts("node0 执行耗时 30.007 秒。", catalog).violations.length, 0);
  // 毫秒表述的等价时长
  assert.equal(verifyAnswerFacts("node0 执行耗时 30007 ms。", catalog).violations.length, 0);
  // 分钟换算
  assert.equal(verifyAnswerFacts("node0 执行耗时 0.5001 分钟。", catalog).violations.length, 0);
});

test("回归 7：产物哈希正确但正文数字错误时整体不得通过", () => {
  const catalog = fixtureCatalog();
  const goodHashOnly = verifyAnswerFacts(`产物 node0-report 的 SHA-256 为 ${ARTIFACT_SHA}。`, catalog);
  assert.equal(goodHashOnly.violations.length, 0, "正确哈希本身不应被判错");

  const mixed = verifyAnswerFacts(`产物 node0-report 的 SHA-256 为 ${ARTIFACT_SHA}，生成时间 1793177811。`, catalog);
  assert.equal(mixed.verdict, "violations");
  assert.equal(mixed.violations.length, 1);
  assert.match(mixed.violations[0]!.claim, /1793177811/);
});

test("编造的 SHA-256 与不存在的任务标识必须被拒绝", () => {
  const catalog = fixtureCatalog();
  const fakeHash = "0".repeat(64);
  const hashResult = verifyAnswerFacts(`产物哈希 ${fakeHash}`, catalog);
  assert.equal(hashResult.verdict, "violations");

  const idResult = verifyAnswerFacts("详见 task-deadbeef 的执行记录。", catalog);
  assert.equal(idResult.verdict, "violations");
  assert.match(idResult.violations[0]!.expected, /task-fixture-001/);
});

test("没有执行证据时不误判：not_applicable 而不是失败", () => {
  const catalog = buildFactCatalog({ evidence: collectExecutionEvidence({ tasks: [] }) });
  const result = verifyAnswerFacts("这是一段普通回答，提到 1793177811。", catalog);
  assert.equal(result.verdict, "not_applicable");
});

test("断言抽取覆盖六类可核验事实", () => {
  const claims = extractAnswerClaims(
    `节点 3 个，任务 5 个，产物 2 个，大小 214 bytes，耗时 274.1 秒，哈希 ${ARTIFACT_SHA}，任务 task-2c654b9e。`
  );
  const kinds = new Set(claims.map((claim) => claim.kind));
  assert.ok(kinds.has("count"));
  assert.ok(kinds.has("bytes"));
  assert.ok(kinds.has("duration"));
  assert.ok(kinds.has("sha256"));
  assert.ok(kinds.has("identifier"));
});

test("寒暄级短时长不参与核验，避免误报", () => {
  const catalog = fixtureCatalog();
  const result = verifyAnswerFacts("几秒钟后重试即可，大约 3 秒。", catalog);
  assert.equal(result.violations.length, 0);
});
