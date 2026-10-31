import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tools/registry.js";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { MCPToolAdapter, buildMCPToolName } from "../src/mcp/mcp-tool-adapter.js";
import { MCPResultAdapter } from "../src/mcp/mcp-result-adapter.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { createMockMCPHttpServer, type RunningMockServer } from "./fixtures/mock-http-server.js";
import { MCPRegisterTool } from "../src/mcp/mcp-management-tools.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";
import type { ToolResult } from "../src/tools/executor.js";
import { ContextManager } from "../src/context/context-manager.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import type { SandboxPolicy } from "../src/sandbox/types.js";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval/types.js";

/**
 * MCP 工具安全边界（真实 Mock MCP Server，走真实 MCP 协议与真实连接管理器）
 *
 * 安全铁律：
 *   - 远程 MCP 调用是一个真实的网络出口，必须遵守同一套 network + approval 边界；
 *   - approval: never 不得弹窗，必须 Fail-Closed；
 *   - network: deny + auto-grant 绝不能静默放行（auto-grant 不放宽显式 deny）；
 *   - 任务级授权与策略收紧必须对「后续调用」立即生效；
 *   - 确定性硬拦截不能通过 MCP 工具名或参数包装绕过；
 *   - 远端返回的无界内容不得整体注入上下文。
 */

function policy(network: "allow" | "deny", approval: "never" | "ask" | "auto-grant"): SandboxPolicy {
  return {
    filesystem: { mode: "workspace-write" },
    network: { mode: network },
    approval: { mode: approval },
  };
}

interface Harness {
  manager: MCPManager;
  registry: ToolRegistry;
  adapter: MCPToolAdapter;
  prompts: ApprovalRequest[];
  serverCalls: Array<{ name: string; args: Record<string, unknown> }>;
  home: string;
  cleanup(): Promise<void>;
}

