import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ProductStore, validateProductPatch } from "./store.js";
import { ProductConfigError, type ProductConfigUpdate, type ModelProfileInput } from "./types.js";
import { testModelProfile } from "./model-check.js";
import { NodeIdentity } from "../cluster/identity/node-identity.js";
import type { IClusterStore } from "../cluster/storage/cluster-store.js";
import { callChatCompletions, streamChatCompletions, type ChatCompletionRequest } from "../model/chat-completions-client.js";
import { NASH_SECURITY_MONITOR_SYSTEM_PROMPT } from "../security/security-prompt.js";
import { WebRequestError } from "../cluster/coordinator/web-security.js";

async function jsonBody(req: IncomingMessage): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) throw new WebRequestError(413, "请求内容过大"); chunks.push(Buffer.from(chunk)); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new WebRequestError(400, "请求必须为有效 JSON 对象"); }
}
function reply(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
async function streamWrite(res: ServerResponse, chunk: unknown): Promise<void> {
  if (res.write(`data: ${JSON.stringify(chunk)}\n\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { res.off("drain", drain); res.off("close", close); res.off("error", fail); };
    const drain = () => { cleanup(); resolve(); };
    const close = () => { cleanup(); reject(new DOMException("Worker disconnected", "AbortError")); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    res.once("drain", drain); res.once("close", close); res.once("error", fail);
    if (res.destroyed) close();
  });
}
export class ProductHttpApi {
  private readonly running = new Map<string, number>();
  private readonly active = new Set<AbortController>();
  private readonly activeServiceConfig: ReturnType<ProductStore["getPublicConfig"]>;
  private readonly securityRetryTimer: NodeJS.Timeout;
  private securityApplyInFlight?: Promise<void>;
  private closed = false;
  constructor(readonly product: ProductStore, private readonly cluster: IClusterStore, private readonly onSecurityRevoked?: () => Promise<void>, private readonly onUserChanged?: (userId: string) => Promise<void>) {
    this.activeServiceConfig = product.getPublicConfig();
    this.securityRetryTimer = setInterval(() => { void this.retrySecurityApply().catch(() => {}); }, 5000);
    this.securityRetryTimer.unref();
    queueMicrotask(() => { if (!this.closed) void this.retrySecurityApply(true).catch(() => {}); });
  }
  private retrySecurityApply(force = false): Promise<void> {
    if (this.securityApplyInFlight) return this.securityApplyInFlight;
    const pending = this.product.pendingSecurityApply();
    if (!pending) return Promise.resolve();
    if (!force && (pending.state === "blocked" || (pending.nextRetryAt && pending.nextRetryAt > Date.now()))) return Promise.resolve();
    const operation = (async () => {
      try {
        if (!this.onSecurityRevoked) throw new Error("Security apply handler unavailable");
        await this.onSecurityRevoked();
        this.product.completeSecurityApply(pending.version);
      } catch (error) {
        const blocked = !this.onSecurityRevoked;
        const delay = Math.min(300000, 5000 * 2 ** Math.min(pending.attempts ?? 0, 6));
        this.product.recordSecurityApplyFailure(pending.version, blocked ? "blocked" : "waiting_retry", blocked ? null : Date.now() + delay, blocked ? "HANDLER_UNAVAILABLE" : "APPLICATION_FAILED");
        throw error;
      }
    })();
    this.securityApplyInFlight = operation.finally(() => { this.securityApplyInFlight = undefined; });
    return this.securityApplyInFlight;
  }
  private async applySecurityChange(previous: ReturnType<ProductStore["getPublicConfig"]>, config: ReturnType<ProductStore["getPublicConfig"]>): Promise<void> {
    if (!this.product.pendingSecurityApply()) return;
    try {
      await this.retrySecurityApply(true);
      if (this.product.pendingSecurityApply()) throw new Error("A newer security change remains pending");
    }
    catch (error) {
      const requestId = randomUUID();
      console.error(`[product.config] COMMITTED_APPLY_FAILED requestId=${requestId} version=${config.version} errorType=${error instanceof Error ? error.name : "unknown"}`);
      throw new WebRequestError(503, `COMMITTED_APPLY_FAILED：配置 v${config.version} 已保存，但运行中任务的权限复核未完成。请刷新配置并检查服务日志（${requestId}）。`);
    }
  }
  close(): void { this.closed = true; clearInterval(this.securityRetryTimer); for (const controller of this.active) controller.abort(new DOMException("Coordinator stopped", "AbortError")); }
  async handleGateway(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/product/gateway/")) return false;
    const policyRequest = req.method === "GET" && url.pathname === "/api/product/gateway/policy";
    if (!policyRequest && (req.method !== "POST" || !/^\/api\/product\/gateway\/(main|security|security-main)\/v1\/chat\/completions$/.test(url.pathname))) throw new WebRequestError(404, "模型网关地址无效");
    const nodeId = req.headers["x-nash-node-id"], taskId = req.headers["x-nash-task-id"], runId = req.headers["x-nash-run-id"];
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
    if (typeof nodeId !== "string" || typeof taskId !== "string" || typeof runId !== "string" || !token || [nodeId, taskId, runId].some(id => id.length > 128)) throw new WebRequestError(401, "节点运行凭据缺失");
    const authorize = async () => {
      if (this.product.pendingSecurityApply()) throw new WebRequestError(503, "SECURITY_APPLY_PENDING：权限收紧尚未完成复核，模型网关暂不可用。");
      const node = await this.cluster.getNode(nodeId), task = await this.cluster.getTask(taskId);
      const hash = Buffer.from(NodeIdentity.hashToken(token)), expected = Buffer.from(node?.tokenHash ?? "");
      if (!node || !["online", "suspect"].includes(node.status) || hash.length !== expected.length || !timingSafeEqual(hash, expected)) throw new WebRequestError(401, "节点凭据已失效");
      if (!task || task.nodeId !== nodeId || task.runId !== runId || !["dispatched", "accepted", "running", "waiting_approval"].includes(task.status)) throw new WebRequestError(403, "模型调用不属于有效运行");
      return task;
    };
    const task = await authorize();
    if (policyRequest) {
      const config = this.product.getPublicConfig();
      const grant = await this.cluster.getActiveTaskSecurityGrant?.(taskId, runId);
      const security = grant && grant.status === "applied" ? {
        filesystem: grant.targetPolicy.filesystem.mode,
        network: grant.targetPolicy.network.mode,
        approval: grant.targetPolicy.approval.mode,
      } : config.security;
      reply(res, 200, {
        configurationVersion: this.product.bindRunConfiguration(runId, nodeId, taskId),
        security,
        // Worker 用该字段判断任务级授权是否仍被 Coordinator 认可，
        // 不能用被本地策略钳制后的 security 做比较。
        grant: grant ? { grantId: grant.grantId, status: grant.status, targetPolicy: grant.targetPolicy } : null,
      });
      return true;
    }
    const count = this.running.get(nodeId) ?? 0;
    if (count >= 4 || this.active.size >= 16) throw new WebRequestError(429, "模型网关繁忙，请稍后重试");
    this.running.set(nodeId, count + 1);
    const controller = new AbortController(); this.active.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(new DOMException("Worker disconnected", "AbortError")); };
    req.once("aborted", abort); res.once("close", abort);
    const check = setInterval(() => { void authorize().catch(() => controller.abort(new DOMException("Node or task authorization revoked", "AbortError"))); }, 500);
    check.unref();
    try {
      const body = await jsonBody(req);
      if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000 || body.messages.some((message: any) => !message || !["user", "assistant", "system", "tool"].includes(message.role))) throw new WebRequestError(400, "模型消息格式无效");
      if (body.tools && (!Array.isArray(body.tools) || body.tools.length > 512)) throw new WebRequestError(400, "工具定义无效");
      const version = this.product.bindRunConfiguration(runId, nodeId, taskId);
      const securityPurpose = url.pathname.includes("/security/") || url.pathname.includes("/security-main/");
      const purpose = url.pathname.includes("/security/") ? "security" : "main";
      const profile = this.product.resolveModel({ nodeId, purpose, version });
      const request: ChatCompletionRequest = { model: profile.model, messages: body.messages, tools: profile.toolCalling ? body.tools : undefined, temperature: typeof body.temperature === "number" ? body.temperature : undefined };
      if (securityPurpose) { request.tools = undefined; request.messages = [{ role: "system", content: NASH_SECURITY_MONITOR_SYSTEM_PROMPT }, ...request.messages.filter(message => message.role === "user")]; }
      const options = { signal: controller.signal, timeoutMs: profile.timeoutMs, format: profile.format, purpose: purpose === "security" ? "security" as const : "agent" as const,
        context: { taskId, runId, nodeId, projectId: task.projectId }, usageSink: async () => {} };
      // Usage is returned to the worker's existing durable ledger; do not count the proxy hop twice.
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Nash-Config-Version": String(version) });
        if (!profile.streaming) {
          const result = await callChatCompletions(profile.baseUrl, profile.apiKey, request, options), message = result.choices[0]?.message;
          if ((!profile.toolCalling || securityPurpose) && message?.tool_calls?.length) throw new WebRequestError(502, "模型返回了未授权工具调用");
          await streamWrite(res, { id: result.id, model: result.model, choices: [{ index: 0, delta: { ...message, tool_calls: message?.tool_calls?.map((call, index) => ({ ...call, index })) }, finish_reason: null }] });
          await streamWrite(res, { id: result.id, model: result.model, choices: [{ index: 0, delta: {}, finish_reason: result.choices[0]?.finish_reason }], usage: result.usage });
        } else for await (const chunk of streamChatCompletions(profile.baseUrl, profile.apiKey, request, options)) {
          if ((!profile.toolCalling || securityPurpose) && chunk.choices.some(choice => choice.delta.tool_calls?.length)) throw new WebRequestError(502, "模型返回了未授权工具调用");
          await streamWrite(res, chunk);
        }
        res.end("data: [DONE]\n\n");
      } else {
        const result = await callChatCompletions(profile.baseUrl, profile.apiKey, request, options);
        if ((!profile.toolCalling || securityPurpose) && result.choices[0]?.message.tool_calls?.length) throw new WebRequestError(502, "模型返回了未授权工具调用");
        res.setHeader("X-Nash-Config-Version", String(version)); reply(res, 200, result);
      }
    } catch (error) {
      if (res.headersSent) { if (!res.destroyed) res.destroy(); }
      else if (error instanceof WebRequestError) throw error;
      else throw new WebRequestError(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? "模型调用已取消" : "模型服务调用失败，请检查配置与服务状态");
    } finally { clearInterval(check); req.off("aborted", abort); res.off("close", abort); this.active.delete(controller); const remaining = (this.running.get(nodeId) ?? 1) - 1; if (remaining) this.running.set(nodeId, remaining); else this.running.delete(nodeId); }
    return true;
  }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, user: { userId: string; role: string }): Promise<boolean> {
    if (!url.pathname.startsWith("/api/product/")) return false;
    if (user.role !== "admin") throw new WebRequestError(403, "此操作需要管理员权限");
    try {
      if (req.method === "GET" && url.pathname === "/api/product/config") reply(res, 200, this.product.getPublicConfig());
      else if (req.method === "PUT" && url.pathname === "/api/product/config") {
        const body = await jsonBody(req), patch = body.patch as ProductConfigUpdate;
        if (!patch || typeof patch !== "object" || !Number.isSafeInteger(body.expectedVersion)) throw new WebRequestError(400, "需要配置修改与当前版本号");
        validateProductPatch(patch);
        if (this.product.getPublicConfig().version !== body.expectedVersion) throw new ProductConfigError("配置已变化，请刷新", "VERSION_CONFLICT");
        if (patch.models?.main) await testModelProfile(this.product.previewModel(patch.models.main));
        if (patch.models?.security?.mode === "independent") await testModelProfile(this.product.previewModel(patch.models.security.profile, "security"));
        if (patch.models?.security?.mode === "same-provider") {
          const base = patch.models.main ?? this.product.resolveModel({ purpose: "main" });
          await testModelProfile(this.product.previewModel({ baseUrl: base.baseUrl, model: patch.models.security.model, apiKey: base.apiKey, format: base.format ?? "completions", timeoutMs: base.timeoutMs, streaming: base.streaming, toolCalling: base.toolCalling }));
        }
        for (const [nodeId, override] of Object.entries(patch.nodeOverrides ?? {})) {
          if (override.main) await testModelProfile(this.product.previewModel(override.main, "main", nodeId));
          if (override.security?.mode === "independent") await testModelProfile(this.product.previewModel(override.security.profile, "security", nodeId));
          if (override.security?.mode === "same-provider") {
            const base = override.main ?? this.product.resolveModel({ purpose: "main", nodeId });
            await testModelProfile(this.product.previewModel({ baseUrl: base.baseUrl, model: override.security.model, apiKey: base.apiKey, format: base.format ?? "completions", timeoutMs: base.timeoutMs, streaming: base.streaming, toolCalling: base.toolCalling }, "main", nodeId));
          }
        }
        const previous = this.product.getPublicConfig();
        let config: ReturnType<ProductStore["updateConfig"]>;
        try { config = this.product.updateConfig(patch, { expectedVersion: body.expectedVersion }); }
        catch (error) {
          if (error instanceof ProductConfigError) throw error;
          throw new WebRequestError(503, "CONFIG_PERSISTENCE_FAILED：配置持久化失败，提交状态可能未知；请刷新配置并检查服务日志。");
        }
        await this.applySecurityChange(previous, config);
        const restartRequired = Boolean(patch.coordinator || patch.worker);
        reply(res, 200, { config, applied: true, scope: restartRequired ? "new-runs-and-service-restart" : "new-runs", restartRequired });
      } else if (req.method === "POST" && url.pathname === "/api/product/models/test") {
        const body = await jsonBody(req);
        if (!body.profile || !["main", "security", undefined].includes(body.purpose)) throw new WebRequestError(400, "模型测试参数无效");
        reply(res, 200, await testModelProfile(this.product.previewModel(body.profile as ModelProfileInput, body.purpose ?? "main", body.nodeId)));
      } else if (req.method === "GET" && url.pathname === "/api/product/versions") reply(res, 200, { versions: this.product.listVersions() });
      else if (req.method === "POST" && url.pathname === "/api/product/rollback") {
        const body = await jsonBody(req), previous = this.product.getPublicConfig();
        let config: ReturnType<ProductStore["rollback"]>;
        try { config = this.product.rollback(body.version, body.expectedVersion, { confirmFullAccess: body.confirmFullAccess === true }); }
        catch (error) {
          if (error instanceof ProductConfigError) throw error;
          throw new WebRequestError(503, "CONFIG_PERSISTENCE_FAILED：配置持久化失败，提交状态可能未知；请刷新配置并检查服务日志。");
        }
        await this.applySecurityChange(previous, config);
        const restartRequired = JSON.stringify(config.coordinator) !== JSON.stringify(previous.coordinator) || JSON.stringify(config.worker) !== JSON.stringify(previous.worker);
        reply(res, 200, { config, scope: restartRequired ? "new-runs-and-service-restart" : "new-runs", restartRequired });
      }
      else if (req.method === "GET" && url.pathname === "/api/product/users") reply(res, 200, { users: this.product.listUsers() });
      else if (req.method === "POST" && url.pathname === "/api/product/users") { const body = await jsonBody(req); reply(res, 201, { user: this.product.createAdmin(body.username, body.password) }); }
      else if (req.method === "POST" && /^\/api\/product\/users\/[^/]+\/password$/.test(url.pathname)) { const body = await jsonBody(req); const userId = url.pathname.split("/")[4]; this.product.changePassword(userId, body.password); await this.onUserChanged?.(userId); reply(res, 200, { success: true, sessionsRevoked: true }); }
      else if (req.method === "GET" && url.pathname === "/api/product/diagnostics") {
        const config = this.product.getPublicConfig();
        let nodes: Awaited<ReturnType<IClusterStore["listNodes"]>> = [], error: string | undefined;
        try { nodes = await this.cluster.listNodes(); } catch { error = "集群数据库连接不可用，请检查服务与连接配置"; }
        const pendingRestart = JSON.stringify(config.coordinator) !== JSON.stringify(this.activeServiceConfig.coordinator) || JSON.stringify(config.worker) !== JSON.stringify(this.activeServiceConfig.worker);
        reply(res, 200, { configurationVersion: config.version, activeServiceConfigurationVersion: this.activeServiceConfig.version, pendingRestart, securityApplyPending: this.product.pendingSecurityApply() ?? null, authentication: "sqlite-scrypt", database: { product: "sqlite", cluster: this.activeServiceConfig.coordinator.databaseConfigured ? "postgresql" : "local", configuredCluster: config.coordinator.databaseConfigured ? "postgresql" : "local", connection: { product: "connected", cluster: error ? "unavailable" : "connected", checkedAt: Date.now(), error } }, gateway: { authenticated: true, activeRequests: this.active.size, maxConcurrentRequests: 16, maxPerNode: 4 }, nodes: nodes.map(node => ({ nodeId: node.nodeId, status: node.status, platform: node.platform, sandbox: node.metadata?.sandboxBackend })), restartRequiredFor: ["coordinator.listenHost", "coordinator.listenPort", "coordinator.databaseUrl", "worker"] });
      } else throw new WebRequestError(404, "配置接口不存在");
    } catch (error) {
      if (error instanceof WebRequestError) throw error;
      if (error instanceof ProductConfigError) throw new WebRequestError(error.code === "VERSION_CONFLICT" ? 409 : 400, error.message);
      throw new WebRequestError(502, req.method === "GET" ? "CONFIG_READ_FAILED：无法读取配置，请检查服务日志。" : "CONFIG_OPERATION_FAILED：配置操作结果无法确认，请刷新并检查服务日志。");
    }
    return true;
  }
}
