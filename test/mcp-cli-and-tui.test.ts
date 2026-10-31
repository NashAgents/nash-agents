import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { runNashMcp } from "../src/cli/mcp-cli.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { createMockMCPHttpServer } from "./fixtures/mock-http-server.js";

test("MCP CLI & TUI /mcp Command Suite", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-cli-test-"));
  const prevCwd = process.cwd();
  process.chdir(tmpDir);

  const mockHttp = await createMockMCPHttpServer({
    bearerToken: "test_secret_123",
  });
  process.env.MY_TEST_TOKEN = "test_secret_123";

  // 捕获控制台输出
  let outputLogs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const captureStart = () => {
    outputLogs = [];
    console.log = (...args) => outputLogs.push(args.join(" "));
    console.error = (...args) => outputLogs.push(args.join(" "));
  };
  const captureStop = () => {
    console.log = originalLog;
    console.error = originalError;
  };

  await t.test("nash mcp add: 注册远程服务，配置文件中仅保存环境变量引用", async () => {
    captureStart();
    const code = await runNashMcp([
      "add",
      "demo-srv",
      "--transport",
      "streamable-http",
      "--url",
      mockHttp.url,
      "--bearer-env",
      "MY_TEST_TOKEN",
      "--scope",
      "project",
      "--insecure",
    ]);
    captureStop();

    assert.equal(code, 0);
    assert.ok(outputLogs.some((l) => l.includes("registered successfully")));

    // 检查 project settings.json 文件内容，绝无明文 secret
    const settingsPath = path.join(tmpDir, "settings.json");
    assert.ok(fs.existsSync(settingsPath));
    const content = fs.readFileSync(settingsPath, "utf-8");
    assert.ok(content.includes("${MY_TEST_TOKEN}"));
    assert.ok(!content.includes("test_secret_123")); // 绝对不写入明文 Token！
  });

  await t.test("nash mcp list: 正确展示已注册服务及实时连接状态", async () => {
    captureStart();
    const code = await runNashMcp(["list"]);
    captureStop();

    assert.equal(code, 0);
    const text = outputLogs.join("\n");
    assert.ok(text.includes("demo-srv"));
    assert.ok(text.includes("streamable-http"));
    assert.ok(text.includes("connected"));
  });

  await t.test("nash mcp test: 测试协议初始化握手并报告延时与发现的工具", async () => {
    captureStart();
    const code = await runNashMcp(["test", "demo-srv"]);
    captureStop();

    assert.equal(code, 0);
    const text = outputLogs.join("\n");
    assert.ok(text.includes("Handshake Succeeded"));
    assert.ok(text.includes("Roundtrip Latency"));
    assert.ok(text.includes("fetch_remote_data"));
  });

  await t.test("nash mcp tools: 列出已发现工具及其参数", async () => {
    captureStart();
    const code = await runNashMcp(["tools", "demo-srv"]);
    captureStop();

    assert.equal(code, 0);
    const text = outputLogs.join("\n");
    assert.ok(text.includes("fetch_remote_data"));
    assert.ok(text.includes("Parameters: query"));
  });

  await t.test("nash mcp disable & enable: 切换服务可用状态", async () => {
    captureStart();
    const disCode = await runNashMcp(["disable", "demo-srv"]);
    captureStop();
    assert.equal(disCode, 0);

    captureStart();
    const enCode = await runNashMcp(["enable", "demo-srv"]);
    captureStop();
    assert.equal(enCode, 0);
  });

  await t.test("REPL /mcp Slash Command 交互测试", async () => {
    const mcpManager = new MCPManager({ projectRoot: tmpDir });
    await mcpManager.initialize();

    const mockTerminalUI: any = {
      renderInfo: (msg: string) => outputLogs.push(msg),
      renderError: (msg: string) => outputLogs.push(msg),
      renderWarning: (msg: string) => outputLogs.push(msg),
    };

    captureStart();
    const result = await handleSlashCommand("/mcp list", {
      inputManager: {} as any,
      terminalUI: mockTerminalUI,
      contextManager: {} as any,
      mcpManager,
    });
    captureStop();

    assert.equal(result.handled, true);
    const text = outputLogs.join("\n");
    assert.ok(text.includes("demo-srv"));
    assert.ok(text.includes("Model Context Protocol (MCP) Servers"));

    await mcpManager.close();
  });

  await t.test("nash mcp remove: 正确清理配置与工具", async () => {
    captureStart();
    const code = await runNashMcp(["remove", "demo-srv", "--scope", "project"]);
    captureStop();
    assert.equal(code, 0);
    assert.ok(outputLogs.some((l) => l.includes("removed successfully")));
  });

  captureStop();
  await mockHttp.close();
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.MY_TEST_TOKEN;
});