async function createHarness(
  options: {
    network?: "allow" | "deny";
    approval?: "never" | "ask" | "auto-grant";
    decision?: ApprovalDecision;
    provideApprovalService?: boolean;
  } = {}
): Promise<Harness & { mock: RunningMockServer; sandbox: SandboxService }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-boundary-"));
  const serverCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mock = await createMockMCPHttpServer({
    onCallTool: (name, args) => {
      serverCalls.push({ name, args });
      return { content: [{ type: "text", text: `REMOTE_OK:${name}` }] };
    },
  });

  const prompts: ApprovalRequest[] = [];
  const approvalService = options.provideApprovalService === false
    ? undefined
    : new ApprovalService({
        async askApproval(request: ApprovalRequest) {
          prompts.push(request);
          return options.decision ?? "allow-once";
        },
      });

  const sandbox = new SandboxService({
    policy: policy(options.network ?? "deny", options.approval ?? "ask"),
    cwd: home,
  });
  const registry = new ToolRegistry();
  const manager = new MCPManager({
    projectRoot: home,
    nashHome: path.join(home, "nash-home"),
    registry,
    approvalService,
    sandboxService: sandbox,
  });
  manager.configManager.saveServer(
    "remote-svc",
    { transport: "streamable-http", url: mock.url, enabled: true, allowInsecureHttp: true },
    "project"
  );
  await manager.initialize();

  const adapter = registry.get(buildMCPToolName("remote-svc", "fetch_remote_data")) as MCPToolAdapter;
  assert.ok(adapter, "远程 MCP 工具必须已挂载到 ToolRegistry");

  return {
    manager, registry, adapter, prompts, serverCalls, home, mock, sandbox,
    async cleanup() {
      await manager.close().catch(() => {});
      await mock.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("MCP 远程调用：network: deny + ask 必须逐次人工授权，拒绝后绝不触达远端", async (t) => {
  const allow = await createHarness({ network: "deny", approval: "ask", decision: "allow-once" });
  t.after(() => allow.cleanup());
  const ok = await allow.adapter.execute({ query: "hello" });
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.match(String(ok.output), /REMOTE_OK:fetch_remote_data/);
  assert.equal(allow.prompts.length, 1, "必须恰好请求一次人工审批");
  assert.equal(allow.prompts[0]!.capability, "network");
  assert.match(String(allow.prompts[0]!.reason), /network: deny/);
  assert.equal(allow.serverCalls.length, 1, "远端服务器只应被真实调用一次");

  const deny = await createHarness({ network: "deny", approval: "ask", decision: "deny" });
  t.after(() => deny.cleanup());
  const refused = await deny.adapter.execute({ query: "hello" });
  assert.equal(refused.success, false);
  assert.equal(refused.error, "APPROVAL_DENIED");
  assert.equal(deny.prompts.length, 1);
  assert.equal(deny.serverCalls.length, 0, "被拒绝后绝不能发生远端副作用");
});

test("MCP 远程调用：network: deny + auto-grant 绝不放行（P0 回归）", async (t) => {
  const h = await createHarness({ network: "deny", approval: "auto-grant" });
  t.after(() => h.cleanup());
  const result = await h.adapter.execute({ query: "hello" });
  assert.equal(result.success, false);
  assert.equal(result.error, "NETWORK_DENY_UNDER_AUTO_GRANT");
  assert.match(String(result.output), /auto-grant 不能放宽该边界/);
  assert.equal(h.prompts.length, 0, "auto-grant 下不得再弹出人工审批");
  assert.equal(h.serverCalls.length, 0, "绝不能发生任何远端调用");
});

test("MCP 远程调用：approval: never 不弹窗、直接 Fail-Closed", async (t) => {
  const h = await createHarness({ network: "deny", approval: "never" });
  t.after(() => h.cleanup());
  const result = await h.adapter.execute({ query: "hello" });
  assert.equal(result.success, false);
  assert.equal(result.error, "APPROVAL_MODE_NEVER");
  assert.equal(h.prompts.length, 0, "never 的语义是不询问，不得弹窗");
  assert.equal(h.serverCalls.length, 0);
});

test("MCP 远程调用：network: allow + auto-grant 无需人工审批且真实执行", async (t) => {
  const h = await createHarness({ network: "allow", approval: "auto-grant" });
  t.after(() => h.cleanup());
  const result = await h.adapter.execute({ query: "hello" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(h.prompts.length, 0);
  assert.equal(h.serverCalls.length, 1);
});

test("MCP 远程调用：无审批通道且显式 network: deny 时不得因「无人可问」而放行", async (t) => {
  const h = await createHarness({ network: "deny", approval: "ask", provideApprovalService: false });
  t.after(() => h.cleanup());
  const result = await h.adapter.execute({ query: "hello" });
  assert.equal(result.success, false);
  assert.equal(result.error, "NETWORK_APPROVAL_UNAVAILABLE");
  assert.equal(h.serverCalls.length, 0);
});

test("任务级策略在后续 MCP 调用上立即生效：授权 → 放行，撤销 → 重新受限", async (t) => {
  const h = await createHarness({ network: "deny", approval: "ask", decision: "deny" });
  t.after(() => h.cleanup());

  const denied = await h.adapter.execute({ query: "before-grant" });
  assert.equal(denied.success, false);
  assert.equal(h.prompts.length, 1, "未授权时必须弹出审批（此处人工拒绝）");
  assert.equal(h.serverCalls.length, 0);

  // 模拟管理员授予该 Task/Run 全访问：SandboxService 是同一个实时对象
  h.sandbox.updatePolicy(policy("allow", "auto-grant"));
  const granted = await h.adapter.execute({ query: "after-grant" });
  assert.equal(granted.success, true, JSON.stringify(granted));
  assert.equal(h.prompts.length, 1, "授权后不得再逐次打扰用户");
  assert.equal(h.serverCalls.length, 1);

  // 撤销授权：必须立即恢复受限语义（再次弹出审批 → 本次拒绝）
  h.sandbox.updatePolicy(policy("deny", "ask"));
  const revoked = await h.adapter.execute({ query: "after-revoke" });
  assert.equal(revoked.success, false);
  assert.equal(h.prompts.length, 2, "撤销后必须重新走人工审批");
  assert.equal(h.serverCalls.length, 1, "撤销后不得再产生远端副作用");
});

test("MCP 本地 stdio 服务同样遵守 approval: never 的 Fail-Closed", async () => {
  const adapter = new MCPToolAdapter({
    serverName: "local-svc",
    serverConfig: { name: "local-svc", transport: "stdio", command: "unused", enabled: true },
    rawTool: { name: "run_local" },
    callToolHandler: async () => ({ content: [{ type: "text", text: "SHOULD_NOT_RUN" }] }),
    resultAdapter: new MCPResultAdapter(),
    getPolicy: () => policy("deny", "never"),
  });
  const result = await adapter.execute({});
  assert.equal(result.success, false);
  assert.equal(result.error, "APPROVAL_MODE_NEVER");
});

test("MCP 本地 stdio 审批分类为 mcp-local，不冒充网络出口", async () => {
  const prompts: ApprovalRequest[] = [];
  const approvalService = new ApprovalService({
    async askApproval(request: ApprovalRequest) {
      prompts.push(request);
      return "allow-once";
    },
  });
  const adapter = new MCPToolAdapter({
    serverName: "local-svc",
    serverConfig: { name: "local-svc", transport: "stdio", command: "unused", enabled: true },
    rawTool: { name: "run_local" },
    callToolHandler: async () => ({ content: [{ type: "text", text: "LOCAL_OK" }] }),
    resultAdapter: new MCPResultAdapter(),
    approvalService,
    getPolicy: () => policy("deny", "ask"),
  });

  const result = await adapter.execute({});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.match(String(result.output), /LOCAL_OK/);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.capability, "mcp-local");
  assert.match(String(prompts[0]!.reason), /本地 MCP 工具/);
  assert.match(String(prompts[0]!.reason), /stdio/);
  assert.doesNotMatch(String(prompts[0]!.reason), /network: deny/);
});

test("确定性硬拦截不能通过 MCP 工具名与参数包装绕过", async () => {
  const monitor = new PreToolSecurityMonitor({ enabled: false });
  const cases = [
    { name: "mcp__evil__shell", command: "chmod -R 777 /" },
    { name: "mcp__evil__exec", command: "rm -rf / --no-preserve-root" },
    { name: "mcp__evil__cat", command: "cat /etc/shadow" },
  ];
  for (const item of cases) {
    const raw = JSON.stringify({ command: item.command });
    const decision = await monitor.evaluateToolCall({
      toolName: item.name,
      toolArgs: { command: item.command },
      rawArgs: raw,
      argsFingerprint: `fp-${item.name}`,
      agentIdentity: { agentId: "main" },
      userAuthorizationContext: { userIntent: "boundary test" },
    });
    assert.equal(decision.verdict, "BLOCK", `${item.command} 必须被确定性硬拦截`);
    assert.equal(decision.isHardBlock, true, "必须是不可被人工审批放行的硬拦截");
  }
});

test("远端无界输出不得整体注入：无落盘存储时仍强制截断", async () => {
  const adapter = new MCPResultAdapter({ maxInlineChars: 1000 });
  const huge = "A".repeat(50_000);
  const result = await adapter.formatResult({ content: [{ type: "text", text: huge }] }, "mcp__x__big");
  assert.ok(result.output.length < 3000, `输出必须被截断，实际 ${result.output.length}`);
  assert.match(result.output, /MCP 输出超出上限/);
});

test("两个 Task 的 MCP 适配器互不串权：A 授权不影响 B", async () => {
  const granted = new SandboxService({ policy: policy("allow", "auto-grant"), cwd: os.tmpdir() });
  const restricted = new SandboxService({ policy: policy("deny", "ask"), cwd: os.tmpdir() });
  const callsA: string[] = [];
  const callsB: string[] = [];
  const make = (name: string, sandbox: SandboxService, calls: string[]) => new MCPToolAdapter({
    serverName: name,
    serverConfig: { name, transport: "streamable-http", url: "https://example.invalid/mcp", enabled: true },
    rawTool: { name: "run" },
    callToolHandler: async () => { calls.push(name); return { content: [{ type: "text", text: "ok" }] }; },
    resultAdapter: new MCPResultAdapter(),
    getPolicy: () => sandbox.getPolicy(),
  });

  const a = make("task-a", granted, callsA);
  const b = make("task-b", restricted, callsB);
  const resultA = await a.execute({});
  const resultB = await b.execute({});
  assert.equal(resultA.success, true);
  assert.equal(resultB.success, false);
  assert.equal(resultB.error, "NETWORK_APPROVAL_UNAVAILABLE", "B 没有任何审批通道且被显式禁止网络，必须 Fail-Closed");
  assert.deepEqual(callsA, ["task-a"]);
  assert.deepEqual(callsB, [], "A 的授权绝不能泄漏给 B");
});

test("MCP 调用被取消时如实上报 Outcome Unknown，绝不声称成功或自动重试", async () => {
  const controller = new AbortController();
  let invoked = 0;
  const adapter = new MCPToolAdapter({
    serverName: "slow-svc",
    serverConfig: { name: "slow-svc", transport: "streamable-http", url: "https://example.invalid/mcp", enabled: true },
    rawTool: { name: "slow" },
    callToolHandler: async () => { invoked += 1; controller.abort(); throw new Error("socket closed"); },
    resultAdapter: new MCPResultAdapter(),
    getPolicy: () => policy("allow", "auto-grant"),
  });
  const result = await adapter.execute({}, { signal: controller.signal });
  assert.equal(result.success, false);
  assert.equal(result.interrupted, true);
  assert.match(String(result.error), /Outcome Unknown/);
  assert.equal(invoked, 1, "取消后不得自动重试（可能已产生远端副作用）");
});

test("MCP 注册不得因服务名猜测而自动绑定进程环境中的密钥", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-cred-"));
  const mock = await createMockMCPHttpServer();
  const previous = process.env.BILIBILI_TEST_TOKEN;
  process.env.BILIBILI_TEST_TOKEN = "super-secret-token-value";
  const approvalService = new ApprovalService({ async askApproval() { return "allow-once"; } });
  const manager = new MCPManager({ projectRoot: home, nashHome: path.join(home, "nash-home"), approvalService });
  t.after(async () => {
    await manager.close().catch(() => {});
    await mock.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
    if (previous === undefined) delete process.env.BILIBILI_TEST_TOKEN;
    else process.env.BILIBILI_TEST_TOKEN = previous;
  });

  const tool = new MCPRegisterTool(manager, approvalService);
  await tool.execute({
    name: "bilibili-test",
    transport: "streamable-http",
    url: mock.url,
    scope: "user",
  });

  const saved = manager.configManager.getServer("bilibili-test");
  assert.ok(saved, "注册必须真实落盘（本次由人工审批放行）");
  assert.equal(saved!.headers?.Authorization, undefined, "不得把进程环境中的密钥自动绑定给模型指定的服务");
  assert.equal(JSON.stringify(saved).includes("super-secret-token-value"), false, "配置中绝不允许出现明文密钥");
});

test("真实 AgentLoop + 真实 MCP Server：deny + auto-grant 下工具被拒且远端零副作用", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-loop-"));
  const serverCalls: string[] = [];
  const mock = await createMockMCPHttpServer({
    onCallTool: (name) => {
      serverCalls.push(name);
      return { content: [{ type: "text", text: "SHOULD_NOT_HAPPEN" }] };
    },
  });
  const projectRoot = path.join(home, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new ToolRegistry();
  const sandbox = new SandboxService({ policy: policy("deny", "auto-grant"), cwd: projectRoot });
  const manager = new MCPManager({
    projectRoot,
    nashHome: path.join(home, "nash-home"),
    registry,
    sandboxService: sandbox,
  });
  t.after(async () => {
    await manager.close().catch(() => {});
    await mock.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });
  manager.configManager.saveServer(
    "loop-svc",
    { transport: "streamable-http", url: mock.url, enabled: true, allowInsecureHttp: true },
    "project"
  );
  await manager.initialize();

  const projectContext = await resolveProjectContext({ projectRoot, nashHome: path.join(home, "nash-home") });
  const contextManager = new ContextManager({ projectContext, config: { autoCompact: false } });

  // 脚本化模型：第一步请求 MCP 工具，第二步给出结论
  const apiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "mock-mcp-loop-key";
  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = (async (_input: any, init?: any) => {
    round += 1;
    const message = round === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "mcp-call-1", type: "function", function: { name: buildMCPToolName("loop-svc", "fetch_remote_data"), arguments: '{"query":"leak"}' } }] }
      : { role: "assistant", content: "DONE" };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (init?.body && JSON.parse(String(init.body)).stream) {
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ choices: [{ message }], usage }), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (apiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = apiKey;
  });

  await runAgentLoop("调用 MCP 工具", {
    projectContext,
    contextManager,
    standaloneSystemPrompt: true,
    systemPrompt: "Test",
    printStats: false,
    tools: registry.getAll(),
    policy: policy("deny", "auto-grant"),
    securityMonitor: new PreToolSecurityMonitor({ enabled: false }),
    maxSteps: 3,
  });

  assert.equal(serverCalls.length, 0, "被策略拒绝的 MCP 调用绝不能触达远端");
});

