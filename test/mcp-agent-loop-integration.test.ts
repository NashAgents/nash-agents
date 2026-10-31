import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { ToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/tools/executor.js";
import { HookManager } from "../src/middleware/hook-manager.js";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import { createMockMCPHttpServer } from "./fixtures/mock-http-server.js";

test("MCP & ToolExecutor Integration: Lifecycle Hooks & Approval", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-agentloop-test-"));
  const mockHttp = await createMockMCPHttpServer();

  const registry = new ToolRegistry();
  const hookManager = new HookManager();
  const executor = new ToolExecutor(registry, hookManager);

  const approvalService = new ApprovalService({
    async askApproval() {
      return "allow-once";
    },
  });

  const manager = new MCPManager({
    projectRoot: tmpDir,
    nashHome: path.join(tmpDir, "nash-home"),
    registry,
    approvalService,
  });
  const previousTestToken = process.env.TEST_TOKEN;
  t.after(async () => {
    try { await manager.close(); }
    finally {
      try { await mockHttp.close(); }
      finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (previousTestToken === undefined) delete process.env.TEST_TOKEN;
        else process.env.TEST_TOKEN = previousTestToken;
      }
    }
  });

  manager.configManager.saveServer(
    "calc-service",
    {
      transport: "streamable-http",
      url: mockHttp.url,
      enabled: true,
      allowInsecureHttp: true,
    },
    "project"
  );

  await manager.initialize();

  await t.test("MCP 工具成功挂载至 ToolRegistry 并导出标准 Function Calling Schema", () => {
    assert.ok(registry.has("mcp__calc-service__fetch_remote_data"));
    const defs = registry.getDefinitions();
    const mcpDef = defs.find(
      (d) => d.function.name === "mcp__calc-service__fetch_remote_data"
    );
    assert.ok(mcpDef !== undefined);
    assert.ok(mcpDef?.function.description?.includes("[MCP: calc-service]"));
    assert.equal(mcpDef?.function.parameters?.type, "object");
  });

  await t.test("ToolExecutor 统一执行 MCP 工具并完整触发 Hook 链", async () => {
    const hookEvents: string[] = [];

    hookManager.register("beforeToolExecute", async (ctx) => {
      hookEvents.push(`before:${ctx.toolName}`);
    });

    hookManager.register("afterToolExecute", async (ctx) => {
      hookEvents.push(`after:${ctx.toolName}`);
    });

    const executionRes = await executor.executeToolCall({
      id: "call_mcp_123",
      type: "function",
      function: {
        name: "mcp__calc-service__fetch_remote_data",
        arguments: JSON.stringify({ query: "SELECT version()" }),
      },
    });

    assert.equal(executionRes.role, "tool");
    assert.equal(executionRes.tool_call_id, "call_mcp_123");
    assert.equal(executionRes.result.success, true);
    assert.ok(
      executionRes.result.output.includes("Remote data query response for 'SELECT version()'")
    );

    assert.deepEqual(hookEvents, [
      "before:mcp__calc-service__fetch_remote_data",
      "after:mcp__calc-service__fetch_remote_data",
    ]);
  });

  await t.test("自然语言注册 MCP并在同一 Session 下一轮立即调用（热更新闭环）", async () => {
    // 初始状态下不存在 dyn-srv
    assert.equal(registry.has("mcp__dyn-srv__fetch_remote_data"), false);

    // 1. LLM 调用 mcp_propose_add
    const proposeTool = registry.get("mcp_propose_add");
    assert.ok(proposeTool);
    const proposeRes = (await proposeTool.execute({
      url: mockHttp.url,
      name: "dyn-srv",
    })) as any;
    assert.equal(proposeRes.success, true);
    const proposal = JSON.parse(proposeRes.output);

    // 2. LLM 经确认后调用 mcp_register
    process.env.TEST_TOKEN = "dynamic_test_secret";
    const registerTool = registry.get("mcp_register");
    assert.ok(registerTool);
    const regRes = (await registerTool.execute({
      confirmationToken: proposal.proposalId,
      bearerEnv: "TEST_TOKEN",
    })) as any;
    assert.equal(regRes.success, true);

    // 3. 验证 ToolRegistry 已动态刷新且导出 Schema
    assert.equal(registry.has("mcp__dyn-srv__fetch_remote_data"), true);
    const latestDefs = registry.getDefinitions();
    const dynToolDef = latestDefs.find((d) => d.function.name === "mcp__dyn-srv__fetch_remote_data");
    assert.ok(dynToolDef !== undefined);

    // 4. 下一轮立即直接通过 ToolExecutor 调用新增工具，获得远程执行结果
    const callResult = await executor.execute("mcp__dyn-srv__fetch_remote_data", {
      query: "hello-dynamic-mcp",
    });
    assert.equal(callResult.success, true);
    assert.ok(callResult.output.includes("hello-dynamic-mcp"));
  });

});
