import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

async function makeRequest(
  port: number,
  path: string,
  method = "GET",
  body?: any,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-admin-key",
          ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode || 200, body: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode || 200, body: text });
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("Scheduled Tasks & Security Audit REST API Integration", () => {
  test("完整测试定时任务与安全审计端点交互", async () => {
    const coord = new ClusterCoordinator({
      ephemeral: true,
      adminApiKey: "test-admin-key",
      listenPort: 0,
    });

    const { port } = await coord.start();

    try {
      // 1. 创建定时任务
      const createRes = await makeRequest(port, "/api/cluster/scheduled-tasks", "POST", {
        name: "API自动化测试任务",
        triggerType: "cron",
        cronExpression: "0 9 * * *",
        goal: "测试目标",
      });
      assert.strictEqual(createRes.status, 201);
      assert.strictEqual(createRes.body.name, "API自动化测试任务");
      const taskId = createRes.body.id;

      // 2. 别名路由查询 /api/cluster/schedules
      const listRes = await makeRequest(port, "/api/cluster/schedules", "GET");
      assert.strictEqual(listRes.status, 200);
      assert.strictEqual(listRes.body.tasks.length, 1);
      assert.strictEqual(listRes.body.tasks[0].id, taskId);

      // 3. 暂停与恢复
      const pauseRes = await makeRequest(port, `/api/cluster/schedules/${taskId}/pause`, "POST");
      assert.strictEqual(pauseRes.status, 200);
      assert.strictEqual(pauseRes.body.enabled, false);

      const resumeRes = await makeRequest(port, `/api/cluster/schedules/${taskId}/resume`, "POST");
      assert.strictEqual(resumeRes.status, 200);
      assert.strictEqual(resumeRes.body.enabled, true);

      // 4. 手动立即执行
      const runRes = await makeRequest(port, `/api/cluster/schedules/${taskId}/run`, "POST", { force: true });
      assert.strictEqual(runRes.status, 200);
      assert.strictEqual(runRes.body.success, true);
      assert.ok(runRes.body.run?.id);

      // 5. 插入安全审计记录并通过 API 查询
      const store = (coord as any).store;
      await store.saveSecurityAudit({
        id: "sec-api-1",
        timestamp: Date.now(),
        toolName: "bash",
        argsFingerprint: "fp-api",
        sanitizedArgs: { command: "rm -rf /" },
        rawArgsSnippet: "rm -rf /",
        decisionSource: "DETERMINISTIC_POLICY",
        verdict: "BLOCK",
        severity: 99,
        riskCategory: "Destructive File System",
        reason: "确定性硬拦截清空文件系统",
        agentId: "main",
        durationMs: 1,
        isHardBlock: true,
        reviewFeedback: { status: "unreviewed" },
        createdAt: Date.now(),
      });

      // 6. 安全审计列表查询
      const auditListRes = await makeRequest(port, "/api/cluster/security/audits", "GET");
      assert.strictEqual(auditListRes.status, 200);
      assert.strictEqual(auditListRes.body.total, 1);
      assert.strictEqual(auditListRes.body.items[0].id, "sec-api-1");

      // 7. 统计指标查询
      const statsRes = await makeRequest(port, "/api/cluster/security/stats", "GET");
      assert.strictEqual(statsRes.status, 200);
      assert.strictEqual(statsRes.body.blockCount, 1);

      // 8. 提交误判复核反馈 (验证 Hard Block 防越权返回)
      const feedbackRes = await makeRequest(port, "/api/cluster/security/audits/sec-api-1/feedback", "POST", {
        status: "false_positive",
        comment: "测试复核批注",
      });
      assert.strictEqual(feedbackRes.status, 200);
      assert.strictEqual(feedbackRes.body.audit.reviewFeedback.status, "false_positive");
      assert.strictEqual(feedbackRes.body.hardBlockEnforced, true);
      assert.ok(feedbackRes.body.warning?.includes("Hard Block"));

      // 9. 删除定时任务
      const deleteRes = await makeRequest(port, `/api/cluster/schedules/${taskId}`, "DELETE");
      assert.strictEqual(deleteRes.status, 200);
      assert.strictEqual(deleteRes.body.success, true);
    } finally {
      await coord.stop();
    }
  });
});