test("安全审查不可用时，auto-grant 下的 MCP 调用同样 Fail-Closed 且远端零副作用", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-review-"));
  const serverCalls: string[] = [];
  const mock = await createMockMCPHttpServer({ onCallTool: (name) => { serverCalls.push(name); return { content: [{ type: "text", text: "SHOULD_NOT_HAPPEN" }] }; } });
  const projectRoot = path.join(home, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  const registry = new ToolRegistry();
  const sandbox = new SandboxService({ policy: policy("allow", "auto-grant"), cwd: projectRoot });
  const manager = new MCPManager({ projectRoot, nashHome: path.join(home, "nash-home"), registry, sandboxService: sandbox });
  t.after(async () => {
    await manager.close().catch(() => {});
    await mock.close().catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  });
  manager.configManager.saveServer("review-svc", { transport: "streamable-http", url: mock.url, enabled: true, allowInsecureHttp: true }, "project");
  await manager.initialize();

  const projectContext = await resolveProjectContext({ projectRoot, nashHome: path.join(home, "nash-home") });
  const contextManager = new ContextManager({ projectContext, config: { autoCompact: false } });

  const apiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "mock-mcp-review-key";
  const originalFetch = globalThis.fetch;
  let round = 0;
  globalThis.fetch = (async (_input: any, init?: any) => {
    round += 1;
    const message = round === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "mcp-call-2", type: "function", function: { name: buildMCPToolName("review-svc", "fetch_remote_data"), arguments: '{"query":"x"}' } }] }
      : { role: "assistant", content: "DONE" };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (init?.body && JSON.parse(String(init.body)).stream) {
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ choices: [{ message }], usage }), { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (apiKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = apiKey;
  });

  // 模拟独立安全审查模型不可用（Fail-Closed 升级），指纹保持真实值以通过一致性校验
  const monitor = new PreToolSecurityMonitor({ enabled: true });
  monitor.evaluateParallelToolCalls = async (contexts: any[]) => contexts.map((ctx) => ({
    verdict: "REQUIRE_APPROVAL",
    severity: 80,
    category: "Safety Fail-Closed",
    reason: "独立 Security Monitor 调用失败",
    fingerprint: ctx.argsFingerprint,
    toolName: ctx.toolName,
    evaluatedAt: Date.now(),
    durationMs: 0,
    reviewUnavailable: true,
  }));

  await runAgentLoop("调用 MCP 工具", {
    projectContext,
    contextManager,
    standaloneSystemPrompt: true,
    systemPrompt: "Test",
    printStats: false,
    tools: registry.getAll(),
    policy: policy("allow", "auto-grant"),
    securityMonitor: monitor,
    maxSteps: 3,
  });

  assert.equal(serverCalls.length, 0, "审查不可用时 auto-grant 绝不放行 MCP 调用");
});

