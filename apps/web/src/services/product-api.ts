import { api, ApiError } from "./api";

export type ModelFormat = "completions" | "responses" | "messages";
export interface ModelProfile {
  id?: string;
  baseUrl: string;
  model: string;
  format: ModelFormat;
  apiKey?: string;
  timeoutMs?: number;
  streaming?: boolean;
  toolCalling?: boolean;
}
export interface PublicProfile extends Omit<ModelProfile, "apiKey"> { apiKeyConfigured: boolean }
export type SecurityBinding = { mode: "follow-main" | "coordinator" } | { mode: "same-provider"; model: string } | { mode: "independent"; profile: ModelProfile };
export type PublicSecurityBinding = Exclude<SecurityBinding, { mode: "independent" }> | { mode: "independent"; profile: PublicProfile };
export interface SecurityPolicy {
  filesystem: "read-only" | "workspace-write" | "full-capability" | "danger-full-access";
  network: "allow" | "deny";
  approval: "ask" | "never" | "auto-grant";
  confirmFullAccess?: boolean;
}
export interface ProductConfig {
  version: number;
  createdAt: number;
  role: "coordinator" | "worker" | "coordinator-worker";
  coordinator: { listenHost: string; listenPort: number; publicUrl?: string; databaseConfigured: boolean };
  models: { main?: PublicProfile; security: PublicSecurityBinding };
  security: SecurityPolicy;
  worker?: { coordinatorUrl: string; name?: string; workspace?: string; inheritModels?: boolean };
  nodeOverrides: Record<string, { main?: PublicProfile; security?: PublicSecurityBinding }>;
}
export interface ConfigPatch {
  coordinator?: { listenHost: string; listenPort: number; publicUrl?: string; databaseUrl?: string };
  models?: { main?: ModelProfile; security?: SecurityBinding };
  security?: SecurityPolicy;
  nodeOverrides?: Record<string, { main?: ModelProfile; security?: SecurityBinding }>;
}
export interface ModelCheck {
  passed: boolean;
  checks: Record<string, boolean>;
  format: string;
  model: string;
  durationMs: number;
  usageReported: boolean;
}
export interface ProductUser { userId: string; username: string; role: "admin" | "viewer"; credentialVersion: number }
export interface Diagnostics {
  configurationVersion: number;
  activeServiceConfigurationVersion?: number;
  pendingRestart?: boolean;
  securityApplyPending?: { version: number; updatedAt: number; attempts?: number; state?: "waiting_retry" | "blocked"; nextRetryAt?: number | null; errorCode?: string } | null;
  authentication: string;
  database: { product: string; cluster: string; configuredCluster?: string; connection?: { product: string; cluster: string; checkedAt: number; error?: string } };
  gateway: { authenticated: boolean; activeRequests: number; maxConcurrentRequests: number; maxPerNode: number };
  nodes: Array<{ nodeId: string; status: string; platform?: string; sandbox?: unknown }>;
  restartRequiredFor: string[];
}
export const productApi = {
  config: () => api.request<ProductConfig>("/api/product/config"),
  update: (patch: ConfigPatch, expectedVersion: number) => api.request<{ config: ProductConfig; applied: boolean; scope: string; restartRequired: boolean }>("/api/product/config", { method: "PUT", body: { patch, expectedVersion } }),
  testModel: (profile: ModelProfile, purpose: "main" | "security", nodeId?: string) => api.request<ModelCheck>("/api/product/models/test", { method: "POST", body: { profile, purpose, nodeId } }),
  versions: () => api.request<{ versions: Array<{ version: number; createdAt: number }> }>("/api/product/versions"),
  rollback: (version: number, expectedVersion: number, confirmFullAccess = false) => api.request<{ config: ProductConfig; scope: string; restartRequired?: boolean }>("/api/product/rollback", { method: "POST", body: { version, expectedVersion, confirmFullAccess } }),
  users: () => api.request<{ users: ProductUser[] }>("/api/product/users"),
  createAdmin: (username: string, password: string) => api.request<{ user: ProductUser }>("/api/product/users", { method: "POST", body: { username, password } }),
  changePassword: (userId: string, password: string) => api.request<{ success: boolean; sessionsRevoked: boolean }>(`/api/product/users/${encodeURIComponent(userId)}/password`, { method: "POST", body: { password } }),
  diagnostics: () => api.request<Diagnostics>("/api/product/diagnostics"),
  invite: () => api.request<{ inviteCode: string; expiresAt: number; maxUses: number }>("/api/cluster/invite", { method: "POST", body: { role: "worker", ttlMs: 600000, maxUses: 1 } }),
  revokeNode: (nodeId: string) => api.request<{ success: boolean; nodeId: string }>(`/api/cluster/nodes/${encodeURIComponent(nodeId)}/revoke`, { method: "POST", body: {} }),
};
export function productError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return "配置已被其他操作更新。请刷新最新版本，重新审阅后再保存。";
  if (error instanceof ApiError && error.status === 403) return "此操作需要管理员权限。";
  return error instanceof Error ? error.message : "暂时无法完成操作，请重试。";
}
export interface ProfileDraft extends PublicProfile { apiKey: string }
export function profileDraft(profile?: PublicProfile): ProfileDraft {
  return { id: profile?.id, baseUrl: profile?.baseUrl ?? "", model: profile?.model ?? "", format: profile?.format ?? "completions", timeoutMs: profile?.timeoutMs ?? 120000, streaming: profile?.streaming ?? true, toolCalling: profile?.toolCalling ?? true, apiKeyConfigured: profile?.apiKeyConfigured ?? false, apiKey: "" };
}
export function profileInput(draft: ProfileDraft): ModelProfile {
  const { apiKeyConfigured: _configured, apiKey, ...profile } = draft;
  return { ...profile, baseUrl: profile.baseUrl.trim(), model: profile.model.trim(), ...(apiKey ? { apiKey } : {}) };
}
