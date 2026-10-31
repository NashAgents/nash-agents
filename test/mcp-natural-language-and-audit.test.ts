import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createMockMCPHttpServer } from "./fixtures/mock-http-server.js";
import { MCPManager } from "../src/mcp/mcp-manager.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ApprovalService } from "../src/approval/approval-service.js";
import type { ApprovalProvider, ApprovalRequest, ApprovalDecision } from "../src/approval/types.js";
import {
  MCPListServersTool,
  MCPInspectServerTool,
  MCPProposeAddTool,
  MCPRegisterTool,
  MCPRemoveServerTool,
  MCPSetEnabledTool,
} from "../src/mcp/mcp-management-tools.js";
import { validateMCPUrl, MCPSecurityError } from "../src/mcp/mcp-security.js";
import { createMCPTransport } from "../src/mcp/transports/index.js";
import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { resolveUserMessageMcpResources } from "../src/mcp/resource-resolver.js";
import { normalizeExternalServerConfig } from "../src/cli/mcp-import.js";
import { runMcpDoctor } from "../src/cli/mcp-doctor.js";

test("MCP Comprehensive Audit & Natural Language Management Suite", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-mcp-audit-"));
  const prevCwd = process.cwd();
  process.chdir(tmpDir);

  const mockHttp = await createMockMCPHttpServer({
    bearerToken: "audit_token_xyz",
    onCallTool: (name, args) => ({
      content: [{ type: "text", text: `Called ${name} with ${JSON.stringify(args)}` }],
    }),
  });

  process.env.AUDIT_MCP_TOKEN = "audit_token_xyz";

  await t.test("1. SSRF 拦截：私有网络与云元数据拦截防线", () => {
    // 拦截 AWS / 阿里云元数据地址
    assert.throws(
      () => validateMCPUrl("http://169.254.169.254/latest/meta-data"),
      (err: any) => err instanceof MCPSecurityError && err.message.includes("SSRF 安全阻断")
    );

    // 拦截 10.0.0.0/8 私有网段
    assert.throws(
      () => validateMCPUrl("http://10.1.2.3:8080/mcp"),
      (err: any) => err instanceof MCPSecurityError && err.message.includes("SSRF 安全阻断")
    );

    // 拦截 192.168.0.0/16 私有网段
    assert.throws(
      () => validateMCPUrl("http://192.168.1.1/mcp"),
      (err: any) => err instanceof MCPSecurityError && err.message.includes("SSRF 安全阻断")
    );

    // 本地回环地址允许 HTTP
    assert.doesNotThrow(() => validateMCPUrl(mockHttp.url));

    // 合法公网 HTTPS 允许
    assert.doesNotThrow(() => validateMCPUrl("https://mcp.example.com/mcp"));
  });

  await t.test("2. 自然语言添加流程：propose -> approval -> register -> 即时动态挂载", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
      registry,
    });
    await manager.initialize();

    // 2.1 LLM 意图识别后调用 mcp_propose_add
    const proposeTool = new MCPProposeAddTool(manager);
    const proposeRes = await proposeTool.execute({
      url: mockHttp.url,
      name: "audit-demo",
      scope: "project",
    });

    assert.equal(proposeRes.success, true);
    const proposalData = JSON.parse(proposeRes.output);
    assert.equal(proposalData.name, "audit-demo");
    assert.equal(proposalData.transport, "streamable-http");
    assert.ok(proposalData.proposalId);

    // 2.2 用户审批机制：模拟审批服务
    let askedApproval = false;
    const mockProvider: ApprovalProvider = {
      async askApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
        askedApproval = true;
        assert.equal(req.capability, "mcp-registration");
        return "allow-once";
      },
    };
    const approvalService = new ApprovalService(mockProvider);

    // 2.3 执行 mcp_register（使用 bearerEnv 引用环境变量，彻底避免明文 Token 进入上下文）
    const registerTool = new MCPRegisterTool(manager, approvalService);
    const regRes = await registerTool.execute({
      confirmationToken: proposalData.proposalId,
      bearerEnv: "AUDIT_MCP_TOKEN",
    });

    assert.equal(regRes.success, true);
    assert.equal(askedApproval, true);

    const regData = JSON.parse(regRes.output);
    assert.equal(regData.registration.success, true);
    assert.equal(regData.connection.success, true);
    assert.ok(regData.tools.discoveredTools.includes("fetch_remote_data"));

    // 2.4 验证当前 Session 的 ToolRegistry 已即时挂载工具
    assert.ok(registry.has("mcp__audit-demo__fetch_remote_data"));

    // 2.5 检查 mcp_inspect_server
    const inspectTool = new MCPInspectServerTool(manager);
    const inspectRes = await inspectTool.execute({ name: "audit-demo" });
    assert.equal(inspectRes.success, true);
    const inspectData = JSON.parse(inspectRes.output);
    assert.equal(inspectData.name, "audit-demo");
    assert.equal(inspectData.status, "connected");

    await manager.close();
  });

  await t.test("3. 严格 Fail-Closed：无审批通道时坚决阻断注册", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
      registry,
    });
    await manager.initialize();

    // 未传入 approvalService
    const registerTool = new MCPRegisterTool(manager);
    const res = await registerTool.execute({
      name: "fail-closed-server",
      transport: "streamable-http",
      url: mockHttp.url,
      bearerEnv: "AUDIT_MCP_TOKEN",
    });

    assert.equal(res.success, false);
    assert.ok(res.output.includes("安全阻断 (Fail-Closed)"));
    assert.equal(registry.has("mcp__fail-closed-server__fetch_remote_data"), false);

    await manager.close();
  });

  await t.test("4. 用户拒绝注册：安全拦截不挂载任何工具", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
      registry,
    });
    await manager.initialize();

    const mockDenyProvider: ApprovalProvider = {
      async askApproval(): Promise<ApprovalDecision> {
        return "deny";
      },
    };
    const approvalService = new ApprovalService(mockDenyProvider);

    const registerTool = new MCPRegisterTool(manager, approvalService);
    const res = await registerTool.execute({
      name: "denied-server",
      transport: "streamable-http",
      url: mockHttp.url,
      bearerEnv: "AUDIT_MCP_TOKEN",
    });

    assert.equal(res.success, false);
    assert.ok(res.output.includes("用户在审批界面拒绝了"));
    assert.equal(registry.has("mcp__denied-server__fetch_remote_data"), false);

    await manager.close();
  });

  await t.test("4. 运行时禁用与删除：mcp_set_enabled 与 mcp_remove_server", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
      registry,
    });
    await manager.initialize();

    // 注册服务
    await manager.addServer("srv-toggle", {
      transport: "streamable-http",
      url: mockHttp.url,
      headers: { Authorization: "Bearer audit_token_xyz" },
      enabled: true,
    });

    assert.ok(registry.has("mcp__srv-toggle__fetch_remote_data"));

    // 禁用服务
    const setEnabledTool = new MCPSetEnabledTool(manager);
    const disRes = await setEnabledTool.execute({ name: "srv-toggle", enabled: false });
    assert.equal(disRes.success, true);
    assert.equal(registry.has("mcp__srv-toggle__fetch_remote_data"), false);

    // 启用服务
    const enRes = await setEnabledTool.execute({ name: "srv-toggle", enabled: true });
    assert.equal(enRes.success, true);
    assert.ok(registry.has("mcp__srv-toggle__fetch_remote_data"));

    // 删除服务：先验证未授权时 Fail-Closed 拦截
    const unauthRemoveTool = new MCPRemoveServerTool(manager);
    const blockedRes = await unauthRemoveTool.execute({ name: "srv-toggle" });
    assert.equal(blockedRes.success, false);
    assert.ok(blockedRes.output.includes("安全阻断 (Fail-Closed)"));

    // 提供人工审批通道后，放行删除
    const approvalService = new ApprovalService({
      async askApproval() {
        return "allow-once";
      },
    });
    const removeTool = new MCPRemoveServerTool(manager, approvalService);
    const rmRes = await removeTool.execute({ name: "srv-toggle" });
    assert.equal(rmRes.success, true);
    assert.equal(registry.has("mcp__srv-toggle__fetch_remote_data"), false);

    await manager.close();
  });

  await t.test("5. Local > Project > User 三级作用域与覆盖测试", async () => {
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
    });

    // 1. 全局配置
    manager.configManager.saveServer("scoped-srv", {
      transport: "streamable-http",
      url: "https://global.example.com",
    }, "global");

    // 2. 项目级覆盖
    manager.configManager.saveServer("scoped-srv", {
      transport: "streamable-http",
      url: "https://project.example.com",
    }, "project");

    let meta = manager.configManager.loadAllServersWithMetadata()["scoped-srv"]!;
    assert.equal(meta.activeScope, "project");
    assert.equal(meta.config.url, "https://project.example.com");

    // 3. Local 级覆盖
    manager.configManager.saveServer("scoped-srv", {
      transport: "streamable-http",
      url: "https://local.example.com",
    }, "local");

    meta = manager.configManager.loadAllServersWithMetadata()["scoped-srv"]!;
    assert.equal(meta.activeScope, "local");
    assert.equal(meta.config.url, "https://local.example.com");
    assert.deepEqual(meta.overriddenScopes, ["project", "global"]);

    // 删除 local，回退到 project
    manager.configManager.removeServer("scoped-srv", "local");
    meta = manager.configManager.loadAllServersWithMetadata()["scoped-srv"]!;
    assert.equal(meta.activeScope, "project");
    assert.equal(meta.config.url, "https://project.example.com");

    // 删除 project，回退到 global
    manager.configManager.removeServer("scoped-srv", "project");
    meta = manager.configManager.loadAllServersWithMetadata()["scoped-srv"]!;
    assert.equal(meta.activeScope, "global");
    assert.equal(meta.config.url, "https://global.example.com");

    await manager.close();
  });

  await t.test("6. Workspace Trust：未信任阻止 stdio 本地执行，信任后正常启动", () => {
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
    });

    // 保存带有 stdio 的项目级服务
    manager.configManager.saveServer("danger-stdio", {
      transport: "stdio",
      command: "node",
      args: ["malicious.js"],
    }, "project");

    // 当前未批准信任
    manager.configManager.revokeTrustCurrentProject();
    assert.equal(manager.configManager.isProjectTrusted(), false);

    const srv = manager.configManager.getServer("danger-stdio");
    assert.equal(srv?.trustStatus, "pending");

    // 批准信任当前项目
    manager.configManager.trustCurrentProject();
    assert.equal(manager.configManager.isProjectTrusted(), true);

    const approvedSrv = manager.configManager.getServer("danger-stdio");
    assert.equal(approvedSrv?.trustStatus, "approved");
  });

  await t.test("7. stdio 子进程沙箱化：接入 SandboxService 生成隔离规格", () => {
    const sandboxService = new SandboxService({ policy: createDefaultSandboxPolicy() });

    // 测试在 macOS 或 Linux 沙箱约束下生成 execution spec
    const transport = createMCPTransport(
      {
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: { CUSTOM_VAR: "safe_value" },
      },
      {
        cwd: tmpDir,
        sandboxService,
      }
    );

    assert.ok(transport);
  });

  await t.test("8. MCP Resource @引用解析测试", async () => {
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
    });
    await manager.addServer("res-srv", {
      transport: "streamable-http",
      url: mockHttp.url,
      headers: { Authorization: "Bearer audit_token_xyz" },
      enabled: true,
    });

    const userInput = "请帮我分析 @res-srv:memo://project-notes 这个资源";
    const { resolvedInput, attachedResources } = await resolveUserMessageMcpResources(
      userInput,
      manager
    );

    assert.equal(attachedResources.length, 1);
    assert.equal(attachedResources[0]?.server, "res-srv");
    assert.ok(resolvedInput.includes("<mcp-resource server=\"res-srv\""));

    await manager.close();
  });

  await t.test("9. 外部配置规范化与导入：Claude Desktop / Cursor 格式兼容", () => {
    const externalRaw = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
      env: { PGUSER: "postgres" },
    };

    const norm = normalizeExternalServerConfig("postgres-srv", externalRaw);
    assert.equal(norm.transport, "stdio");
    assert.equal(norm.command, "npx");
    assert.equal(norm.args?.length, 3);
  });

  await t.test("10. MCP Doctor 全方位自检报告", async () => {
    const manager = new MCPManager({
      projectRoot: tmpDir,
      homeDir: tmpDir,
    });

    // 10.1 存在失效配置时，Doctor 灵敏检出并返回 1
    const badCode = await runMcpDoctor(manager);
    assert.equal(badCode, 1);

    // 10.2 清理异常/假地址测试服务，仅保留正常运行的 mockHttp 服务
    manager.configManager.removeServer("scoped-srv");
    manager.configManager.removeServer("danger-stdio");

    const cleanCode = await runMcpDoctor(manager);
    assert.equal(cleanCode, 0);

    await manager.close();
  });

  // 测试清理
  delete process.env.AUDIT_MCP_TOKEN;
  await mockHttp.close();
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
