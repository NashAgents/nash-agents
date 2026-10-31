import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import http from "node:http";
import cp from "node:child_process";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultToolRegistry, ToolExecutor } from "../src/tools/index.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { detectNodeHardwareCapabilities } from "../src/cluster/worker/catalog/hardware-detector.js";
import { FilesystemAccessDeniedError, SandboxUnavailableError } from "../src/sandbox/errors.js";

describe("Windows Sandbox Formal Acceptance (Scenarios A through F)", { skip: process.platform !== "win32" ? "Requires Windows platform" : false }, () => {
  let tempWorkspace: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-acc-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-win-secret-"));
  });

  afterEach(async () => {
    try {
      if (fsSync.existsSync(tempWorkspace)) {
        await fs.rm(tempWorkspace, { recursive: true, force: true });
      }
      if (fsSync.existsSync(outsideDir)) {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    } catch {}
  });

  // =========================================================================
  // 场景 A：普通项目分析
  // =========================================================================
  it("场景 A：普通项目分析 — 读取 package.json、src、README 并解析架构", async () => {
    const service = new SandboxService({
      policy: createDefaultSandboxPolicy(),
      cwd: process.cwd(),
    });
    const fsAccess = new FileSystemAccess({
      policy: createDefaultSandboxPolicy(),
      workspaceRoot: process.cwd(),
    });
    const registry = createDefaultToolRegistry({
      sandboxService: service,
      fsAccess,
    });
    const executor = new ToolExecutor(registry);

    // 1. 读取 package.json
    const pkgRes = await executor.execute("read_file", { path: "package.json", limit: 20 });
    assert.equal(pkgRes.success, true);
    assert.match(pkgRes.output, /"name":\s*"nash-agents"/);

    // 2. 列出 src 目录
    const listRes = await executor.execute("list_files", { path: "src" });
    assert.equal(listRes.success, true);
    const files = JSON.parse(listRes.output) as Array<{ name: string; type: string }>;
    assert.ok(files.some((f) => f.name === "sandbox"));
    assert.ok(files.some((f) => f.name === "tools"));

    // 3. 读取 README.md
    const readmeRes = await executor.execute("read_file", { path: "README.md", limit: 30 });
    assert.equal(readmeRes.success, true);
    assert.match(readmeRes.output, /Nash/i);
  });

  // =========================================================================
  // 场景 B：合法代码修改
  // =========================================================================
  it("场景 B：合法代码修改 — 在测试目录读取、修改、保存并执行测试", async () => {
    const fsAccess = new FileSystemAccess({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      workspaceRoot: tempWorkspace,
    });
    const service = new SandboxService({
      policy: {
        filesystem: { mode: "workspace-write" },
        network: { mode: "deny" },
        approval: { mode: "never" },
      },
      cwd: tempWorkspace,
    });
    const registry = createDefaultToolRegistry({
      fsAccess,
      sandboxService: service,
    });
    const executor = new ToolExecutor(registry);

    // 1. 写入 calculator.js 源码
    const writeRes = await executor.execute("write_file", {
      path: "calculator.js",
      content: "export function add(a, b) { return a - b; }\n",
    });
    assert.equal(writeRes.success, true);

    // 2. 读取验证源码
    const readRes = await executor.execute("read_file", { path: "calculator.js" });
    assert.equal(readRes.success, true);
    assert.match(readRes.output, /return a - b/);

    // 3. 使用 edit_file 修复代码中的 bug (将 a - b 改为 a + b)
    const editRes = await executor.execute("edit_file", {
      path: "calculator.js",
      old_text: "return a - b;",
      new_text: "return a + b;",
    });
    assert.equal(editRes.success, true);

    // 4. 写入测试脚本 test_calc.js
    const writeTestRes = await executor.execute("write_file", {
      path: "test_calc.js",
      content: `
import { add } from './calculator.js';
import assert from 'node:assert/strict';
assert.equal(add(2, 3), 5);
console.log('CALCULATOR_TEST_PASSED');
      `.trim(),
    });
    assert.equal(writeTestRes.success, true);

    // 5. 在 Windows 原生沙箱环境中执行测试 (workspace-write + network: deny)
    const testExecResult = await service.runProcess({
      command: "node.exe",
      args: ["test_calc.js"],
      cwd: tempWorkspace,
    });
    if (testExecResult.exitCode !== 0) {
      console.error("Test execution failed. stdout:", testExecResult.stdout, "stderr:", testExecResult.stderr);
    }
    assert.equal(testExecResult.exitCode, 0);
    assert.match(testExecResult.stdout, /CALCULATOR_TEST_PASSED/);
  });

  // =========================================================================
  // 场景 C：恶意目录逃逸 (Junction / Symlink / Reparse Point)
  // =========================================================================
  it("场景 C：恶意目录逃逸 — Junction 软链接跨工作区窃取被物理真实路径二次拦截", async () => {
    // 1. 在工作区外创建机密数据文件
    const secretFile = path.join(outsideDir, "secret_password.txt");
    await fs.writeFile(secretFile, "SUPER_CONFIDENTIAL_KEY_2026", "utf-8");

    // 2. 在工作区内创建指向外部机密目录的 Windows Junction
    const junctionTarget = path.join(tempWorkspace, "linked_secret_dir");
    let junctionCreated = false;
    try {
      cp.execSync(`cmd.exe /c mklink /J "${junctionTarget}" "${outsideDir}"`, {
        stdio: "ignore",
      });
      junctionCreated = true;
    } catch {
      // 若普通用户由于系统策略限制无法创建 Junction，跳过此阶段验证
    }

    if (junctionCreated) {
      const fsAccess = new FileSystemAccess({
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "deny" },
          approval: { mode: "never" },
        },
        workspaceRoot: tempWorkspace,
      });
      const registry = createDefaultToolRegistry({ fsAccess });
      const executor = new ToolExecutor(registry);

      // 尝试通过 Junction 软链接读取工作区外部机密文件
      const readResult = await executor.execute("read_file", {
        path: "linked_secret_dir/secret_password.txt",
      });

      // 应当由于解析出真实物理路径逃逸工作区而坚决被拦截
      assert.equal(readResult.success, false);
      assert.match(readResult.output, /拒绝访问工作区根目录之外的路径/);

      // 清理 Junction
      try {
        cp.execSync(`cmd.exe /c rmdir "${junctionTarget}"`, { stdio: "ignore" });
      } catch {}
    }
  });

  // =========================================================================
  // 场景 D：Shell 进程树取消
  // =========================================================================
  it("场景 D：Shell 进程树取消 — Job Object 强力清理子进程树", async () => {
    const service = new SandboxService({
      policy: { filesystem: { mode: "danger-full-access" }, network: { mode: "allow" }, approval: { mode: "never" } },
      cwd: tempWorkspace,
    });

    // 启动长时间执行的 PowerShell 进程
    const res = await service.runProcess({
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
      timeout: 1000,
    });

    assert.equal(res.killed, true);
    assert.notEqual(res.exitCode, 0);
  });

  // =========================================================================
  // 场景 E：Security Monitor Windows 兼容审查
  // =========================================================================
  // 五类「拒绝」语义必须严格区分，任何一类都不得冒充另一类：
  //   1. Security LLM 判定拒绝 — 独立审查模型返回 <verdict>BLOCK</verdict>（本场景第 5 步）
  //   2. 确定性硬拦截         — PreToolSecurityMonitor 规则层（本场景第 2-4 步）
  //   3. 人工审批拒绝         — ApprovalService 的 deny 结果
  //   4. ACL / AppContainer 拒绝 — 内核权限（windows-sandbox-helper-protocol.test.ts）
  //   5. Job Object 终止      — killed=true（场景 D 及 helper 协议套件）
  it("场景 E：Security Monitor — 独立安全模型放行合法命令、模型 BLOCK 与确定性硬拦截分别生效", async (t) => {
    // 本地确定性安全模型 stub。SecurityMonitorConfig 已支持 baseUrl/apiKey/model/format，
    // 因此测试必须真实走「模型审查」路径：bash 执行不具备确定性免审资格，
    // 未配置模型时 Fail-Closed 为 REQUIRE_APPROVAL 才是正确行为。
    const startSecurityStub = async (verdict: "ALLOW" | "BLOCK") => {
      const requests: Array<{ model?: string; messages?: Array<{ role: string; content?: string }> }> = [];
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try { requests.push(JSON.parse(body)); } catch { requests.push({}); }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "sec-stub",
            object: "chat.completion",
            choices: [{
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: `<verdict>${verdict}</verdict><severity>${verdict === "ALLOW" ? 0 : 96}</severity>` +
                  `<category>${verdict === "ALLOW" ? "Routine Operation" : "Policy Violation"}</category>` +
                  `<reason>deterministic stub: ${verdict}</reason>`,
              },
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => {
        // fetch (undici) 默认 keep-alive，先断开空闲连接，避免 close 回调挂起
        server.closeAllConnections();
        server.close(() => resolve());
      }));
      const port = (server.address() as { port: number }).port;
      return { baseUrl: `http://127.0.0.1:${port}`, requests };
    };
    const reviewContext = (command: string, fingerprint: string) => ({
      toolName: "bash",
      toolArgs: { command },
      rawArgs: JSON.stringify({ command }),
      argsFingerprint: fingerprint,
      cwd: tempWorkspace,
      userAuthorizationContext: { userIntent: "Run tests" },
      agentIdentity: { agentId: "main" },
    });

    const allowStub = await startSecurityStub("ALLOW");
    const monitor = new PreToolSecurityMonitor({
      enabled: true,
      baseUrl: allowStub.baseUrl,
      apiKey: "sk-test-security-stub",
      model: "security-stub",
      format: "completions",
      cacheEnabled: false,
      timeoutMs: 5000,
    });

    // 1. 合法命令 (npm test) 经独立安全模型审查后放行
    const safeDecision = await monitor.evaluateToolCall(reviewContext("npm test", "fp-npm-test"));
    assert.equal(safeDecision.verdict, "ALLOW");
    assert.equal(safeDecision.decisionSource, "LLM_MONITOR", "ALLOW 必须来自真实模型审查路径，而不是绕过审查");
    assert.equal(allowStub.requests.length, 1, "合法命令必须真实经过独立安全模型");
    assert.match(String(allowStub.requests[0]?.messages?.[1]?.content ?? ""), /npm test/);

    // 2. 恶意命令 (清空根文件系统) 确定性硬拦截
    const evilDecision1 = await monitor.evaluateToolCall({
      toolName: "bash",
      toolArgs: { command: "rm -rf /" },
      rawArgs: '{"command":"rm -rf /"}',
      argsFingerprint: "fp-rm-rf",
      cwd: tempWorkspace,
      userAuthorizationContext: { userIntent: "Wipe" },
      agentIdentity: { agentId: "main" },
    });
    assert.equal(evilDecision1.verdict, "BLOCK");
    assert.equal(evilDecision1.decisionSource, "DETERMINISTIC_POLICY");

    // 3. 恶意命令 (窃取 /etc/shadow) 确定性硬拦截
    const evilDecision2 = await monitor.evaluateToolCall({
      toolName: "bash",
      toolArgs: { command: "cat /etc/shadow" },
      rawArgs: '{"command":"cat /etc/shadow"}',
      argsFingerprint: "fp-shadow",
      cwd: tempWorkspace,
      userAuthorizationContext: { userIntent: "Dump" },
      agentIdentity: { agentId: "main" },
    });
    assert.equal(evilDecision2.verdict, "BLOCK");
    assert.equal(evilDecision2.decisionSource, "DETERMINISTIC_POLICY");

    // 4. 恶意读取 SAM 注册表文件确定性硬拦截
    const evilDecision3 = await monitor.evaluateToolCall({
      toolName: "read_file",
      toolArgs: { path: "C:\\Windows\\System32\\config\\SAM" },
      rawArgs: '{"path":"C:\\\\Windows\\\\System32\\\\config\\\\SAM"}',
      argsFingerprint: "fp-sam",
      cwd: tempWorkspace,
      userAuthorizationContext: { userIntent: "Steal SAM" },
      agentIdentity: { agentId: "main" },
    });
    assert.equal(evilDecision3.verdict, "BLOCK");
    assert.equal(evilDecision3.decisionSource, "DETERMINISTIC_POLICY");
    assert.equal(allowStub.requests.length, 1, "确定性硬拦截不得回落到模型审查");

    // 5. 配套对照：stub 返回 <verdict>BLOCK</verdict> 时，模型路径必须真实阻断，
    //    证明第 1 步的 ALLOW 来自模型判决，而不是任何隐式放行/旁路。
    const blockStub = await startSecurityStub("BLOCK");
    const blockingMonitor = new PreToolSecurityMonitor({
      enabled: true,
      baseUrl: blockStub.baseUrl,
      apiKey: "sk-test-security-stub",
      model: "security-stub",
      format: "completions",
      cacheEnabled: false,
      timeoutMs: 5000,
    });
    const blockDecision = await blockingMonitor.evaluateToolCall(reviewContext("npm run publish:release", "fp-model-block"));
    assert.equal(blockDecision.verdict, "BLOCK", "独立安全模型判定 BLOCK 时必须阻断");
    assert.equal(blockDecision.decisionSource, "LLM_MONITOR");
    assert.equal(blockStub.requests.length, 1, "BLOCK 对照必须真实经过模型，而不是确定性规则");
  });

  // =========================================================================
  // 场景 F：Cluster Worker 上报与平台识别
  // =========================================================================
  it("场景 F：Cluster Worker — 正确上报 Windows 平台、原生沙箱与硬件能力", () => {
    const caps = detectNodeHardwareCapabilities();
    assert.ok(caps.length >= 3);

    // 1. 验证 Windows Native Sandbox 状态
    const sandboxCap = caps.find((c) => c.name === "Windows Native Sandbox");
    assert.ok(sandboxCap);
    assert.ok(["detected", "verified"].includes(sandboxCap.status));
    assert.equal(sandboxCap.structuredDetails?.processIsolationVerified, true);
    assert.match(sandboxCap.structuredDetails?.helperSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(sandboxCap.structuredDetails?.filesystemIsolationVerified, true);
    assert.equal(sandboxCap.structuredDetails?.networkIsolationVerified, true);

    // 2. 验证 CPU 与内存
    const cpuCap = caps.find((c) => c.category === "cpu");
    assert.ok(cpuCap);
    assert.equal(cpuCap.status, "available");

    // 3. 验证 GPU (若检测到 GPU，确保正确标记状态)
    const gpuCap = caps.find((c) => c.category === "gpu");
    if (gpuCap) {
      assert.ok(["detected", "available", "verified"].includes(gpuCap.status));
      assert.ok(gpuCap.name.length > 0);
    }
  });
});