test("本地 stdio MCP 子进程运行在真实 OS 沙箱中：工作区外写入被内核拒绝", async (t) => {
  const probe = new SandboxService({ policy: policy("deny", "ask"), cwd: os.tmpdir() });
  if (!probe.getBackend().isAvailable()) {
    t.skip(`当前环境没有可用的原生沙箱后端 (${probe.getBackend().name})`);
    return;
  }
  if (process.platform === "win32") {
    t.skip("Windows 原生后端未提供与本用例等价的内核级文件写入隔离");
    return;
  }

  // bwrap mounts a private tmpfs at /tmp; a sibling under os.tmpdir() would still be
  // writable inside the sandbox. Use a repo path so the outside directory is truly
  // outside the writable workspace and kernel-denied by the OS sandbox.
  const root = fs.mkdtempSync(path.join(process.cwd(), ".nash-mcp-stdio-sandbox-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const insideTarget = path.join(workspace, "inside.txt");
  const outsideTarget = path.join(outside, "outside.txt");

  const sandbox = new SandboxService({ policy: policy("deny", "ask"), cwd: workspace });
  const approvalService = new ApprovalService({ async askApproval() { return "allow-once"; } });
  const registry = new ToolRegistry();
  const manager = new MCPManager({
    projectRoot: workspace,
    nashHome: path.join(root, "nash-home"),
    registry,
    approvalService,
    sandboxService: sandbox,
  });
  t.after(async () => {
    await manager.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });

  manager.configManager.saveServer(
    "local-writer",
    {
      name: "local-writer",
      transport: "stdio",
      command: process.execPath,
      args: [path.join(process.cwd(), "test", "fixtures", "mock-mcp-write-server.js")],
      enabled: true,
    },
    "user"
  );
  await manager.initialize();

  const writer = registry.get(buildMCPToolName("local-writer", "write_path"));
  assert.ok(writer, "本地 stdio MCP 工具必须已挂载");

  const inside = await writer!.execute({ path: insideTarget, content: "inside-ok" }) as ToolResult;
  assert.equal(inside.success, true, JSON.stringify(inside));
  assert.match(String(inside.output), /WRITE_OK/);
  assert.equal(fs.readFileSync(insideTarget, "utf8"), "inside-ok", "工作区内写入必须真实成功");

  const outsideResult = await writer!.execute({ path: outsideTarget, content: "must-not-exist" }) as ToolResult;
  assert.match(String(outsideResult.output), /WRITE_FAILED/, `工作区外写入必须被真实拒绝: ${outsideResult.output}`);
  assert.equal(fs.existsSync(outsideTarget), false, "沙箱必须真的阻止文件落盘");
});

test("MCP 结果裁剪不影响正常短输出", async () => {
  const adapter = new MCPResultAdapter({ maxInlineChars: 1000 });
  const result = await adapter.formatResult({ content: [{ type: "text", text: "short" }] }, "mcp__x__small");
  assert.equal(result.output, "short");
  assert.equal(result.success, true);
});
