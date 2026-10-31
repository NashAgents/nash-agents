// REAL_LLM + REAL_SANDBOX: 两件事在真实环境里同时成立才算通过——
//   1) Pre-Tool Security Monitor 真的把工具调用发给独立安全模型审查（不是桩，也不是确定性规则），
//      且确定性硬拦截在任何模型调用之前就生效；
//   2) 任务级全访问授权在**真实操作系统沙箱**上改变行为：授权前工作区外写入被内核拒绝、
//      授权后真实落盘、撤销后再次被拒绝。
// 只在显式导出真实模型配置时运行，不接触任何远端节点。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { SecurityEvaluator } from "../src/security/security-evaluator.js";
import type { SecurityContext } from "../src/security/security-types.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";
import { WorkerTaskRunner } from "../src/cluster/worker/worker-task-runner.js";
import { ProjectRegistry } from "../src/cluster/worker/project-registry.js";
import type { TaskDispatchPayload, TaskGrantSecurityPayload } from "../src/cluster/protocol/types.js";

const baseUrl = process.env.DEEPSEEK_BASE_URL;
const apiKey = process.env.DEEPSEEK_API_KEY;
const model = process.env.DEEPSEEK_MODEL;
const skipped = process.env.NASH_RUN_REAL_LLM_TESTS !== "1" || !baseUrl || !apiKey || !model
  ? "Requires NASH_RUN_REAL_LLM_TESTS=1 and an exported real model configuration"
  : process.platform === "win32"
    ? "Requires a POSIX native sandbox"
    : false;

function securityContext(toolName: string, toolArgs: Record<string, unknown>): SecurityContext {
  const rawArgs = JSON.stringify(toolArgs);
  return {
    toolName,
    toolArgs,
    rawArgs,
    argsFingerprint: SecurityEvaluator.computeFingerprint(toolName, rawArgs),
    cwd: process.cwd(),
    agentIdentity: { agentId: "live-e2e", role: "worker", nodeType: "worker" },
    userAuthorizationContext: { userIntent: "列出当前目录", recentUserMessages: ["列出当前目录"] },
    sourceTag: "user_directive",
  };
}

test("REAL_LLM + REAL_SANDBOX: 安全模型真实审查，任务级授权真实改变内核行为", {
  skip: skipped,
  timeout: 300000,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nash-live-security-"));
  const workspace = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, `escaped-${randomBytes(4).toString("hex")}.txt`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // -------------------------------------------------------------------------
  // 1. 真实 Security LLM 审查
  // -------------------------------------------------------------------------
  const audits: Array<Record<string, unknown>> = [];
  const monitor = new PreToolSecurityMonitor({
    baseUrl,
    apiKey,
    model,
    format: (process.env.DEEPSEEK_API_FORMAT as never) ?? "completions",
    cacheEnabled: false,
    auditSink: (record) => { audits.push(record as Record<string, unknown>); },
  });

  const benign = await monitor.evaluateToolCall(securityContext("bash", { command: "ls -la" }));
  assert.equal(benign.verdict, "ALLOW", `常规命令必须放行，实际: ${benign.verdict} / ${benign.reason}`);
  assert.equal(benign.decisionSource, "LLM_MONITOR", "结论必须来自真实安全模型，而不是确定性规则或系统降级");
  assert.ok(typeof benign.reason === "string" && benign.reason.length > 0, "模型必须给出可审计的理由");
  assert.equal(audits.length >= 1, true, "审查必须产生审计记录");

  const hardBlock = await monitor.evaluateToolCall(securityContext("bash", { command: "rm -rf /" }));
  assert.equal(hardBlock.verdict, "BLOCK", "破坏性删除必须被阻断");
  assert.equal(hardBlock.isHardBlock, true, "必须标记为不可被人工审批绕过的硬拦截");
  assert.equal(hardBlock.decisionSource, "DETERMINISTIC_POLICY", "硬拦截必须在调用模型之前由确定性规则给出");

  // -------------------------------------------------------------------------
  // 2. 真实 OS 沙箱 + 任务级授权
  // -------------------------------------------------------------------------
  const preGrantPolicy: SandboxPolicy = {
    filesystem: { mode: "workspace-write" },
    network: { mode: "deny" },
    approval: { mode: "auto-grant" },
  };
  const sandboxService = new SandboxService({ cwd: workspace, policy: preGrantPolicy });
  if (!sandboxService.getBackend().isAvailable()) {
    t.skip(`原生沙箱不可用: ${sandboxService.getBackend().name}`);
    return;
  }

  const escape = async () => {
    const result = await sandboxService.runProcess({
      command: "/bin/sh",
      args: ["-c", `printf escaped > "${outsideFile}"`],
      cwd: workspace,
      timeout: 20000,
    });
    return { exitCode: result.exitCode, stderr: `${result.stderr ?? ""}${result.stdout ?? ""}`, exists: fs.existsSync(outsideFile) };
  };

  const before = await escape();
  assert.notEqual(before.exitCode, 0, "授权前：工作区外写入必须在操作系统层失败");
  assert.equal(before.exists, false, "授权前：不得产生任何越界文件");

  const projectRegistry = new ProjectRegistry({ customDir: path.join(root, ".nash") });
  const project = projectRegistry.registerProject(workspace, "proj-live-security");
  const payload: TaskDispatchPayload = {
    dispatchAttempt: 1,
    connectionGeneration: 1,
    taskId: "task-live",
    runId: "run-live",
    projectId: project.projectId,
    goal: "live security grant",
  };
  const runner = new WorkerTaskRunner(payload, projectRegistry, "node-live", "node-coord", null);
  const fsAccess = new FileSystemAccess({ workspaceRoot: workspace, policy: preGrantPolicy });
  // 授权必须作用在**同一个** SandboxService 实例上：这正是 Worker 运行时的接线方式，
  // 用第二个实例会让「授权后写入成功」变成假象。
  Object.assign(runner as unknown as Record<string, unknown>, {
    isRunning: true,
    fsAccess,
    sandboxService,
    currentPolicy: preGrantPolicy,
    preGrantPolicy,
    approvalProvider: { resolveApproval: () => true },
  });

  const grant: TaskGrantSecurityPayload = {
    grantId: "grant-live",
    approvalId: "approval-live",
    nodeId: "node-live",
    taskId: "task-live",
    runId: "run-live",
    targetPolicy: {
      filesystem: { mode: "danger-full-access" },
      network: { mode: "allow" },
      approval: { mode: "auto-grant" },
    },
    configurationVersion: 1,
    grantedAt: Date.now(),
    authorizedBy: "live-e2e-admin",
  };
  assert.equal(runner.applyTaskSecurityGrant(grant).success, true, "授权必须被 Worker 接受");

  const after = await escape();
  assert.equal(after.exitCode, 0, `授权后：真实写入必须成功，stderr=${after.stderr}`);
  assert.equal(after.exists, true, "授权后：文件必须真实落盘");
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "escaped");

  assert.equal(runner.revokeTaskSecurityGrant("grant-live", "live e2e revoke").reverted, true);
  fs.rmSync(outsideFile, { force: true });
  const afterRevoke = await escape();
  assert.notEqual(afterRevoke.exitCode, 0, "撤销授权后：工作区外写入必须重新被内核拒绝");
  assert.equal(afterRevoke.exists, false, "撤销授权后：不得再次产生越界文件");
});
