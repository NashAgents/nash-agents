import { simulatedCapabilities, simulatedSandbox } from "./helpers/runtime-truth-fixtures.js";
/**
 * Nash Cluster Phase 4: Integration & Multi-Process API Tests
 * 启动真实 Coordinator HTTP & WSS 实例，验证 REST API、SSE 流与控制指令
 */

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

function fetchJson(urlStr: string, options: { method?: string; body?: any } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe("Nash Cluster Phase 4: Multi-Process & REST API Integration", () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;

  const nodes = [
    { nodeId: "A", title: "inspect A", goal: "inspect", operation: "analyze", candidateNodeId: "test-worker", candidateProjectId: "test-project", dependencies: [] },
    { nodeId: "B", title: "inspect B", goal: "inspect", operation: "analyze", candidateNodeId: "test-worker", candidateProjectId: "test-project", dependencies: [] },
    { nodeId: "C", title: "summarize", goal: "summarize", operation: "execute", candidateNodeId: "test-worker", candidateProjectId: "test-project", dependencies: ["A", "B"] },
  ];

  before(async () => {
    coordinator = new ClusterCoordinator({
      ephemeral: true,
      adminApiKey: "test-key",
      listenHost: "127.0.0.1",
      listenPort: 19888, // 独立测试端口
    });
    const store = coordinator.getStore();
    await store.saveNode({ nodeId: "test-worker", name: "test-worker", role: "worker", platform: "linux", arch: "x64", hostname: "test", tokenHash: "test", status: "online", lastSeenAt: Date.now(), metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await store.upsertProjectCatalog([{ nodeId: "test-worker", projectId: "test-project", name: "test-project", status: "active", visibility: "summary", capabilities: [], technologies: [], registeredAt: Date.now(), lastIndexedAt: Date.now(), updatedAt: Date.now(), revision: 1 } as any]);
    await store.saveCatalogRevision("test-worker", 1, simulatedCapabilities("linux"));
    const ws = { readyState: 1, close() {}, terminate() {}, send(raw: string) {
      const envelope = JSON.parse(raw);
      if (envelope.type === "task.control") void store.updateTaskStatus(envelope.payload.taskId, "cancelled").then(() => coordinator.getScheduler().handleControlAck({ ...envelope.payload, status: "applied" }));
    } };
    mock.method(coordinator.getRegistry(), "getConnection", (nodeId: string) => ({ nodeId, ws, generation: 1, lastHeartbeatAt: Date.now(), metadata: {} } as any));
    const addr = await coordinator.start();
    coordinatorUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await coordinator.stop();
  });

  test("1. POST /api/cluster/graphs/plan 返回合法 DAG 规划", async () => {
    const res = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/plan`, {
      method: "POST",
      body: { goal: "提取视频字幕并导入阅读项目进行测试", nodes },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.proposal.requiresMultiAgent, true);
    assert.equal(res.data.validation.valid, true);
    assert.ok(res.data.proposal.nodes.length >= 3);
    const explicit = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/plan`, {
      method: "POST", body: { goal: "检查项目", nodes, budget: { perTaskTimeoutMs: 600000, perTaskTimeoutSource: "legacy_default" } },
    });
    assert.equal(explicit.data.proposal.budget.perTaskTimeoutSource, "user");
  });

  test("2. POST /api/cluster/graphs/run 启动分布式任务图", async () => {
    const res = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/run`, {
      method: "POST",
      body: { goal: "提取视频字幕并导入阅读项目进行测试", nodes },
    });

    assert.equal(res.status, 201);
    assert.ok(res.data.graph.graphId);
    assert.equal(res.data.graph.status, "running");
    assert.ok(res.data.snapshot.totalNodes >= 3);
  });

  test("3. GET /api/cluster/graphs 列表查询", async () => {
    const res = await fetchJson(`${coordinatorUrl}/api/cluster/graphs`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.graphs));
    assert.ok(res.data.graphs.length >= 1);
  });

  test("4. 控制指令: POST /steer, /pause, /resume, /cancel", async () => {
    // 启动一张专用控制测试图 (复合多阶段目标，确保生成分布式任务图)
    const createRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/run`, {
      method: "POST",
      body: { goal: "从 Bilibili 提取字幕并且分析项目架构，设计导入方案并执行测试", nodes },
    });
    assert.equal(createRes.status, 201);
    assert.ok(createRes.data.graph?.graphId);
    const graphId = createRes.data.graph.graphId;

    // 1. Steer
    const steerRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/${graphId}/steer`, {
      method: "POST",
      body: { instruction: "先不要修改代码，只做分析" },
    });
    assert.equal(steerRes.status, 200);
    assert.equal(steerRes.data.success, true);
    assert.equal(steerRes.data.newRevision, 2);

    // 2. Pause
    const pauseRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/${graphId}/pause`, {
      method: "POST",
    });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.data.success, true);

    // 3. Resume
    const resumeRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/${graphId}/resume`, {
      method: "POST",
    });
    assert.equal(resumeRes.status, 200);
    assert.equal(resumeRes.data.success, true);

    // 4. Cancel
    const cancelRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/${graphId}/cancel`, {
      method: "POST",
      body: { reason: "Integration test completed" },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.success, true);

    // 5. 详情查询确认终态为 cancelled
    const detailsRes = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/${graphId}`);
    assert.equal(detailsRes.status, 200);
    assert.equal(detailsRes.data.graph.status, "cancelled");
  });

  test("5. Fast Path 路由正确性: 查询腾讯云 Node.js 版本触发 Fast Path 且目标节点严格为 Tencent 节点", async () => {
    // 注入一个 Tencent 节点与项目
    const store = coordinator.getStore();
    await store.saveNode({
      nodeId: "node-example-cloud",
      name: "tencent-vm",
      role: "worker",
      platform: "linux",
      arch: "x64",
      hostname: "example-cloud-linux",
      tokenHash: "dummy",
      status: "online",
      lastSeenAt: Date.now(),
      metadata: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await store.upsertProjectCatalog([
      {
        nodeId: "node-example-cloud",
        projectId: "proj-system-probe",
        name: "system-probe",
        summary: "System probe and environment diagnostics",
        description: "System probe and environment diagnostics",
        visibility: "summary",
        status: "active",
        technologies: ["Node.js", "Linux", "Bash"],
        capabilities: ["env_probe"],
        registeredAt: Date.now(),
        lastIndexedAt: Date.now(),
        revision: 1,
        updatedAt: Date.now(),
      },
    ]);

    await store.saveCatalogRevision("node-example-cloud", 1, simulatedCapabilities("linux"));
    const res = await fetchJson(`${coordinatorUrl}/api/cluster/graphs/run`, {
      method: "POST",
      body: { goal: "查询腾讯云 Node.js 版本" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.data.mode, "fast_path");
    assert.equal(res.data.result.decision.selectedCandidate?.nodeId, "node-example-cloud");
  });
});
