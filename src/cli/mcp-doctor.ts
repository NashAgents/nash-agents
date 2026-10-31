import fs from "node:fs";
import { execSync } from "node:child_process";
import { MCPManager } from "../mcp/mcp-manager.js";
import { isPrivateOrRestrictedIp, isLoopbackHostname } from "../mcp/mcp-security.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { createDefaultSandboxPolicy } from "../sandbox/policy.js";

export interface DiagnosticCheckItem {
  category: string;
  name: string;
  passed: boolean;
  warning?: boolean;
  message: string;
}

/**
 * MCP Doctor: 全方位系统健康体检诊断
 */
export async function runMcpDoctor(manager: MCPManager): Promise<number> {
  console.log(`\n\x1b[1m\x1b[36m=== Nash MCP Doctor Diagnostic Suite ===\x1b[0m\n`);

  const checks: DiagnosticCheckItem[] = [];

  // 1. 检查作用域配置文件与目录权限
  const userPath = manager.configManager.userConfigPath;
  const projectPath = manager.configManager.projectMcpJsonPath;
  const localPath = manager.configManager.localConfigPath;

  checks.push({
    category: "Configuration",
    name: "User Scope Config",
    passed: true,
    message: fs.existsSync(userPath)
      ? `存在于 '${userPath}' (可读写)`
      : `未创建 (将在首次保存时自动生成: '${userPath}')`,
  });

  checks.push({
    category: "Configuration",
    name: "Project Scope Config (.mcp.json)",
    passed: true,
    message: fs.existsSync(projectPath)
      ? `检测到项目配置 '${projectPath}'`
      : `当前项目未包含 .mcp.json (正常)`,
  });

  // 2. 检查 Workspace Trust
  const isTrusted = manager.configManager.isProjectTrusted();
  checks.push({
    category: "Security",
    name: "Workspace Trust",
    passed: isTrusted,
    warning: !isTrusted,
    message: isTrusted
      ? "当前项目已被完全信任，允许安全加载项目级 MCP 服务"
      : "当前项目未经信任审批，项目级 stdio MCP 将被拦截。可运行 'nash mcp trust' 批准。",
  });

  // 3. 检查底层 OS 进程沙箱后端状态
  try {
    const sandboxService = new SandboxService({ policy: createDefaultSandboxPolicy() });
    const backend = sandboxService.getBackend();
    const isAvail = sandboxService.isAvailable();
    checks.push({
      category: "Sandbox",
      name: `OS Sandbox Backend (${backend.name})`,
      passed: isAvail,
      message: isAvail
        ? `可用且正常激活 (${backend.name})，stdio MCP 进程将受到内核级系统调用与文件系统隔离`
        : `不可用: ${(backend as any).reason || "当前平台不支持"}`,
    });
  } catch (err: unknown) {
    checks.push({
      category: "Sandbox",
      name: "OS Sandbox Backend",
      passed: false,
      message: `检测沙箱异常: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. 检查已配置的服务与连通性
  const servers = manager.configManager.loadAllServersWithMetadata();
  const serverNames = Object.keys(servers);

  if (serverNames.length === 0) {
    checks.push({
      category: "Servers",
      name: "Configured MCP Servers",
      passed: true,
      message: "当前尚未配置任何 MCP 服务。",
    });
  } else {
    for (const [name, meta] of Object.entries(servers)) {
      const cfg = meta.config;

      // 检查环境变量引用
      const envRefMatches = JSON.stringify(cfg).match(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g) || [];
      const missingVars: string[] = [];
      for (const m of envRefMatches) {
        const varName = m.slice(2, -1);
        if (!process.env[varName]) {
          missingVars.push(varName);
        }
      }

      if (missingVars.length > 0) {
        checks.push({
          category: `Server '${name}'`,
          name: "Environment Variables",
          passed: false,
          message: `引用的环境变量未定义: ${missingVars.map((v) => `\${${v}}`).join(", ")}`,
        });
      }

      // 检查 URL 与 SSRF 安全
      if (cfg.url) {
        try {
          const u = new URL(cfg.url);
          const isPrivate = isPrivateOrRestrictedIp(u.hostname);
          if (isPrivate && !isLoopbackHostname(u.hostname)) {
            checks.push({
              category: `Server '${name}'`,
              name: "SSRF Defense",
              passed: false,
              message: `URL 指向内网私有或云元数据地址 '${u.hostname}'，已被安全拦截`,
            });
          }
        } catch {}
      }

      // 检查 stdio 命令可执行性
      if (cfg.transport === "stdio" && cfg.command) {
        let cmdFound = false;
        try {
          execSync(`which ${cfg.command}`, { stdio: "ignore" });
          cmdFound = true;
        } catch {}
        checks.push({
          category: `Server '${name}'`,
          name: `Executable Binary '${cfg.command}'`,
          passed: cmdFound,
          warning: !cmdFound,
          message: cmdFound
            ? `宿主系统 PATH 中已找到 '${cfg.command}'`
            : `在 PATH 中未找到可执行程序 '${cfg.command}'，启动可能会失败`,
        });
      }

      // 检查连通性与握手测试
      try {
        const testRes = await manager.testServer(name);
        checks.push({
          category: `Server '${name}'`,
          name: "Protocol Handshake & Tools",
          passed: testRes.success,
          message: testRes.success
            ? `握手成功! 协议: ${testRes.protocolVersion || "negotiated"}, 延迟: ${testRes.latencyMs}ms, 工具数: ${testRes.toolCount}`
            : `连接失败: ${testRes.error}`,
        });
      } catch (err: unknown) {
        checks.push({
          category: `Server '${name}'`,
          name: "Protocol Handshake",
          passed: false,
          message: `异常: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // 格式化输出报告
  let failureCount = 0;
  for (const item of checks) {
    let icon = "\x1b[32m✓\x1b[0m";
    if (!item.passed) {
      if (item.warning) {
        icon = "\x1b[33m⚠\x1b[0m";
      } else {
        icon = "\x1b[31m✖\x1b[0m";
        failureCount++;
      }
    }
    console.log(`  ${icon} \x1b[1m[${item.category}]\x1b[0m ${item.name}`);
    console.log(`    \x1b[90m${item.message}\x1b[0m`);
  }

  console.log("");
  if (failureCount === 0) {
    console.log(`\x1b[32m✔ 全部检查通过，MCP 系统运行状态良好。\x1b[0m\n`);
    return 0;
  } else {
    console.log(`\x1b[31m✖ 检测到 ${failureCount} 项异常，请根据上方诊断提示排查。\x1b[0m\n`);
    return 1;
  }
}
