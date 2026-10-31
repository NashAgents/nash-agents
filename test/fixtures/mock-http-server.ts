import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockHttpServerOptions {
  bearerToken?: string;
  protocolVersion?: string;
  onCallTool?: (name: string, args: Record<string, unknown>) => Promise<any> | any;
}

export interface RunningMockServer {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
  simulateDisconnect: () => void;
  setBearerToken: (token?: string) => void;
}

/**
 * 创建并启动标准的 Streamable HTTP / JSON-RPC MCP 模拟服务器
 */
export async function createMockMCPHttpServer(
  options?: MockHttpServerOptions
): Promise<RunningMockServer> {
  let requiredBearer = options?.bearerToken;
  const protocolVersion = options?.protocolVersion ?? "2025-03-26";
  let activeSockets: import("node:net").Socket[] = [];

  const server = http.createServer((req, res) => {
    // 1. 验证 Authorization Bearer Token
    if (requiredBearer) {
      const authHeader = req.headers["authorization"] || "";
      if (authHeader !== `Bearer ${requiredBearer}`) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer",
        });
        res.end(
          JSON.stringify({
            error: "Unauthorized",
            message: "Invalid or missing MCP Auth Token",
          })
        );
        return;
      }
    }

    // 2. 处理 GET 请求（用于 SSE 或健康检查）
    if (req.method === "GET") {
      const accept = req.headers["accept"] || "";
      if (accept.includes("text/event-stream")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "mcp-protocol-version": protocolVersion,
        });
        res.write(": keepalive\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // 3. 处理 POST 请求 (JSON-RPC)
    if (req.method === "POST") {
      let body = "";
      req.setEncoding("utf-8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        try {
          const rpc = JSON.parse(body);

          // notifications/initialized (无返回值)
          if (rpc.method === "notifications/initialized") {
            res.writeHead(204);
            res.end();
            return;
          }

          let responseResult: any;

          if (rpc.method === "initialize") {
            responseResult = {
              protocolVersion,
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
              },
              serverInfo: {
                name: "mock-http-mcp-server",
                version: "1.0.0",
              },
            };
          } else if (rpc.method === "tools/list") {
            responseResult = {
              tools: [
                {
                  name: "fetch_remote_data",
                  description: "Fetches remote data payload over HTTP",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
                {
                  name: "side_effect_deploy",
                  description: "Performs non-idempotent remote deployment",
                  inputSchema: {
                    type: "object",
                    properties: { env: { type: "string" } },
                  },
                },
              ],
            };
          } else if (rpc.method === "tools/call") {
            const { name, arguments: toolArgs } = rpc.params || {};
            if (options?.onCallTool) {
              responseResult = await options.onCallTool(name, toolArgs);
            } else if (name === "fetch_remote_data") {
              responseResult = {
                content: [
                  {
                    type: "text",
                    text: `Remote data query response for '${toolArgs?.query}'`,
                  },
                ],
              };
            } else if (name === "side_effect_deploy") {
              responseResult = {
                content: [
                  {
                    type: "text",
                    text: `Deployment to ${toolArgs?.env || "staging"} initiated`,
                  },
                ],
              };
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: rpc.id,
                  error: { code: -32601, message: `Tool not found: ${name}` },
                })
              );
              return;
            }
          } else if (rpc.method === "resources/list") {
            responseResult = {
              resources: [
                {
                  uri: "http://test/schema",
                  name: "Remote Schema",
                  mimeType: "application/json",
                },
              ],
            };
          } else if (rpc.method === "resources/read") {
            responseResult = {
              contents: [
                {
                  uri: rpc.params?.uri,
                  text: '{"schema": "public", "version": 1}',
                },
              ],
            };
          } else if (rpc.method === "prompts/list") {
            responseResult = {
              prompts: [
                {
                  name: "http_prompt",
                  description: "Remote HTTP Prompt",
                },
              ],
            };
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32601, message: `Method not found: ${rpc.method}` },
              })
            );
            return;
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "mcp-protocol-version": protocolVersion,
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: responseResult,
            })
          );
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: String(err) },
            })
          );
        }
      });
    }
  });

  server.on("connection", (socket) => {
    activeSockets.push(socket);
    socket.on("close", () => {
      activeSockets = activeSockets.filter((s) => s !== socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    server,
    port,
    url,
    close: async () => {
      for (const s of activeSockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    simulateDisconnect: () => {
      for (const s of activeSockets) {
        s.destroy();
      }
    },
    setBearerToken: (token?: string) => {
      requiredBearer = token;
    },
  };
}
