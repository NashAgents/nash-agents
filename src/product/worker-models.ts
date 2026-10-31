import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { ProductStore } from "./store.js";
import type { ProductModelContext } from "./runtime.js";
import type { NodeIdentity } from "../cluster/identity/node-identity.js";
import type { ResolvedModel } from "./types.js";
import { ProductConfigError } from "./types.js";
import { resolveNashHome } from "../config/data-home.js";

async function secureGetJson(urlStr: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    let ca: Buffer | undefined;
    const caPath = path.join(resolveNashHome(), "nash-ca.crt");
    if (url.protocol === "https:" && fs.existsSync(caPath)) {
      try { ca = fs.readFileSync(caPath); } catch {}
    }
    const req = transport.request(url, { method: "GET", headers, ca, timeout: 5000 }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          resolve({ ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, data: JSON.parse(body) });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

export function workerModels(store: ProductStore, identity: NodeIdentity, taskId: string, runId: string): ProductModelContext {
  const config = store.getPublicConfig();
  if (!identity.coordinatorUrl || !identity.nodeToken) throw new ProductConfigError("Worker 尚未完成安全配对", "NODE_NOT_PAIRED");
  const coordinator = new URL(identity.coordinatorUrl); coordinator.protocol = coordinator.protocol === "wss:" ? "https:" : coordinator.protocol === "ws:" ? "http:" : coordinator.protocol;
  const gateway = (purpose: "main" | "security" | "security-main"): ResolvedModel => ({ baseUrl: `${coordinator.origin}/api/product/gateway/${purpose}/v1`, apiKey: identity.nodeToken!, model: "nash-gateway", format: "completions", timeoutMs: 180000, contextWindow: 64000, compactionThreshold: 0.8, streaming: true, toolCalling: true, configurationVersion: config.version,
    headers: { "X-Nash-Node-Id": identity.nodeId, "X-Nash-Task-Id": taskId, "X-Nash-Run-Id": runId } });
  const inherit = config.role !== "worker" || config.worker?.inheritModels !== false || !config.models.main;
  const main = inherit ? gateway("main") : store.resolveModel({ purpose: "main" });
  const binding = config.models.security;
  const security = config.role !== "worker" || binding.mode === "coordinator" ? gateway("security")
    : binding.mode === "independent" ? store.resolveModel({ purpose: "security" })
    : binding.mode === "follow-main" ? inherit ? gateway("security-main") : { ...main }
    : inherit ? (() => { throw new ProductConfigError("继承网关模型时，请在 Coordinator 的节点覆盖中指定不同安全模型"); })() : store.resolveModel({ purpose: "security" });
  return { main, security, version: config.version };
}
export interface RemoteTaskGrantReport {
  grantId: string;
  status: string;
  targetPolicy: { filesystem: { mode: string }; network: { mode: string }; approval: { mode: string } };
}

export async function workerPolicy(store: ProductStore, identity: NodeIdentity, taskId: string, runId: string): Promise<{ configurationVersion: number; security: import("./types.js").ProductInitInput["security"]; grant: RemoteTaskGrantReport | null }> {
  if (!identity.coordinatorUrl || !identity.nodeToken) throw new ProductConfigError("Worker 尚未完成安全配对", "NODE_NOT_PAIRED");
  const coordinator = new URL(identity.coordinatorUrl); coordinator.protocol = coordinator.protocol === "wss:" ? "https:" : coordinator.protocol === "ws:" ? "http:" : coordinator.protocol;
  const result = await secureGetJson(`${coordinator.origin}/api/product/gateway/policy`, { Authorization: `Bearer ${identity.nodeToken}`, "X-Nash-Node-Id": identity.nodeId, "X-Nash-Task-Id": taskId, "X-Nash-Run-Id": runId });
  if (!result.ok) throw new ProductConfigError("节点或任务授权不可验证，已停止执行", "AUTHORIZATION_UNAVAILABLE");
  const remote = result.data as { configurationVersion: number; security: import("./types.js").ProductInitInput["security"]; grant?: RemoteTaskGrantReport | null };
  const local = store.getPublicConfig().security;
  const order = { "read-only": 0, "workspace-write": 1, "full-capability": 2, "danger-full-access": 3 };
  if (!remote.security || !Object.hasOwn(order, remote.security.filesystem) || !["allow", "deny"].includes(remote.security.network) || !["ask", "never", "auto-grant"].includes(remote.security.approval) || !Number.isSafeInteger(remote.configurationVersion)) throw new ProductConfigError("Coordinator 返回了无效策略", "INVALID_REMOTE_POLICY");
  const approval = local.approval === "never" || remote.security.approval === "never" ? "never" : local.approval === "ask" || remote.security.approval === "ask" ? "ask" : "auto-grant";
  const grant = remote.grant && typeof remote.grant === "object" && typeof remote.grant.grantId === "string" ? remote.grant : null;
  return { configurationVersion: remote.configurationVersion, security: { filesystem: order[local.filesystem] < order[remote.security.filesystem] ? local.filesystem : remote.security.filesystem, network: local.network === "deny" || remote.security.network === "deny" ? "deny" : "allow", approval }, grant };
}
