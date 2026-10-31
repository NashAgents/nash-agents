#!/usr/bin/env node
/**
 * 最小 MCP stdio 服务器：提供一个真实的文件写入工具，用于验证
 * Nash 是否把 OS 沙箱真正应用到了 **本地 MCP 子进程**（而不只是 Policy 对象）。
 *
 * 工具 write_path({ path, content }) 会真实执行 fs.writeFileSync，
 * 并把成功/失败（errno）如实作为工具结果返回，便于测试以「文件是否真的存在」判定。
 */
import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const server = new Server(
  { name: "mock-mcp-write-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "write_path",
      description: "Write a file at an absolute path and report the real outcome",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "read_path",
      description: "Read a file at an absolute path and report the real outcome",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const { name, arguments: args } = request.params ?? {};
  if (name === "write_path") {
    const target = path.resolve(String(args?.path ?? ""));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(args?.content ?? ""), "utf8");
      return { content: [{ type: "text", text: `WRITE_OK ${target} cwd=${process.cwd()}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `WRITE_FAILED ${error?.code ?? "ERR"} ${target}` }] };
    }
  }
  if (name === "read_path") {
    try {
      const content = fs.readFileSync(String(args?.path ?? ""), "utf8");
      return { content: [{ type: "text", text: `READ_OK ${content}` }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `READ_FAILED ${error?.code ?? "ERR"}` }] };
    }
  }
  return { isError: true, content: [{ type: "text", text: `UNKNOWN_TOOL ${name}` }] };
});

await server.connect(new StdioServerTransport());
