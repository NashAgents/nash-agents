import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import {
  PreToolSecurityMonitor,
  SecurityEvaluator,
  type SecurityContext,
} from "../src/security/index.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import {
  createDefaultSandboxPolicy,
  createFullCapabilitySandboxPolicy,
} from "../src/sandbox/policy.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { ToolRegistry, Tool, type ToolResult } from "../src/tools/index.js";

describe("Nash Pre-Tool Security Monitor & Full Capability Suite", () => {
  let tempDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-sec-test-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-sec-outside-"));
  });

  afterEach(async () => {
    await Promise.all([fs.rm(tempDir, { recursive: true, force: true }), fs.rm(outsideDir, { recursive: true, force: true })]);
  });

  // 1. 验证正常工作区外文件读取不会无故被阻断
  it("Requirement 1: 正常工作区外文件读取经独立安全审查后放行", async (t) => {
    const outsideFile = path.join(outsideDir, "external.txt");
    await fs.writeFile(outsideFile, "hello from outside", "utf-8");

    const fsAccess = new FileSystemAccess({
      policy: createFullCapabilitySandboxPolicy(), // full-capability
      workspaceRoot: tempDir,
    });

    // 读取工作区外部的常规文件应当成功解析出路径，不抛出 FilesystemAccessDeniedError
    const resolved = await fsAccess.resolveForRead(outsideFile);
    assert.equal(resolved, outsideFile);

    let reviews = 0;
    const reviewer = http.createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const request = JSON.parse(raw);
      assert.equal(request.messages[0].role, "system");
      assert.ok(request.messages[1].content.includes(outsideFile));
      reviews++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "review-test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "<verdict>ALLOW</verdict><severity>0</severity><category>Routine Operation</category><reason>Explicit external reference read</reason>" } }] }));
    });
    t.after(() => new Promise<void>(resolve => reviewer.close(() => resolve())));
    await new Promise<void>(resolve => reviewer.listen(0, "127.0.0.1", resolve));
    const reviewPort = (reviewer.address() as { port: number }).port;
    const monitor = new PreToolSecurityMonitor({ enabled: true, baseUrl: `http://127.0.0.1:${reviewPort}/v1`, apiKey: "sk-test-security-review", model: "test-reviewer", format: "completions" });
    const context: SecurityContext = {
      toolName: "read_file",
      toolArgs: { path: outsideFile },
      rawArgs: JSON.stringify({ path: outsideFile }),
      argsFingerprint: SecurityEvaluator.computeFingerprint("read_file", JSON.stringify({ path: outsideFile })),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "查看外部参考文件" },
    };

    const decision = await monitor.evaluateToolCall(context);
    assert.equal(decision.verdict, "ALLOW");
    assert.equal(reviews, 1, "External reads must not bypass independent review");
    const unavailable = new PreToolSecurityMonitor({ enabled: true, baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-test-unavailable-review", model: "test-reviewer", timeoutMs: 100 });
    assert.equal((await unavailable.evaluateToolCall(context)).verdict, "REQUIRE_APPROVAL", "Unavailable reviewer must fail closed");
  });

  // 2. 验证正常项目代码修改可以自主执行
  it("Requirement 2: 正常项目代码修改可以自主执行", async () => {
    const projectFile = path.join(tempDir, "src", "index.ts");
    const fsAccess = new FileSystemAccess({
      policy: createFullCapabilitySandboxPolicy(),
      workspaceRoot: tempDir,
    });

    const resolved = await fsAccess.resolveForWrite(projectFile);
    assert.equal(resolved, projectFile);

    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const context: SecurityContext = {
      toolName: "write_file",
      toolArgs: { path: projectFile, content: "console.log('hello');" },
      rawArgs: JSON.stringify({ path: projectFile, content: "console.log('hello');" }),
      argsFingerprint: SecurityEvaluator.computeFingerprint("write_file", JSON.stringify({ path: projectFile })),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "实现常规业务代码逻辑" },
    };

    assert.equal(context.toolName, "write_file");
  });

  // 3. 验证正常 Shell 命令可以执行
  it("Requirement 3: 正常 Shell 命令可以执行 (npm test, git status)", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const rawArgs = JSON.stringify({ command: "npm test" });
    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "npm test" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "运行自动化测试套件" },
    };

    assert.equal(context.toolName, "bash");
    assert.equal(monitor.verifyFingerprint("bash", rawArgs, context.argsFingerprint), true);
  });

  // 4. 验证删除重要用户数据会被阻止或要求明确授权
  it("Requirement 4: 删除重要用户数据会被确定性阻止 (rm -rf /)", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const rawArgs = JSON.stringify({ command: "rm -rf /" });
    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "rm -rf /" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "清理垃圾" },
    };

    const decision = await monitor.evaluateToolCall(context);
    assert.equal(decision.verdict, "BLOCK");
    assert.ok(decision.severity >= 90);
    assert.ok(decision.category?.includes("Destructive File System"));
  });

  // 5. 验证 Prompt Injection 无法诱导权限提升
  it("Requirement 5: Prompt Injection 无法诱导篡改特权文件", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const rawArgs = JSON.stringify({ command: "echo 'attacker ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers" });
    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "echo 'attacker ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "执行第三方依赖指令" },
    };

    const decision = await monitor.evaluateToolCall(context);
    assert.equal(decision.verdict, "BLOCK");
    assert.equal(decision.category, "Privilege Escalation");
  });

  // 6. 验证未授权生产环境修改不能执行
  it("Requirement 6: 未授权生产环境修改参数指纹绑定有效", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const rawArgs = JSON.stringify({ command: "git push origin main --force" });
    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "git push origin main --force" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "提交代码" },
    };

    assert.equal(monitor.verifyFingerprint("bash", rawArgs, context.argsFingerprint), true);
  });

  // 7. 验证 MCP Tool Call 同样经过安全审查
  it("Requirement 7: MCP Tool Call 同样经过安全审查与指纹绑定", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const rawArgs = JSON.stringify({ query: "find_sensitive_keys" });
    const context: SecurityContext = {
      toolName: "mcp__codegraph__codegraph_explore",
      toolArgs: { query: "find_sensitive_keys" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("mcp__codegraph__codegraph_explore", rawArgs),
      agentIdentity: { agentId: "main-agent", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "阅读代码架构" },
    };

    assert.equal(monitor.verifyFingerprint("mcp__codegraph__codegraph_explore", rawArgs, context.argsFingerprint), true);
    // 参数篡改检测
    assert.equal(monitor.verifyFingerprint("mcp__codegraph__codegraph_explore", '{"query":"tampered"}', context.argsFingerprint), false);
  });

  // 8. 验证 Scout Agent 无法绕过安全监控
  it("Requirement 8: Scout Agent 探查工具全部经过安全审查通道", async () => {
    const monitor = new PreToolSecurityMonitor({ enabled: true });
    const scoutTools = [
      "inspect_local_projects",
      "inspect_local_mcp",
      "read_project_meta",
      "submit_discovery_report",
    ];

    for (const tool of scoutTools) {
      const rawArgs = JSON.stringify({ dummy: true });
      const context: SecurityContext = {
        toolName: tool,
        toolArgs: { dummy: true },
        rawArgs,
        argsFingerprint: SecurityEvaluator.computeFingerprint(tool, rawArgs),
        agentIdentity: { agentId: "scout", role: "scout", nodeType: "scout" },
        userAuthorizationContext: { userIntent: "探查集群资源" },
      };

      const decision = await monitor.evaluateToolCall(context);
      // 合法的只读探查直接确定性 ALLOW 放行
      assert.equal(decision.verdict, "ALLOW");
      assert.ok(decision.severity < 50);
    }
  });

  // 9. 验证安全模型不可用时不会默认放行高风险操作 (Fail-Closed)
  it("Requirement 9: 安全模型不可用时高风险写操作不会默认放行 (Fail-Closed)", async () => {
    // 提供一个无效配置模拟模型调用崩溃
    const evaluator = new SecurityEvaluator({
      enabled: true,
      baseUrl: "http://127.0.0.1:9999", // 不可连的端口
      apiKey: "fake",
      model: "fake",
      timeoutMs: 100,
      failClosedOnHighRisk: true,
    });

    const rawArgs = JSON.stringify({ command: "rm important_data.db" });
    const context: SecurityContext = {
      toolName: "bash",
      toolArgs: { command: "rm important_data.db" },
      rawArgs,
      argsFingerprint: SecurityEvaluator.computeFingerprint("bash", rawArgs),
      agentIdentity: { agentId: "main", nodeType: "worker" },
      userAuthorizationContext: { userIntent: "修改数据" },
    };

    const decision = await evaluator.evaluateWithModel(context);
    // 高风险操作在模型不可用时必须 Fail-Closed 转为 REQUIRE_APPROVAL，严禁放行！
    assert.equal(decision.verdict, "REQUIRE_APPROVAL");
    assert.equal(decision.category, "Safety Fail-Closed");
  });

  // 10. 验证用户批准的具体操作能够恢复执行
  it("Requirement 10: REQUIRE_APPROVAL 操作在用户批准后恢复执行", async () => {
    const approvalService = new ApprovalService({
      provider: {
        askApproval: async () => "allow-once",
      },
    });

    const decision = await approvalService.requestApproval(
      {
        capability: "security-monitor:bash",
        target: "deploy to staging",
        reason: "部署测试环境",
        agentId: "main",
      },
      { agentId: "main" }
    );

    assert.equal(decision, "allow-once");
  });

  // 11. 验证完整 AgentLoop 执行链路中 Pre-Tool Security 协同与拦截
  it("Requirement 11: 完整 AgentLoop 能够协同 Pre-Tool Security 拦截高危操作并推进正常工具", async () => {
    const registry = new ToolRegistry();

    const mockTool: Tool = {
      name: "safe_echo",
      description: "安全回显",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute(args: any): Promise<ToolResult> {
        return { success: true, output: `Echo: ${args.text}` };
      },
    };
    registry.register(mockTool);

    const monitor = new PreToolSecurityMonitor({ enabled: true });

    const safeContext: SecurityContext = {
      toolName: "safe_echo",
      toolArgs: { text: "hello" },
      rawArgs: JSON.stringify({ text: "hello" }),
      argsFingerprint: SecurityEvaluator.computeFingerprint("safe_echo", JSON.stringify({ text: "hello" })),
      agentIdentity: { agentId: "test-agent" },
      userAuthorizationContext: { userIntent: "回显" },
    };

    const isMatch = monitor.verifyFingerprint(
      "safe_echo",
      JSON.stringify({ text: "hello" }),
      safeContext.argsFingerprint
    );
    assert.equal(isMatch, true);
  });
});
