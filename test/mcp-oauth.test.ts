import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MCPOAuthHandler } from "../src/mcp/oauth-handler.js";
import { CredentialStore } from "../src/mcp/credential-store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("MCP OAuth 2.0 & PKCE (RFC 7636) Flow Suite", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-oauth-test-"));
  const credStore = new CredentialStore({ homeDir: tmpDir });

  await t.test("1. PKCE S256 code_verifier 与 code_challenge 正确生成", () => {
    const { codeVerifier, codeChallenge } = MCPOAuthHandler.generatePKCE();
    assert.ok(codeVerifier.length >= 43);
    assert.ok(codeChallenge.length >= 43);
    assert.notEqual(codeVerifier, codeChallenge);
  });

  await t.test("2. 本地 Callback 服务器接收 Authorization Code 与 State 防篡改校验", async () => {
    const state = "test_state_12345";
    const listener = await MCPOAuthHandler.startCallbackListener(state, 5000);

    // 发起正常带 code 和 state 的回调请求
    const res = await fetch(`http://127.0.0.1:${listener.port}/callback?code=mock_code_abc&state=${state}`);
    assert.equal(res.status, 200);

    const code = await listener.waitForCode();
    assert.equal(code, "mock_code_abc");
    listener.close();
  });

  await t.test("3. Token 兑换与刷新", async () => {
    // 模拟 OAuth Token 端点
    const tokenServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("grant_type") === "authorization_code") {
          assert.equal(params.get("code"), "auth_code_xyz");
          assert.equal(params.get("code_verifier"), "my_verifier");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "mock_access_token_111",
              refresh_token: "mock_refresh_token_222",
              expires_in: 3600,
              token_type: "Bearer",
            })
          );
        } else if (params.get("grant_type") === "refresh_token") {
          assert.equal(params.get("refresh_token"), "mock_refresh_token_222");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "mock_refreshed_access_token_333",
              refresh_token: "mock_refresh_token_222",
              expires_in: 3600,
            })
          );
        }
      });
    });

    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
    const tokenPort = (tokenServer.address() as any).port;
    const tokenUrl = `http://127.0.0.1:${tokenPort}/token`;

    // 兑换 Token
    const exchanged = await MCPOAuthHandler.exchangeCodeForToken({
      tokenUrl,
      code: "auth_code_xyz",
      codeVerifier: "my_verifier",
      clientId: "nash-test-client",
      redirectUri: "http://127.0.0.1/callback",
    });

    assert.equal(exchanged.accessToken, "mock_access_token_111");
    assert.equal(exchanged.refreshToken, "mock_refresh_token_222");

    // 保存至 CredentialStore
    credStore.setOAuthCredential("oauth-srv", {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      expiresAt: Date.now() + 3600 * 1000,
    });

    const stored = credStore.getCredential("oauth-srv");
    assert.equal(stored?.oauth?.accessToken, "mock_access_token_111");

    // 刷新 Token
    const refreshed = await MCPOAuthHandler.refreshToken({
      tokenUrl,
      refreshToken: exchanged.refreshToken!,
      clientId: "nash-test-client",
    });

    assert.equal(refreshed.accessToken, "mock_refreshed_access_token_333");

    tokenServer.close();
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
