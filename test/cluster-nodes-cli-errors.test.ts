import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpretClusterResponse,
  formatClusterConnectionError,
} from "../src/cluster/cli/cluster-response.js";

const TARGET_URL = "http://127.0.0.1:18443/api/cluster/nodes";

test("HTTP 200 且 nodes 为空数组：确实没有节点，退出码 0", () => {
  const result = interpretClusterResponse(200, JSON.stringify({ nodes: [] }), TARGET_URL);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, "No nodes registered yet.");
  assert.deepEqual(result.data?.nodes, []);
});

test("HTTP 200 且存在节点：可继续渲染，不再输出空列表提示", () => {
  const body = JSON.stringify({
    nodes: [{ nodeId: "node-a", name: "Mac", status: "online", platform: "darwin", arch: "arm64" }],
  });
  const result = interpretClusterResponse(200, body, TARGET_URL);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, "");
  assert.equal(result.data?.nodes.length, 1);
});

test("HTTP 401：明确认证失败并提供 NASH_ADMIN_API_KEY / Web 控制台指引，退出码 1", () => {
  const body = JSON.stringify({ error: "未登录或登录会话已过期", authenticated: false });
  const result = interpretClusterResponse(401, body, TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /401/);
  assert.match(result.message, /authentication failed/i);
  assert.match(result.message, /NASH_ADMIN_API_KEY/);
  assert.match(result.message, /Web console/i);
  // 服务端返回的 error 文本不能被吞掉。
  assert.match(result.message, /未登录或登录会话已过期/);
  assert.doesNotMatch(result.message, /No nodes registered yet/);
});

test("HTTP 401 且无响应体：仍给出可操作的认证指引", () => {
  const result = interpretClusterResponse(401, "", TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /401/);
  assert.match(result.message, /NASH_ADMIN_API_KEY/);
});

test("HTTP 403：明确权限不足并保留服务端 detail，退出码 1", () => {
  const result = interpretClusterResponse(403, JSON.stringify({ error: "当前账号没有执行权限" }), TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /403/);
  assert.match(result.message, /permission denied/i);
  assert.match(result.message, /当前账号没有执行权限/);
  assert.doesNotMatch(result.message, /No nodes registered yet/);
});

test("HTTP 500：报告服务端错误与状态码，退出码 1", () => {
  const result = interpretClusterResponse(500, JSON.stringify({ error: "请求处理失败，请稍后重试" }), TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /HTTP 500/);
  assert.match(result.message, /server error/i);
  assert.match(result.message, /请求处理失败/);
  assert.match(result.message, new RegExp(TARGET_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("其他 4xx（如 404）：同样失败并带状态码与 detail", () => {
  const result = interpretClusterResponse(404, JSON.stringify({ error: "Endpoint not found" }), TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /HTTP 404/);
  assert.match(result.message, /Endpoint not found/);
});

test("HTTP 200 但响应不是合法 JSON：报告协议错误，退出码 1", () => {
  const result = interpretClusterResponse(200, "<html>bad gateway</html>", TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /not valid JSON/i);
  assert.match(result.message, /bad gateway/);
  assert.doesNotMatch(result.message, /No nodes registered yet/);
});

test("HTTP 200 但缺少 nodes 数组：报告数据结构错误，退出码 1", () => {
  const result = interpretClusterResponse(200, JSON.stringify({ nodesCount: 0 }), TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /missing "nodes" array/);
  assert.doesNotMatch(result.message, /No nodes registered yet/);
});

test("HTTP 200 但响应体为空：报告空响应错误，退出码 1", () => {
  const result = interpretClusterResponse(200, "   ", TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /empty body/i);
});

test("HTTP 200 但响应体是 JSON 数组而非对象：报告协议错误，退出码 1", () => {
  const result = interpretClusterResponse(200, JSON.stringify([]), TARGET_URL);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /expected a JSON object/i);
});

test("网络不可达：连接错误消息包含目标地址与底层原因", () => {
  const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18443"), {
    code: "ECONNREFUSED",
  });
  const message = formatClusterConnectionError(TARGET_URL, error);
  assert.match(message, /Failed to connect to Coordinator at/);
  assert.ok(message.includes(TARGET_URL), "连接错误消息必须包含目标地址");
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /NASH_COORDINATOR_URL/);
});

test("网络不可达且错误不是 Error 实例：仍输出目标地址", () => {
  const message = formatClusterConnectionError(TARGET_URL, "socket hang up");
  assert.ok(message.includes(TARGET_URL));
  assert.match(message, /socket hang up/);
});
