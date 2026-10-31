import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { MCPConnectionManager } from "../src/mcp/mcp-connection-manager.js";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { createMockMCPHttpServer } from "./fixtures/mock-http-server.js";

test("MCP Protocol Integration: Real stdio Subprocess", async (t) => {
  const stdioScript = path.resolve("test/fixtures/mock-mcp-server-stdio.js");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-stdio-spill-"));
  const spillStore = new LocalSpillStore({ baseDir: tmpDir });

  const manager = new MCPManager({
    projectRoot: process.cwd(),
    spillStore,
  });

  manager.connectionManager.registerServer("local-stdio", {
    transport: "stdio",
    command: "node",
    args: [stdioScript],
    enabled: true,
  });

  await t.test("stdio 真实握手、协议版本读取与能力发现", async () => {
    await manager.connectionManager.connect("local-stdio");
    const status = manager.getStatus("local-stdio");

    assert.ok(status !== undefined);
    assert.equal(status?.status, "connected");
    assert.equal(status?.transport, "stdio");
    assert.equal(status?.toolCount, 3);
    assert.ok(status?.toolCount >= 3);
  });

  await t.test("stdio 真实工具调用 echo_stdio & calculate_sum", async () => {
    const echoRes: any = await manager.connectionManager.callTool(
      "local-stdio",
      "echo_stdio",
      { message: "Nash Stdio Integration" }
    );
    assert.equal(echoRes.content[0]?.text, "Stdio Echo: Nash Stdio Integration");

    const sumRes: any = await manager.connectionManager.callTool(
      "local-stdio",
      "calculate_sum",
      { a: 15, b: 27 }
    );
    assert.equal(sumRes.content[0]?.text, "Result: 42");
  });

  await t.test("stdio 工具调用大结果触发 SpillStore 自动溢出落盘保护", async () => {
    // 请求生成 2000 行大文本
    const rawResult = await manager.connectionManager.callTool(
      "local-stdio",
      "generate_large_output",
      { lines: 2500 }
    );

    const formatted = await manager.resultAdapter.formatResult(
      rawResult,
      "mcp__local_stdio__generate_large_output"
    );

    assert.equal(formatted.success, true);
    assert.ok(
      formatted.output.includes("[MCP Tool Result Exceeded Limit - Automatically Spilled]")
    );
    assert.ok(formatted.output.includes("Artifact Locator:"));
    assert.ok(formatted.output.includes("read_tool_result"));
  });

  await t.test("stdio 读取 Resources 与 Prompts", async () => {
    const rawRes: any = await manager.connectionManager.readResource(
      "local-stdio",
      "stdio://test/sample-doc"
    );
    assert.ok(rawRes.contents[0]?.text.includes("Hello from stdio MCP resource content!"));

    const promptRes: any = await manager.connectionManager.getPrompt(
      "local-stdio",
      "test_prompt",
      { topic: "TypeScript Sandbox" }
    );
    assert.ok(
      promptRes.messages[0]?.content?.text.includes("tutorial on TypeScript Sandbox")
    );
  });

  await manager.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("MCP Protocol Integration: Streamable HTTP & Reconnection", async (t) => {
  const mockHttp = await createMockMCPHttpServer({
    bearerToken: "valid_secret_token",
    protocolVersion: "2025-03-26",
  });

  process.env.TEST_HTTP_MCP_TOKEN = "valid_secret_token";

  const connMgr = new MCPConnectionManager({
    cwd: process.cwd(),
  });

  await t.test("缺少或错误 Bearer Token 时握手失败 (HTTP 401)", async () => {
    connMgr.registerServer("unauthorized-srv", {
      transport: "streamable-http",
      url: mockHttp.url,
      headers: {
        Authorization: "Bearer invalid_wrong_token",
      },
      enabled: true,
      allowInsecureHttp: true,
    });

    await assert.rejects(
      () => connMgr.connect("unauthorized-srv"),
      (err: any) => {
        return (
          err.message.includes("401") ||
          err.message.includes("Unauthorized") ||
          err.message.includes("ClientHttpAuthentication")
        );
      }
    );

    const status = connMgr.getStatus("unauthorized-srv");
    assert.equal(status?.status, "failed");
  });

  await t.test("有效 Bearer Token 成功协商并发现工具", async () => {
    connMgr.registerServer("valid-srv", {
      transport: "streamable-http",
      url: mockHttp.url,
      headers: {
        Authorization: "Bearer ${TEST_HTTP_MCP_TOKEN}",
      },
      enabled: true,
      allowInsecureHttp: true,
    });

    await connMgr.connect("valid-srv");
    const status = connMgr.getStatus("valid-srv");
    assert.equal(status?.status, "connected");
    assert.equal(status?.toolCount, 2);
    assert.equal(status?.protocolVersion, "2025-03-26");

    const tools = connMgr.getTools("valid-srv");
    assert.equal(tools[0]?.name, "fetch_remote_data");
    assert.equal(tools[1]?.name, "side_effect_deploy");
  });

  await t.test("调用 HTTP 工具成功", async () => {
    const res: any = await connMgr.callTool("valid-srv", "fetch_remote_data", {
      query: "SELECT * FROM users",
    });
    assert.ok(
      res.content[0]?.text.includes("Remote data query response for 'SELECT * FROM users'")
    );
  });

  await t.test("网络异常断线时禁止盲目重试有副作用的工具 (Outcome Unknown 防护)", async () => {
    // 模拟服务端在收到请求时网络断开连接
    mockHttp.simulateDisconnect();
    await mockHttp.close();

    await assert.rejects(
      () =>
        connMgr.callTool("valid-srv", "side_effect_deploy", {
          env: "production",
        }),
      (err: any) => {
        return (
          err.message.includes("Outcome Unknown") ||
          err.message.includes("通信异常") ||
          err.message.includes("fetch failed")
        );
      }
    );
  });

  await connMgr.closeAll();
  delete process.env.TEST_HTTP_MCP_TOKEN;
});
