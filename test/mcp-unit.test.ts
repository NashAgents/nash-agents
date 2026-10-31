import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  resolveEnvString,
  resolveEnvRecord,
  redactHeaders,
  validateMCPUrl,
  buildSanitizedStdioEnv,
  MissingEnvVarError,
  MCPSecurityError,
} from "../src/mcp/mcp-security.js";
import { MCPConfigManager } from "../src/mcp/mcp-config.js";
import { MCPResultAdapter } from "../src/mcp/mcp-result-adapter.js";
import { MCPToolAdapter, buildMCPToolName } from "../src/mcp/mcp-tool-adapter.js";
import { MCPToolDiscovery } from "../src/mcp/mcp-tool-discovery.js";
import { SearchMCPToolsTool } from "../src/mcp/mcp-tool-search.js";

test("MCP Security & Sanitization", async (t) => {
  await t.test("resolveEnvString 能够精准插值环境变量，若缺失抛出结构化异常", () => {
    process.env.TEST_MCP_TOKEN = "secret_token_123";
    const resolved = resolveEnvString("Bearer ${TEST_MCP_TOKEN}");
    assert.equal(resolved, "Bearer secret_token_123");

    assert.throws(
      () => resolveEnvString("Bearer ${UNDEFINED_SECRET_KEY_999}"),
      MissingEnvVarError
    );
    delete process.env.TEST_MCP_TOKEN;
  });

  await t.test("redactHeaders 对 Authorization 与敏感 Header 严格脱敏", () => {
    const headers = {
      Authorization: "Bearer secret_xyz_123456",
      "X-MCP-Token": "top_secret_token",
      "Content-Type": "application/json",
      "x-api-key": "secret_key_888",
    };
    const redacted = redactHeaders(headers);

    assert.equal(redacted.Authorization, "Bearer [REDACTED]");
    assert.equal(redacted["X-MCP-Token"], "[REDACTED]");
    assert.equal(redacted["x-api-key"], "[REDACTED]");
    assert.equal(redacted["Content-Type"], "application/json");
  });

  await t.test("validateMCPUrl 拒绝非 loopback 的不安全 HTTP，允许 HTTPS 与 localhost", () => {
    // 允许合法 HTTPS
    assert.doesNotThrow(() => validateMCPUrl("https://mcp.example.com/mcp"));
    // 允许本地 loopback HTTP
    assert.doesNotThrow(() => validateMCPUrl("http://localhost:8080/mcp"));
    assert.doesNotThrow(() => validateMCPUrl("http://127.0.0.1:3000/sse"));

    // 拒绝公网明文 HTTP (未指定 allowInsecureHttp)
    assert.throws(
      () => validateMCPUrl("http://api.example.com/mcp"),
      MCPSecurityError
    );

    // 显式允许时通过
    assert.doesNotThrow(() => validateMCPUrl("http://api.example.com/mcp", true));
  });

  await t.test("buildSanitizedStdioEnv 严格清洗，杜绝 DEEPSEEK_API_KEY 等私密 Token 泄漏至子进程", () => {
    process.env.DEEPSEEK_API_KEY = "super_private_deepseek_key";
    process.env.OPENAI_API_KEY = "super_private_openai_key";
    process.env.SAFE_CUSTOM_VAR = "my_custom_value";

    const sanitized = buildSanitizedStdioEnv({
      CUSTOM_USER_PARAM: "${SAFE_CUSTOM_VAR}",
    });

    assert.equal(sanitized.DEEPSEEK_API_KEY, undefined);
    assert.equal(sanitized.OPENAI_API_KEY, undefined);
    assert.equal(sanitized.CUSTOM_USER_PARAM, "my_custom_value");
    assert.ok(sanitized.PATH !== undefined);

    delete process.env.SAFE_CUSTOM_VAR;
  });
});

