import http from "node:http";
import crypto from "node:crypto";
import { URL, URLSearchParams } from "node:url";
import type { MCPOAuthConfig } from "./types.js";
import type { CredentialStore } from "./credential-store.js";

export interface OAuthLoginOptions {
  serverName: string;
  config: MCPOAuthConfig;
  serverUrl?: string;
  credentialStore: CredentialStore;
  openBrowser?: boolean;
  onAuthUrl?: (url: string) => void;
  manualCodeInput?: () => Promise<string>;
}

export interface OAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuer?: string;
}

/**
 * 官方标准 OAuth 2.0 / PKCE (RFC 7636) 授权中枢
 */
export class MCPOAuthHandler {
  /**
   * 生成 PKCE code_verifier 与 code_challenge (S256)
   */
  public static generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  /**
   * 发现 OAuth Metadata (RFC 8414)
   */
  public static async discoverMetadata(baseUrl: string): Promise<OAuthMetadata | null> {
    try {
      const url = new URL(baseUrl);
      const wellKnownUrls = [
        new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
        new URL("/.well-known/openid-configuration", url.origin).toString(),
      ];

      for (const endpoint of wellKnownUrls) {
        try {
          const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const json = (await res.json()) as any;
            if (json.authorization_endpoint && json.token_endpoint) {
              return {
                authorizationEndpoint: json.authorization_endpoint,
                tokenEndpoint: json.token_endpoint,
                issuer: json.issuer,
              };
            }
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  /**
   * 启动本地临时 Callback HTTP 监听器
   */
  public static async startCallbackListener(
    expectedState: string,
    timeoutMs = 120_000
  ): Promise<{
    port: number;
    redirectUri: string;
    server: http.Server;
    waitForCode: () => Promise<string>;
    close: () => void;
  }> {
    return new Promise((setupResolve, setupReject) => {
      let codeResolve: (code: string) => void;
      let codeReject: (err: Error) => void;
      const codePromise = new Promise<string>((res, rej) => {
        codeResolve = res;
        codeReject = rej;
      });

      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);
          if (reqUrl.pathname === "/callback" || reqUrl.pathname === "/") {
            const code = reqUrl.searchParams.get("code");
            const state = reqUrl.searchParams.get("state");
            const error = reqUrl.searchParams.get("error");

            if (error) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<h3>OAuth 认证失败: ${error}</h3><p>您可以关闭此窗口。</p>`);
              codeReject(new Error(`OAuth 授权返回错误: ${error}`));
              return;
            }

            if (state !== expectedState) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<h3>State 校验不匹配，可能存在 CSRF 风险</h3>`);
              codeReject(new Error("OAuth State 校验失败"));
              return;
            }

            if (!code) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(`<h3>未包含 authorization code</h3>`);
              return;
            }

            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
              <html>
                <body style="font-family: system-ui; text-align: center; padding-top: 50px;">
                  <h2>✅ 认证成功！</h2>
                  <p>Nash Agent 已成功获取 MCP 授权凭证。您可以关闭此浏览器标签并返回终端。</p>
                </body>
              </html>
            `);

            codeResolve(code);
          }
        } catch {
          res.writeHead(500);
          res.end("Internal Server Error");
        }
      });

      server.on("error", (err) => {
        setupReject(err);
      });

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any)?.port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;

        const timer = setTimeout(() => {
          codeReject(new Error(`OAuth 授权超时 (${timeoutMs}ms)`));
          try {
            server.close();
          } catch {}
        }, timeoutMs);

        server.on("close", () => clearTimeout(timer));

        setupResolve({
          port,
          redirectUri,
          server,
          waitForCode: () => codePromise,
          close: () => server.close(),
        });
      });
    });
  }

  /**
   * 启动本地临时 Callback HTTP 服务器，捕获重定向 Code（兼容旧接口）
   */
  public static async waitForLocalCallback(
    expectedState: string,
    timeoutMs = 120_000
  ): Promise<{ code: string; redirectUri: string; server: http.Server }> {
    const listener = await MCPOAuthHandler.startCallbackListener(expectedState, timeoutMs);
    const code = await listener.waitForCode();
    return {
      code,
      redirectUri: listener.redirectUri,
      server: listener.server,
    };
  }

  /**
   * 使用 authorization_code 向 Token 节点换取 Access Token
   */
  public static async exchangeCodeForToken(options: {
    tokenUrl: string;
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", options.code);
    body.set("redirect_uri", options.redirectUri);
    body.set("client_id", options.clientId);
    body.set("code_verifier", options.codeVerifier);
    if (options.clientSecret) {
      body.set("client_secret", options.clientSecret);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };

    const res = await fetch(options.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Token 请求失败 (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    if (!data.access_token) {
      throw new Error("Token 响应中未包含 access_token 字段");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      tokenType: data.token_type ?? "Bearer",
    };
  }

  /**
   * 使用 refresh_token 刷新 Access Token
   */
  public static async refreshToken(options: {
    tokenUrl: string;
    refreshToken: string;
    clientId: string;
    clientSecret?: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", options.refreshToken);
    body.set("client_id", options.clientId);
    if (options.clientSecret) {
      body.set("client_secret", options.clientSecret);
    }

    const res = await fetch(options.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Refresh Token 失败 (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? options.refreshToken,
      expiresIn: data.expires_in,
    };
  }
}
