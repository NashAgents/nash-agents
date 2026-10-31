import test from "node:test";
import assert from "node:assert/strict";

import { MCPConnectionManager } from "../src/mcp/mcp-connection-manager.js";
import { MCPResultAdapter } from "../src/mcp/mcp-result-adapter.js";
import { MCPToolAdapter } from "../src/mcp/mcp-tool-adapter.js";

const BILIBILI_ENDPOINT = process.env.NASH_TEST_BILIBILI_MCP_URL ?? "";

test("Bilibili MCP Live E2E Suite (explicit endpoint)", { skip: process.env.NASH_RUN_LIVE_TESTS !== "1" || !BILIBILI_ENDPOINT ? "Requires NASH_RUN_LIVE_TESTS=1 and NASH_TEST_BILIBILI_MCP_URL" : false }, async (t) => {
  const token = process.env.BILIBILI_MCP_TOKEN;

  await t.test("真实公网端点无 Token 或错误 Token 时正确返回 401 拦截", async () => {
    const connMgr = new MCPConnectionManager();
    connMgr.registerServer("bilibili-unauthorized", {
      transport: "streamable-http",
      url: BILIBILI_ENDPOINT,
      headers: {
        Authorization: "Bearer invalid_test_token_999",
      },
      enabled: true,
      timeoutMs: 15000,
    });

    try {
      await assert.rejects(
        async () => {
          for (let attempt = 0; ; attempt++) {
            try { return await connMgr.connect("bilibili-unauthorized"); }
            catch (error) {
              const message = String((error as Error).message ?? "");
              if (attempt >= 1 || !/fetch failed|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(message)) throw error;
              // No tool call or authenticated operation occurred; retry only the failed auth handshake.
            }
          }
        },
        (err: any) => /401|Unauthorized|ClientHttpAuthentication/.test(String(err?.message || ""))
      );
      assert.equal(connMgr.getStatus("bilibili-unauthorized")?.status, "failed");
    } finally {
      await connMgr.closeAll();
    }
  });

  if (!token) {
    t.skip("BILIBILI_MCP_TOKEN is required for authenticated live coverage");
    console.log(
      "\x1b[33m[INFO] BILIBILI_MCP_TOKEN 环境变量未在当前进程中配置，真实工具调用与字幕提取测试如实标记为跳过。\x1b[0m"
    );
    return;
  }

  // 以下测试仅在具备真实有效凭证时执行
  const connMgr = new MCPConnectionManager();
  t.after(() => connMgr.closeAll());
  const resultAdapter = new MCPResultAdapter();

  connMgr.registerServer("bilibili-subtitles", {
    transport: "streamable-http",
    url: BILIBILI_ENDPOINT,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    enabled: true,
    timeoutMs: 30000,
  });

  await t.test("真实连接公网 Bilibili MCP 并完成协议握手", async () => {
    await connMgr.connect("bilibili-subtitles");
    const status = connMgr.getStatus("bilibili-subtitles");

    assert.equal(status?.status, "connected");
    assert.ok(status?.toolCount >= 2);
    console.log(`  Protocol Version: ${status?.protocolVersion || "negotiated"}`);
    console.log(`  Discovered Tools: ${status?.toolCount}`);
  });

  await t.test("真实 tools/list 包含 extract_bilibili_subtitles 与 list_bilibili_subtitles", () => {
    const tools = connMgr.getTools("bilibili-subtitles");
    const toolNames = tools.map((t) => t.name);

    assert.ok(toolNames.includes("extract_bilibili_subtitles"));
    assert.ok(toolNames.includes("list_bilibili_subtitles"));
  });

  await t.test("真实调用 list_bilibili_subtitles (BV1zPaz6RErV)", async () => {
    const rawRes: any = await connMgr.callTool(
      "bilibili-subtitles",
      "list_bilibili_subtitles",
      { url: "BV1zPaz6RErV" }
    );

    const formatted = await resultAdapter.formatResult(
      rawRes,
      "mcp__bilibili-subtitles__list_bilibili_subtitles"
    );

    assert.equal(formatted.success, true);
    assert.ok(formatted.output.length > 0);
    console.log(`  list_bilibili_subtitles response length: ${formatted.output.length}`);
  });

  await t.test("真实提取字幕 extract_bilibili_subtitles (BV1zPaz6RErV, page 1)", async () => {
    const rawRes: any = await connMgr.callTool(
      "bilibili-subtitles",
      "extract_bilibili_subtitles",
      {
        url: "BV1zPaz6RErV",
        format: "clean",
        page: 1,
      }
    );

    const formatted = await resultAdapter.formatResult(
      rawRes,
      "mcp__bilibili-subtitles__extract_bilibili_subtitles"
    );

    assert.equal(formatted.success, true);
    assert.ok(formatted.output.length > 0);
    console.log(`  extract_bilibili_subtitles output preview:\n${formatted.output.slice(0, 150)}...\n`);
  });

  await connMgr.closeAll();
});