test("MCP Config Manager & Scope Merge", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-cfg-test-"));
  const globalDir = path.join(tmpDir, "global");
  const projectDir = path.join(tmpDir, "project");
  fs.mkdirSync(globalDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const globalConfigPath = path.join(globalDir, "settings.json");
  const projectConfigPath = path.join(projectDir, "settings.json");

  const configManager = new MCPConfigManager({
    projectRoot: projectDir,
    homeDir: globalDir,
    globalConfigPath,
    projectConfigPath,
  });

  await t.test("能够添加全局与项目级配置，且同名服务项目级优先覆盖", () => {
    // 1. 添加全局服务
    configManager.saveServer(
      "remote-tools",
      {
        transport: "streamable-http",
        url: "https://example.com/global",
        enabled: true,
      },
      "global"
    );

    // 2. 添加仅项目级的独有服务
    configManager.saveServer(
      "local-dev",
      {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        enabled: true,
      },
      "project"
    );

    // 3. 在项目级覆盖 remote-tools
    configManager.saveServer(
      "remote-tools",
      {
        transport: "streamable-http",
        url: "https://example.com/project-override",
        enabled: true,
      },
      "project"
    );

    const all = configManager.loadAllServers();
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all["remote-tools"]?.url, "https://example.com/project-override");
    assert.equal(all["remote-tools"]?.scope, "project");
    assert.equal(all["local-dev"]?.scope, "project");

    // 移除项目级覆盖后，自动回退到全局服务配置
    configManager.removeServer("remote-tools", "project");
    const fallbackAll = configManager.loadAllServers();
    assert.equal(fallbackAll["remote-tools"]?.url, "https://example.com/global");
    assert.equal(fallbackAll["remote-tools"]?.scope, "global");
  });

  // 清理临时目录
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("MCP Tool Adapter & Discovery", async (t) => {
  const resultAdapter = new MCPResultAdapter();

  await t.test("buildMCPToolName 生成标准化唯一工具名", () => {
    assert.equal(
      buildMCPToolName("bilibili-subtitles", "extract_bilibili_subtitles"),
      "mcp__bilibili-subtitles__extract_bilibili_subtitles"
    );
  });

  await t.test("MCPToolAdapter 遵守 allowTools 与 denyTools 访问控制", async () => {
    const mockCall = async () => ({ content: [{ type: "text", text: "success" }] });

    const adapterAllowed = new MCPToolAdapter({
      serverName: "test-srv",
      serverConfig: {
        transport: "streamable-http",
        allowTools: ["extract_*"], // 未匹配
        denyTools: ["delete_database"],
      },
      rawTool: {
        name: "delete_database",
      },
      callToolHandler: mockCall,
      resultAdapter,
    });

    const resDeny = await adapterAllowed.execute({});
    assert.equal(resDeny.success, false);
    assert.equal(resDeny.error, "TOOL_DENIED_BY_POLICY");
  });

  await t.test("MCPToolDiscovery 索引工具并在关键词搜索时返回相关候选", () => {
    const discovery = new MCPToolDiscovery();
    discovery.updateIndex([
      {
        name: "extract_bilibili_subtitles",
        description: "提取 Bilibili 视频字幕文档",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" }, page: { type: "integer" } },
          required: ["url"],
        },
        serverName: "bilibili-subtitles",
      },
      {
        name: "list_bilibili_subtitles",
        description: "查询分 P 列表与字幕语言清单",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
        serverName: "bilibili-subtitles",
      },
      {
        name: "query_postgres_table",
        description: "执行只读 SQL 查询",
        inputSchema: { type: "object", properties: { sql: { type: "string" } } },
        serverName: "db-server",
      },
    ]);

    assert.equal(discovery.getTotalToolCount(), 3);
    const matches = discovery.search("subtitle bilibili");
    assert.equal(matches.length, 2);
    assert.equal(matches[0]?.serverName, "bilibili-subtitles");

    const sqlMatches = discovery.search("postgres sql");
    assert.equal(sqlMatches.length, 1);
    assert.equal(sqlMatches[0]?.rawToolName, "query_postgres_table");
  });

  await t.test("SearchMCPToolsTool 执行搜索并触发动态激活钩子", async () => {
    const discovery = new MCPToolDiscovery();
    discovery.updateIndex([
      {
        name: "extract_bilibili_subtitles",
        description: "提取 Bilibili 视频字幕文档",
        inputSchema: { type: "object" },
        serverName: "bilibili-subtitles",
      },
    ]);

    let activatedTools: string[] = [];
    const searchTool = new SearchMCPToolsTool(discovery, {
      onToolsFound: (tools) => {
        activatedTools = tools;
      },
    });

    const res = await searchTool.execute({ query: "subtitle" });
    assert.equal(res.success, true);
    assert.ok(res.output.includes("mcp__bilibili-subtitles__extract_bilibili_subtitles"));
    assert.equal(activatedTools.length, 1);
  });
});
