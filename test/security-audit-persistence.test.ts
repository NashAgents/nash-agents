import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import type { SecurityContext } from "../src/security/security-types.js";

describe("Pre-Tool Security Monitor Audit Persistence & Safety Invariants", () => {
  test("高危指令确定性硬拦截并自动生成脱敏持久化记录", async () => {
    const store = new InMemoryClusterStore();
    const monitor = new PreToolSecurityMonitor({
      enabled: true,
      auditLogging: true,
      auditSink: (record) => store.saveSecurityAudit(record),
    });

    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: {
        command: "rm -rf / --no-preserve-root",
        apiKey: "sk-secret-1234567890",
        auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token",
      },
      rawArgs: '{"command":"rm -rf / --no-preserve-root"}',
      argsFingerprint: "sha256-dummy-fingerprint",
      agentIdentity: { agentId: "worker-agent-1" },
      nodeId: "node-wsl2",
      taskId: "task-test-destroy",
      userAuthorizationContext: { userIntent: "尝试系统清理" },
    };

    const decision = await monitor.evaluateToolCall(context);

    // 验证拦截结论
    assert.strictEqual(decision.verdict, "BLOCK");
    assert.strictEqual(decision.decisionSource, "DETERMINISTIC_POLICY");
    assert.strictEqual(decision.isHardBlock, true);

    // 验证是否已自动写入 Store
    const res = await store.listSecurityAudits();
    assert.strictEqual(res.total, 1);
    const audit = res.items[0];
    assert.strictEqual(audit.verdict, "BLOCK");
    assert.strictEqual(audit.isHardBlock, true);
    assert.strictEqual(audit.toolName, "bash");
    assert.strictEqual(audit.nodeId, "node-wsl2");

    // 验证脱敏安全性：API Key 与 Bearer Token 不得以明文保存
    assert.strictEqual(audit.sanitizedArgs.apiKey, "[REDACTED]");
    assert.strictEqual(audit.sanitizedArgs.auth, "Bearer [MASKED]");
  });

  test("参数递归脱敏方法 PreToolSecurityMonitor.sanitizeArgs", () => {
    const args = {
      nested: {
        password: "super_secret_password",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
      },
      normalFlag: true,
      port: 8080,
    };

    const sanitized = PreToolSecurityMonitor.sanitizeArgs(args);
    assert.strictEqual((sanitized.nested as any).password, "[REDACTED]");
    assert.strictEqual((sanitized.nested as any).privateKey, "[REDACTED_PRIVATE_KEY]");
    assert.strictEqual(sanitized.normalFlag, true);
    assert.strictEqual(sanitized.port, 8080);
  });

  test("标记误判 (False Positive) 绝对不可绕过硬阻断 (Hard Block)", async () => {
    const store = new InMemoryClusterStore();
    const monitor = new PreToolSecurityMonitor({
      enabled: true,
      auditSink: (record) => store.saveSecurityAudit(record),
    });

    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "cat /etc/shadow" },
      rawArgs: '{"command":"cat /etc/shadow"}',
      argsFingerprint: "sha256-shadow-fingerprint",
      agentIdentity: { agentId: "main" },
      userAuthorizationContext: { userIntent: "查看用户" },
    };

    const decision = await monitor.evaluateToolCall(context);
    assert.strictEqual(decision.verdict, "BLOCK");
    assert.strictEqual(decision.isHardBlock, true);

    const audits = await store.listSecurityAudits();
    const auditId = audits.items[0].id;

    // 模拟人工在前端提交复核反馈
    const updated = await store.updateSecurityAuditFeedback(auditId, {
      status: "false_positive",
      comment: "管理员认为可信",
      reviewedBy: "admin",
    });

    assert.strictEqual(updated?.reviewFeedback.status, "false_positive");
    // 铁律：isHardBlock 必须保持为 true，底层的安全判定绝对不能被篡改为 ALLOW
    assert.strictEqual(updated?.isHardBlock, true);
    assert.strictEqual(updated?.verdict, "BLOCK");
  });

  test("审计多条件过滤与统计指标计算", async () => {
    const store = new InMemoryClusterStore();
    const now = Date.now();

    await store.saveSecurityAudit({
      id: "sec-1",
      timestamp: now,
      toolName: "bash",
      argsFingerprint: "fp-1",
      sanitizedArgs: {},
      rawArgsSnippet: "",
      decisionSource: "DETERMINISTIC_POLICY",
      verdict: "BLOCK",
      severity: 95,
      riskCategory: "Privilege Escalation",
      reason: "访问影子文件",
      agentId: "main",
      durationMs: 2,
      isHardBlock: true,
      reviewFeedback: { status: "unreviewed" },
      createdAt: now,
    });

    await store.saveSecurityAudit({
      id: "sec-2",
      timestamp: now + 1,
      toolName: "read_file",
      argsFingerprint: "fp-2",
      sanitizedArgs: {},
      rawArgsSnippet: "",
      decisionSource: "DETERMINISTIC_POLICY",
      verdict: "ALLOW",
      severity: 0,
      riskCategory: "Routine Operation",
      reason: "正常文件读取",
      agentId: "worker-1",
      durationMs: 1,
      isHardBlock: false,
      reviewFeedback: { status: "unreviewed" },
      createdAt: now + 1,
    });

    const blockList = await store.listSecurityAudits({ verdict: "BLOCK" });
    assert.strictEqual(blockList.total, 1);
    assert.strictEqual(blockList.items[0].id, "sec-1");

    const stats = await store.getSecurityAuditStats();
    assert.strictEqual(stats.totalCount, 2);
    assert.strictEqual(stats.blockCount, 1);
    assert.strictEqual(stats.allowCount, 1);
    assert.strictEqual(stats.sourceCounts.DETERMINISTIC_POLICY, 2);
  });
});
