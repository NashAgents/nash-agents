import fs from "node:fs";
import { MCPManager } from "../mcp/mcp-manager.js";
import type { MCPServerConfig, MCPConfigScope } from "../mcp/types.js";
import { redactHeaders } from "../mcp/mcp-security.js";
import { runMcpInteractiveWizard } from "./mcp-wizard.js";
import { runMcpDoctor } from "./mcp-doctor.js";
import { runMcpImport, normalizeExternalServerConfig } from "./mcp-import.js";

/**
 * 格式化输出帮助文档
 */
function printMcpHelp(): void {
  console.log(`\x1b[1m\x1b[36mNash MCP Manager CLI\x1b[0m

\x1b[1mUsage:\x1b[0m
  nash mcp [command] [options]

\x1b[1mCommands:\x1b[0m
  (no command)                 启动交互式 MCP Manager 向导 (TTY)
  add <name> [options]         注册新的 MCP 服务配置
  add-json <name> <json|path>  使用 JSON 字符串或文件注册 MCP 服务
  import [options]             从 Claude Desktop / Cursor / 文件导入服务
  remove <name> [--scope]      删除 MCP 服务配置与关联工具
  list                         查看所有已注册服务及其连接状态与工具数
  get <name>                   查看指定服务的详细配置与运行时状态
  test <name>                  执行官方协议握手与连通性测试
  doctor                       执行 MCP 系统全方位体检诊断报告
  login <name>                 通过 OAuth 2.0 PKCE 登录服务
  logout <name>                清除服务凭证并登出
  trust                        批准并信任当前项目的 .mcp.json 配置
  tools [name]                 列出服务发现的所有可用工具
  resources [name]             列出服务提供的 Resources 资源
  prompts [name]               列出服务提供的 Prompts 模板
  enable <name>                启用指定服务
  disable <name>               禁用指定服务
  reconnect <name>             重新连接指定服务

\x1b[1mOptions for 'add':\x1b[0m
  --transport <type>           协议类型: streamable-http | sse | stdio
  --url <url>                  远程端点 URL (用于 streamable-http / sse)
  --command <cmd>              本地可执行程序 (用于 stdio)
  --args <args...>             stdio 命令行参数
  --bearer-env <VAR>           存放 Bearer Token 的环境变量名称
  --header <Key=Value>         自定义请求头
  --env <Key=Value>            stdio 进程环境变量
  --scope <local|project|user> 存储作用域 (默认: user 全局通用)
  --always-load                是否在模型请求中直接加载该服务的工具定义
  --timeout <ms>               超时毫秒数 (默认: 30000)
  --insecure                   允许非 TLS 的公网 HTTP 连接
  --disabled                   添加为禁用状态

\x1b[1mExamples:\x1b[0m
  nash mcp
  nash mcp add bilibili-subtitles --transport streamable-http --url https://mcp.example.com/mcp --bearer-env BILIBILI_MCP_TOKEN
  nash mcp add-json bilibili '{"type":"http","url":"https://mcp.example.com/mcp"}'
  nash mcp import --from-claude-desktop
  nash mcp doctor
  nash mcp list
`);
}

/**
 * 命令行参数解析辅助函数
 */
function parseArgs(args: string[]): {
  command?: string;
  subArgs: string[];
  flags: Record<string, string | boolean | string[]>;
} {
  const flags: Record<string, string | boolean | string[]> = {};
  const subArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
        const val = args[++i]!;
        if (flags[key]) {
          const prev = flags[key];
          flags[key] = Array.isArray(prev) ? [...prev, val] : [String(prev), val];
        } else {
          flags[key] = val;
        }
      } else {
        flags[key] = true;
      }
    } else {
      subArgs.push(arg);
    }
  }

  return {
    command: subArgs[0],
    subArgs: subArgs.slice(1),
    flags,
  };
}

/**
 * 运行 nash mcp 命令处理入口
 */
