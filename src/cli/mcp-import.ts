import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MCPManager } from "../mcp/mcp-manager.js";
import type { MCPServerConfig, MCPConfigScope } from "../mcp/types.js";

export interface ImportOptions {
  fromClaudeDesktop?: boolean;
  fromCursor?: boolean;
  fromFile?: string;
  scope?: MCPConfigScope;
  overwrite?: boolean;
}

/**
 * 将外部或通用 mcpServers 格式的 JSON 结构规范化为 Nash MCPServerConfig
 */
export function normalizeExternalServerConfig(
  rawName: string,
  raw: Record<string, unknown>
): MCPServerConfig {
  const url = typeof raw.url === "string" ? raw.url : undefined;
  const command = typeof raw.command === "string" ? raw.command : undefined;
  const rawArgs = Array.isArray(raw.args) ? raw.args.map(String) : undefined;
  const env =
    typeof raw.env === "object" && raw.env !== null
      ? (raw.env as Record<string, string>)
      : undefined;
  const headers =
    typeof raw.headers === "object" && raw.headers !== null
      ? (raw.headers as Record<string, string>)
      : undefined;

  let transport: "stdio" | "streamable-http" | "sse" = "stdio";
  const explicitType = String(raw.type || raw.transport || "").toLowerCase();

  if (explicitType === "http" || explicitType === "streamable-http") {
    transport = "streamable-http";
  } else if (explicitType === "sse") {
    transport = "sse";
  } else if (explicitType === "stdio") {
    transport = "stdio";
  } else {
    // 自动推断
    if (url) {
      transport = "streamable-http";
    } else if (command) {
      transport = "stdio";
    }
  }

  return {
    name: rawName,
    transport,
    url,
    command,
    args: rawArgs,
    env,
    headers,
    enabled: raw.enabled !== false,
  };
}

/**
 * 执行配置导入操作
 */
export async function runMcpImport(
  manager: MCPManager,
  options: ImportOptions
): Promise<number> {
  let sourcePath = "";
  let sourceDesc = "";

  if (options.fromClaudeDesktop) {
    sourceDesc = "Claude Desktop Config";
    if (process.platform === "darwin") {
      sourcePath = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    } else {
      sourcePath = path.join(
        os.homedir(),
        ".config",
        "Claude",
        "claude_desktop_config.json"
      );
    }
  } else if (options.fromCursor) {
    sourceDesc = "Cursor MCP Config";
    const localCursor = path.join(process.cwd(), ".cursor", "mcp.json");
    const globalCursor = path.join(os.homedir(), ".cursor", "mcp.json");
    sourcePath = fs.existsSync(localCursor) ? localCursor : globalCursor;
  } else if (options.fromFile) {
    sourceDesc = `File (${options.fromFile})`;
    sourcePath = path.resolve(options.fromFile);
  } else {
    console.error(
      "\x1b[31m必须指定导入来源: --from-claude-desktop | --from-cursor | --from-file <path>\x1b[0m"
    );
    return 1;
  }

  if (!fs.existsSync(sourcePath)) {
    console.error(
      `\x1b[31m未找到 ${sourceDesc} 配置文件: '${sourcePath}'\x1b[0m`
    );
    return 1;
  }

  let parsed: any;
  try {
    const raw = fs.readFileSync(sourcePath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.error(
      `\x1b[31m解析配置文件失败: ${err instanceof Error ? err.message : String(err)}\x1b[0m`
    );
    return 1;
  }

  const mcpServers = (parsed?.mcpServers ?? parsed) as Record<
    string,
    Record<string, unknown>
  >;
  if (!mcpServers || typeof mcpServers !== "object") {
    console.log(`\n\x1b[33m在 '${sourcePath}' 中未发现任何 mcpServers 配置。\x1b[0m\n`);
    return 0;
  }

  const existingServers = manager.configManager.loadAllServers();
  const scope = options.scope ?? "user";

  console.log(`\n\x1b[1m从 ${sourceDesc} 中发现以下 MCP 服务:\x1b[0m\n`);

  let importedCount = 0;
  for (const [name, rawConfig] of Object.entries(mcpServers)) {
    if (!rawConfig || typeof rawConfig !== "object") continue;

    if (existingServers[name] && !options.overwrite) {
      console.log(
        `  \x1b[33m○ 跳过已有服务 '${name}'\x1b[0m (如需覆盖请传 --overwrite)`
      );
      continue;
    }

    try {
      const normalized = normalizeExternalServerConfig(name, rawConfig);
      await manager.addServer(name, normalized, scope);
      console.log(
        `  \x1b[32m✔ 成功导入 '${name}'\x1b[0m [${normalized.transport}] -> scope: ${scope}`
      );
      importedCount++;
    } catch (err: unknown) {
      console.log(
        `  \x1b[31m✖ 导入 '${name}' 失败: ${err instanceof Error ? err.message : String(err)}\x1b[0m`
      );
    }
  }

  console.log(`\n\x1b[32m导入完成！共导入 ${importedCount} 个 MCP 服务。\x1b[0m\n`);
  return 0;
}
