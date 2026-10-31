import { createDefaultSandboxPolicy } from "../../sandbox/policy.js";
import {
  StreamableHTTPClientTransport,
  SSEClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Transport } from "@modelcontextprotocol/client";
import type { MCPServerConfig } from "../types.js";
import {
  resolveEnvRecord,
  buildSanitizedStdioEnv,
  validateMCPUrl,
} from "../mcp-security.js";
import { SandboxService } from "../../sandbox/sandbox-service.js";
import type { SandboxPolicy } from "../../sandbox/types.js";

export interface TransportCreationOptions {
  cwd?: string;
  sandboxService?: SandboxService;
  sandboxPolicy?: SandboxPolicy;
}

/**
 * 根据 MCPServerConfig 构造官方 MCP Transport 实例
 */
export function createMCPTransport(
  config: MCPServerConfig,
  options?: TransportCreationOptions
): Transport {
  const serverName = config.name ?? "unnamed";

  switch (config.transport) {
    case "streamable-http": {
      if (!config.url) {
        throw new Error(
          `MCP streamable-http 服务 '${serverName}' 缺少必需的 'url' 字段`
        );
      }
      validateMCPUrl(config.url, Boolean(config.allowInsecureHttp));

      // 提取并解析请求头中的环境变量
      const headers = config.headers
        ? resolveEnvRecord(config.headers, `Server '${serverName}' headers`)
        : undefined;

      const transportUrl = new URL(config.url);
      return new StreamableHTTPClientTransport(transportUrl, {
        requestInit: {
          headers,
        },
      });
    }

    case "sse": {
      if (!config.url) {
        throw new Error(`MCP sse 服务 '${serverName}' 缺少必需的 'url' 字段`);
      }
      validateMCPUrl(config.url, Boolean(config.allowInsecureHttp));

      const headers = config.headers
        ? resolveEnvRecord(config.headers, `Server '${serverName}' headers`)
        : undefined;

      const transportUrl = new URL(config.url);
      return new SSEClientTransport(transportUrl, {
        requestInit: {
          headers,
        },
      });
    }

    case "stdio": {
      if (!config.command) {
        throw new Error(
          `MCP stdio 服务 '${serverName}' 缺少必需的 'command' 命令行字段`
        );
      }

      // 构建清洗后的安全基础环境变量
      const sanitizedEnv = buildSanitizedStdioEnv(config.env);

      let execCommand = config.command;
      let execArgs = config.args ?? [];
      let execCwd = options?.cwd ?? process.cwd();
      let execEnv = sanitizedEnv;

      let cleanup: (() => void) | undefined;
      const sandboxService = options?.sandboxService ?? new SandboxService({ policy: options?.sandboxPolicy ?? createDefaultSandboxPolicy(), cwd: execCwd });
      // 真正接入 SandboxService 实施系统调用与文件系统隔离
      if (sandboxService) {
        const spec = sandboxService.buildExecutionSpec({
          command: config.command,
          args: config.args ?? [],
          cwd: execCwd,
          env: sanitizedEnv,
          policy: options?.sandboxPolicy,
        });
        cleanup = spec.cleanup;
        execCommand = spec.executable;
        execArgs = spec.args;
        execCwd = spec.cwd;
        execEnv = spec.env;
      }

      const transport = new StdioClientTransport({
        command: execCommand,
        args: execArgs,
        env: execEnv,
        cwd: execCwd,
        stderr: "pipe", // 安全捕获 stderr，防止乱码或控制台污染
      });
      const close = transport.close.bind(transport);
      transport.close = async () => { try { await close(); } finally { const release = cleanup; cleanup = undefined; release?.(); } };
      return transport;
    }

    default:
      throw new Error(
        `不支持的 MCP 传输协议类型: '${(config as any).transport}'`
      );
  }
}
