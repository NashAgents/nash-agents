import { randomBytes } from "node:crypto";
import { before as configureAuth, after as restoreAuth } from "node:test";
const testPassword = randomBytes(24).toString("hex");
const previousPassword = process.env.DASHBOARD_PASS;
configureAuth(() => { process.env.DASHBOARD_PASS = testPassword; });
restoreAuth(() => { if (previousPassword === undefined) delete process.env.DASHBOARD_PASS; else process.env.DASHBOARD_PASS = previousPassword; });
/**
 * Nash Cluster Phase 5: Web Control Plane API & Session Tests
 * 覆盖：Web 登录鉴权、HttpOnly Session Cookie、CSRF 防护、
 * 产物全量列表/内容预览/安全流式下载、Web 交互会话生命周期与全局 SSE 事件流
 */

import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";

function requestHttp(
  urlStr: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const headers = { ...options.headers };
    let reqBody: string | undefined;

    if (options.body) {
      reqBody = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
      headers["Content-Length"] = String(Buffer.byteLength(reqBody));
    }

    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, raw });
        });
      }
    );
    req.on("error", reject);
    if (reqBody) {
      req.write(reqBody);
    }
    req.end();
  });
}

describe("Nash Cluster Phase 5: Web Control Plane API & Security", () => {
  let coordinator: ClusterCoordinator;
  let coordinatorUrl: string;
  let sessionCookie: string;
  let csrfToken: string;
  let createdArtifactId: string;
  let testConversationId: string;

  before(async () => {
    coordinator = new ClusterCoordinator({
      ephemeral: true,
      listenHost: "127.0.0.1",
      listenPort: 19899,
      adminApiKey: "test-admin-secret-key",
    });
    mock.method(coordinator.getMainAgent(), "chat", async () => ({ assistantResponse: "测试协调器已完成处理", state: "completed" as const, durationMs: 0 }));
    const addr = await coordinator.start();
    coordinatorUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await coordinator.stop();
  });

  describe("1. Web Authentication & Session Security", () => {
    test("1.1 错误密码登录被拒绝 (401)", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/auth/login`, {
        method: "POST",
        body: { username: "admin", password: "wrong-password" },
      });
      assert.equal(res.status, 401);
      assert.match(res.body.error, /用户名或密码错误/);
    });

    test("1.2 正确标准凭据登录成功，签发 HttpOnly Cookie 与 CSRF Token", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/auth/login`, {
        method: "POST",
        body: { username: "admin", password: testPassword },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.user.username, "admin");
      assert.equal(res.body.user.role, "admin");
      assert.ok(res.body.csrfToken);

      csrfToken = res.body.csrfToken;
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      assert.match(cookieStr!, /nash_session=sess-/);
      assert.match(cookieStr!, /HttpOnly/i);

      // 提取 sessionCookie 用于后续请求
      sessionCookie = cookieStr!.split(";")[0]!;
    });

    test("1.3 GET /api/auth/me 携带 Cookie 成功获取当前身份", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.authenticated, true);
      assert.equal(res.body.user.username, "admin");
      assert.equal(res.body.csrfToken, csrfToken);
    });

    test("1.4 无凭证访问受保护 API 被拦截 (401)", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/tasks`);
      assert.equal(res.status, 401);
    });

    test("1.5 CSRF 校验：携带伪造的 x-csrf-token 执行写操作被拒绝", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/conversations`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "x-csrf-token": "forged-csrf-token-123456",
        },
        body: { title: "恶意 CSRF 会话" },
      });

      assert.equal(res.status, 403);
    });
  });

  describe("2. Web Conversations & Chat Workspace", () => {
    test("2.1 POST /api/cluster/conversations 创建新会话", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/conversations`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie,
          "x-csrf-token": csrfToken,
        },
        body: { title: "测试分布式排查任务" },
      });

      assert.equal(res.status, 201);
      assert.ok(res.body.conversation?.id);
      assert.equal(res.body.conversation.title, "测试分布式排查任务");
      testConversationId = res.body.conversation.id;
    });

    test("2.2 GET /api/cluster/conversations 列表查询会话", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/conversations`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.conversations));
      const found = res.body.conversations.find((c: any) => c.id === testConversationId);
      assert.ok(found);
    });

    test("2.3 POST /api/cluster/conversations/:id/messages 发送消息并触发自然语言交互", async () => {
      const res = await requestHttp(
        `${coordinatorUrl}/api/cluster/conversations/${testConversationId}/messages`,
        {
          method: "POST",
          headers: {
            Cookie: sessionCookie,
            "x-csrf-token": csrfToken,
          },
          body: { content: "检查之前开发的 Nash MCP 模块" },
        }
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.userMessage.content, "检查之前开发的 Nash MCP 模块");
      assert.ok(res.body.conversation.messages.length >= 2);
    });

    test("2.4 PATCH /api/cluster/conversations/:id 重命名会话", async () => {
      const res = await requestHttp(
        `${coordinatorUrl}/api/cluster/conversations/${testConversationId}`,
        {
          method: "PATCH",
          headers: {
            Cookie: sessionCookie,
            "x-csrf-token": csrfToken,
          },
          body: { title: "已重命名的排查任务" },
        }
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.conversation.title, "已重命名的排查任务");
    });
  });

  describe("3. Artifacts Browser, Preview & Download", () => {
    before(async () => {
      // 预先发布一份产物
      const artService = coordinator.getArtifactService();
      if (artService) {
        const art = await artService.publishArtifact({
          graphId: "test-web-graph-1",
          producerTaskId: "task-web-1",
          producerNodeId: "node-example-cloud",
          name: "diagnostic_report.json",
          contentType: "application/json",
          content: JSON.stringify({ cluster: "online", healthy: true, details: "All checks passed" }, null, 2),
        });
        createdArtifactId = art.artifactId;
      }
    });

    test("3.1 GET /api/cluster/artifacts 列出集群所有产物", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/artifacts`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.artifacts));
      assert.ok(res.body.artifacts.length >= 1);
      const found = res.body.artifacts.find((a: any) => a.artifactId === createdArtifactId);
      assert.ok(found);
      assert.equal(found.name, "diagnostic_report.json");
    });

    test("3.2 GET /api/cluster/artifacts/:id 查看产物详情", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/artifacts/${createdArtifactId}`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.artifact.artifactId, createdArtifactId);
      assert.equal(res.body.artifact.contentType, "application/json");
      assert.ok(res.body.artifact.sha256);
    });

    test("3.3 GET /api/cluster/artifacts/:id/content 安全预览文本与 JSON 内容", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/artifacts/${createdArtifactId}/content`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.name, "diagnostic_report.json");
      assert.equal(res.body.truncated, false);
      const parsed = JSON.parse(res.body.content);
      assert.equal(parsed.cluster, "online");
      assert.equal(parsed.healthy, true);
    });

    test("3.4 GET /api/cluster/artifacts/:id/download 安全流式下载并核验 SHA256", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/cluster/artifacts/${createdArtifactId}/download`, {
        headers: { Cookie: sessionCookie },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "application/json");
      assert.match(res.headers["content-disposition"]!, /attachment; filename="diagnostic_report.json"/);
      assert.ok(res.headers["x-artifact-sha256"]);
      assert.match(res.raw, /"healthy": true/);
    });
  });

  describe("4. Global Cluster SSE Stream & Logout", () => {
    test("4.1 GET /api/cluster/events/stream 能够建立长连接并推送 cluster.snapshot", async () => {
      return new Promise<void>((resolve, reject) => {
        const url = new URL(`${coordinatorUrl}/api/cluster/events/stream`);
        const req = http.request(
          url,
          {
            method: "GET",
            headers: {
              Cookie: sessionCookie,
              Accept: "text/event-stream",
            },
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.equal(res.headers["content-type"], "text/event-stream");

            let chunkCount = 0;
            res.on("data", (chunk) => {
              const str = chunk.toString();
              chunkCount++;
              if (str.includes("event: cluster.snapshot") || str.includes("onlineNodes")) {
                req.destroy();
                resolve();
              }
            });
            setTimeout(() => {
              if (chunkCount === 0) {
                req.destroy();
                reject(new Error("Timeout waiting for cluster snapshot in SSE"));
              }
            }, 3000);
          }
        );
        req.on("error", (err) => {
          // ignore client destroy
          if ((err as any).code !== "ECONNRESET") {
            reject(err);
          }
        });
        req.end();
      });
    });

    test("4.2 POST /api/auth/logout 销毁会话与清理 Cookie", async () => {
      const res = await requestHttp(`${coordinatorUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: sessionCookie, "x-csrf-token": csrfToken },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      assert.match(cookieStr!, /Max-Age=0/);

      // 登出后再访问受保护端点返回 401
      const meRes = await requestHttp(`${coordinatorUrl}/api/auth/me`, {
        headers: { Cookie: sessionCookie },
      });
      assert.equal(meRes.status, 401);
    });
  });

  describe("5. Static SPA Assets & Client Routing Fallback", () => {
    test("5.1 GET / 能够正确提供构建产物 index.html", async () => {
      const res = await requestHttp(`${coordinatorUrl}/`, { headers: { Authorization: "Bearer test-admin-secret-key" } });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"]!, /text\/html/);
      assert.match(res.raw, /<!DOCTYPE html>/i);
      assert.match(res.raw, /<div id="app"/i);
    });

    test("5.2 GET /graphs 客户端路由触发 SPA 优雅回退返回 index.html", async () => {
      const res = await requestHttp(`${coordinatorUrl}/graphs`, { headers: { Authorization: "Bearer test-admin-secret-key" } });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"]!, /text\/html/);
      assert.match(res.raw, /<div id="app"/i);
    });

    test("5.3 GET /manifest.webmanifest 正确提供 PWA Manifest", async () => {
      const res = await requestHttp(`${coordinatorUrl}/manifest.webmanifest`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"]!, /application\/manifest\+json/);
      assert.match(res.raw, /Nash Agent Workspace/);
    });

    test("5.4 GET /favicon.svg 正确提供矢量图标", async () => {
      const res = await requestHttp(`${coordinatorUrl}/favicon.svg`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"]!, /image\/svg\+xml/);
      assert.match(res.raw, /<svg/);
    });
  });
});