export async function runNashMcp(rawArgs: string[]): Promise<number> {
  const { command, subArgs, flags } = parseArgs(rawArgs);

  const manager = new MCPManager({
    projectRoot: process.cwd(),
  });

  // 无参数时：若在 TTY 终端启动交互向导，否则输出帮助
  if (!command) {
    if (process.stdin.isTTY) {
      return await runMcpInteractiveWizard(manager);
    } else {
      printMcpHelp();
      return 0;
    }
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printMcpHelp();
    return 0;
  }

  try {
    switch (command) {
      case "doctor": {
        return await runMcpDoctor(manager);
      }

      case "trust": {
        manager.configManager.trustCurrentProject();
        console.log(`\n\x1b[32m✔ 已成功将当前项目的 .mcp.json 列为信任配置。\x1b[0m\n`);
        return 0;
      }

      case "import": {
        return await runMcpImport(manager, {
          fromClaudeDesktop: Boolean(flags["from-claude-desktop"]),
          fromCursor: Boolean(flags["from-cursor"]),
          fromFile: flags["from-file"] as string | undefined,
          scope: (flags.scope as MCPConfigScope) ?? "user",
          overwrite: Boolean(flags.overwrite),
        });
      }

      case "add-json": {
        const name = subArgs[0];
        const jsonOrPath = subArgs[1];
        if (!name || !jsonOrPath) {
          console.error("\x1b[31m用法: nash mcp add-json <name> <json-string-or-file-path> [--scope local|project|user]\x1b[0m");
          return 1;
        }

        let rawObj: Record<string, unknown>;
        if (fs.existsSync(jsonOrPath)) {
          rawObj = JSON.parse(fs.readFileSync(jsonOrPath, "utf-8"));
        } else {
          rawObj = JSON.parse(jsonOrPath);
        }

        const normalized = normalizeExternalServerConfig(name, rawObj);
        const scope = ((flags.scope as string) || "user") as MCPConfigScope;
        await manager.addServer(name, normalized, scope);
        console.log(`\n\x1b[32m✔ 成功通过 JSON 注册 MCP 服务 '${name}' (作用域: ${scope})！\x1b[0m\n`);
        return 0;
      }

      case "login": {
        const name = subArgs[0];
        if (!name) {
          console.error("\x1b[31m必须指定要登录的服务名称: nash mcp login <name>\x1b[0m");
          return 1;
        }
        console.log(`\n正在为服务 '${name}' 启动 OAuth 2.0 登录流程...`);
        const ok = await manager.loginServer(name);
        if (ok) {
          console.log(`\x1b[32m✔ 服务 '${name}' OAuth 授权登录成功！凭据已持久化至安全存储。\x1b[0m\n`);
        }
        return ok ? 0 : 1;
      }

      case "logout": {
        const name = subArgs[0];
        if (!name) {
          console.error("\x1b[31m必须指定要登出的服务名称: nash mcp logout <name>\x1b[0m");
          return 1;
        }
        await manager.logoutServer(name);
        console.log(`\n\x1b[32m✔ 已清除服务 '${name}' 的登录凭据。\x1b[0m\n`);
        return 0;
      }

      case "list": {
        const servers = manager.configManager.loadAllServers();
        for (const [name, config] of Object.entries(servers)) {
          manager.connectionManager.registerServer(name, config);
        }

        const connectPromises = Object.entries(servers)
          .filter(([_, cfg]) => cfg.enabled !== false && cfg.trustStatus !== "pending")
          .map(([name]) => manager.connectionManager.connect(name).catch(() => {}));
        await Promise.allSettled(connectPromises);

        const statuses = manager.listStatuses();
        if (statuses.length === 0) {
          console.log(`\n\x1b[33m当前尚未注册任何 MCP 服务。\x1b[0m 可使用 'nash mcp add --help' 添加。\n`);
          return 0;
        }

        console.log(`\n\x1b[1m已配置的 MCP 服务列表:\x1b[0m\n`);
        const header = `  ${"NAME".padEnd(24)} ${"TRANSPORT".padEnd(18)} ${"STATUS".padEnd(14)} ${"SCOPE".padEnd(10)} TOOLS`;
        console.log(`\x1b[4m${header}\x1b[0m`);

        for (const s of statuses) {
          let statusColor = "\x1b[32m";
          let dot = "●";
          if (s.status === "failed") {
            statusColor = "\x1b[31m";
            dot = "✖";
          } else if (s.status === "disabled" || s.status === "disconnected") {
            statusColor = "\x1b[90m";
            dot = "○";
          } else if (s.status === "connecting" || s.status === "reconnecting") {
            statusColor = "\x1b[33m";
            dot = "↻";
          } else if (s.status === "pending_approval") {
            statusColor = "\x1b[33m";
            dot = "⚠";
          }

          const statusStr = `${statusColor}${dot} ${s.status}\x1b[0m`;
          const toolsStr = s.status === "connected" ? `${s.toolCount}` : "-";
          console.log(
            `  ${s.name.padEnd(24)} ${s.transport.padEnd(18)} ${statusStr.padEnd(23)} ${(s.scope || "user").padEnd(10)} ${toolsStr}`
          );
        }
        console.log("");
        return 0;
      }

      case "add": {
        const name = subArgs[0];
        if (!name) {
          console.error(`\x1b[31m错误: 缺少服务名称。\x1b[0m 用法: nash mcp add <name> [options]`);
          return 1;
        }

        const transport = (flags.transport as string) || "streamable-http";
        const url = flags.url as string | undefined;
        const cmd = flags.command as string | undefined;
        const scope = ((flags.scope as string) || "user") as MCPConfigScope;
        const timeoutMs = flags.timeout ? Number(flags.timeout) : undefined;
        const allowInsecureHttp = Boolean(flags.insecure);
        const enabled = flags.disabled ? false : true;
        const alwaysLoad = flags["always-load"] ? true : undefined;

        const headers: Record<string, string> = {};
        if (flags["bearer-env"]) {
          const envVarName = String(flags["bearer-env"]).trim();
          headers["Authorization"] = `Bearer \${${envVarName}}`;
        }

        if (flags.header) {
          const list = Array.isArray(flags.header) ? flags.header : [flags.header];
          for (const item of list) {
            const idx = String(item).indexOf("=");
            if (idx > 0) {
              const k = String(item).slice(0, idx).trim();
              const v = String(item).slice(idx + 1).trim();
              headers[k] = v;
            }
          }
        }

        const env: Record<string, string> = {};
        if (flags.env) {
          const list = Array.isArray(flags.env) ? flags.env : [flags.env];
          for (const item of list) {
            const idx = String(item).indexOf("=");
            if (idx > 0) {
              const k = String(item).slice(0, idx).trim();
              const v = String(item).slice(idx + 1).trim();
              env[k] = v;
            }
          }
        }

        let stdioArgs: string[] | undefined;
        if (flags.args) {
          if (Array.isArray(flags.args)) {
            stdioArgs = flags.args.map(String);
          } else {
            stdioArgs = [String(flags.args)];
          }
        }

        const config: MCPServerConfig = {
          name,
          transport: transport as any,
          url,
          command: cmd,
          args: stdioArgs,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          env: Object.keys(env).length > 0 ? env : undefined,
          timeoutMs,
          allowInsecureHttp,
          enabled,
          scope,
          alwaysLoad,
        };

        console.log(`\n正在验证并添加 MCP 服务 '${name}' [${transport}]...`);
        try {
          const status = await manager.addServer(name, config, scope);
          console.log(`\x1b[32m✔ MCP Server '${name}' registered successfully!\x1b[0m`);
          console.log(`  连接状态: ${status.status}`);
          console.log(`  配置作用域: ${status.scope}`);
          console.log(`  暴露工具数: ${status.toolCount}`);
          if (status.lastError) {
            console.log(`  \x1b[33m连接告警: ${status.lastError}\x1b[0m`);
          }
          console.log("");
          return 0;
        } catch (err: unknown) {
          console.error(`\x1b[31m✖ 注册失败:\x1b[0m`, err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      case "remove": {
        const name = subArgs[0];
        if (!name) {
          console.error(`\x1b[31m错误: 缺少服务名称。\x1b[0m 用法: nash mcp remove <name> [--scope local|project|user]`);
          return 1;
        }
        const scope = flags.scope as MCPConfigScope | undefined;
        const ok = await manager.removeServer(name, scope);
        if (ok) {
          console.log(`\x1b[32m✔ MCP Server '${name}' removed successfully.\x1b[0m\n`);
          return 0;
        } else {
          console.error(`\x1b[31m未找到服务 '${name}'\x1b[0m\n`);
          return 1;
        }
      }

      case "get": {
        const name = subArgs[0];
        if (!name) {
          console.error(`\x1b[31m用法: nash mcp get <name>\x1b[0m`);
          return 1;
        }
        const config = manager.configManager.getServer(name);
        if (!config) {
          console.error(`\x1b[31m未找到服务 '${name}' 的配置信息\x1b[0m`);
          return 1;
        }

        console.log(`\n\x1b[1m=== MCP Server '${name}' ===\x1b[0m`);
        console.log(`  Transport: ${config.transport}`);
        console.log(`  Scope: ${config.scope || "user"}`);
        console.log(`  Enabled: ${config.enabled !== false}`);
        if (config.url) console.log(`  URL: ${config.url}`);
        if (config.command) {
          console.log(`  Command: ${config.command} ${(config.args || []).join(" ")}`);
        }
        if (config.headers) {
          console.log(`  Headers: ${JSON.stringify(redactHeaders(config.headers))}`);
        }
        if (config.alwaysLoad !== undefined) {
          console.log(`  AlwaysLoad: ${config.alwaysLoad}`);
        }

        try {
          await manager.connectionManager.connect(name);
          const st = manager.getStatus(name);
          console.log(`  Status: ${st?.status}`);
          console.log(`  Tools: ${st?.toolCount}`);
        } catch {}
        console.log("");
        return 0;
      }

      case "test": {
        const name = subArgs[0];
        if (!name) {
          console.error(`\x1b[31m用法: nash mcp test <name>\x1b[0m`);
          return 1;
        }
        console.log(`\n\x1b[36mTesting MCP connection to '${name}'...\x1b[0m`);
        const res = await manager.testServer(name);
        if (res.success) {
          console.log(`\x1b[32m✔ Handshake Succeeded!\x1b[0m Protocol: ${res.protocolVersion || "negotiated"}, Roundtrip Latency: ${res.latencyMs}ms, Tools: ${res.toolCount}`);
          if (res.tools && res.tools.length > 0) {
            console.log(`  Tools: ${res.tools.join(", ")}`);
          }
          console.log("");
          return 0;
        } else {
          console.error(`\x1b[31m✖ Handshake failed:\x1b[0m ${res.error}\n`);
          return 1;
        }
      }

      case "tools": {
        const targetServer = subArgs[0];
        await manager.initialize();
        if (targetServer) {
          await manager.connectionManager.connect(targetServer).catch(() => {});
        }
        const tools = targetServer
          ? manager.connectionManager.getTools(targetServer)
          : manager.connectionManager.getAllTools();

        if (tools.length === 0) {
          console.log(`\n\x1b[33m未发现任何可用工具${targetServer ? ` (来自 '${targetServer}')` : ""}\x1b[0m\n`);
          return 0;
        }

        console.log(`\n\x1b[1mDiscovered MCP Tools (${tools.length}):\x1b[0m\n`);
        for (const t of tools) {
          console.log(`  \x1b[36m${t.name}\x1b[0m \x1b[90m(from ${t.serverName})\x1b[0m`);
          if (t.description) console.log(`    ${t.description}`);
          const props = Object.keys((t.inputSchema?.properties as any) || {});
          if (props.length > 0) {
            console.log(`    Parameters: ${props.join(", ")}`);
          }
          console.log("");
        }
        return 0;
      }

      case "enable": {
        const name = subArgs[0];
        if (!name) return 1;
        const ok = await manager.enableServer(name);
        if (ok) console.log(`\x1b[32m✔ 已启用服务 '${name}'\x1b[0m\n`);
        return ok ? 0 : 1;
      }

      case "disable": {
        const name = subArgs[0];
        if (!name) return 1;
        const ok = await manager.disableServer(name);
        if (ok) console.log(`\x1b[32m✔ 已禁用服务 '${name}'\x1b[0m\n`);
        return ok ? 0 : 1;
      }

      case "reconnect": {
        const name = subArgs[0];
        if (!name) return 1;
        await manager.reconnectServer(name);
        console.log(`\x1b[32m✔ 已重新连接服务 '${name}'\x1b[0m\n`);
        return 0;
      }

      default:
        console.error(`\x1b[31m未知子命令: '${command}'\x1b[0m`);
        printMcpHelp();
        return 1;
    }
  } catch (err: unknown) {
    console.error(`\x1b[31m执行异常:\x1b[0m`, err instanceof Error ? err.message : String(err));
    return 1;
  }
}
