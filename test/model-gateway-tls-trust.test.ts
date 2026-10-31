import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { callChatCompletions } from "../src/model/chat-completions-client.js";

/**
 * 真实 TLS 信任链回归：
 * Coordinator 自签 CA 必须真正作用于模型请求。
 *
 * 历史缺陷：Node 全局 fetch(undici) 忽略 `agent` 选项，
 * 传入 https.Agent 会被静默丢弃，自签证书仍然报 self-signed certificate。
 */

function opensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeSelfSigned(t: TestContext): { dir: string; cert: string; key: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-tls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: "ignore" });
  return { dir, cert: fs.readFileSync(cert, "utf-8"), key: fs.readFileSync(key, "utf-8") };
}

async function startServer(t: TestContext, key: string, cert: string): Promise<number> {
  const server = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "gateway-ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

function withNashHome(t: TestContext, caPem?: string): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nash-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (caPem) fs.writeFileSync(path.join(home, "nash-ca.crt"), caPem);
  const previous = process.env.NASH_HOME;
  process.env.NASH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.NASH_HOME; else process.env.NASH_HOME = previous; });
}

const modelRequest = { model: "nash-gateway", messages: [{ role: "user" as const, content: "ping" }] };

test("模型请求必须真正信任 Coordinator 自签 CA", { skip: !opensslAvailable() }, async (t) => {
  const { cert, key } = makeSelfSigned(t);
  const port = await startServer(t, key, cert);
  withNashHome(t, cert);

  const response = await callChatCompletions(
    `https://127.0.0.1:${port}/v1`,
    "node-token",
    modelRequest as never,
    { purpose: "agent" }
  );
  assert.equal(response.choices[0]!.message.content, "gateway-ok");
});

test("没有 CA 时必须如实失败，不得悄悄跳过证书校验", { skip: !opensslAvailable() }, async (t) => {
  const { key, cert } = makeSelfSigned(t);
  const port = await startServer(t, key, cert);
  withNashHome(t);

  await assert.rejects(
    () => callChatCompletions(`https://127.0.0.1:${port}/v1`, "node-token", modelRequest as never, { purpose: "agent" }),
    (error: unknown) => {
      const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
      assert.match(message, /self[- ]signed|certificate|UNABLE_TO_VERIFY|SELF_SIGNED/i);
      return true;
    }
  );
});
