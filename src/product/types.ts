import type { NashModelConfig } from "../config/nash-config.js";
import type { FilesystemMode, NetworkMode, ApprovalMode } from "../sandbox/types.js";

export type ProductRole = "coordinator" | "worker" | "coordinator-worker";
export interface ModelProfileInput {
  id?: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  format: "completions" | "responses" | "messages";
  timeoutMs?: number;
  streaming?: boolean;
  toolCalling?: boolean;
}
export type SecurityModelBinding = { mode: "follow-main" } | { mode: "same-provider"; model: string } | { mode: "independent"; profile: ModelProfileInput } | { mode: "coordinator" };
export interface ProductInitInput {
  role: ProductRole;
  coordinator: { listenHost: string; listenPort: number; publicUrl?: string; databaseUrl?: string; tls?: { certPath: string; keyPath: string } };
  models: { main?: ModelProfileInput; security?: SecurityModelBinding };
  security: { filesystem: FilesystemMode; network: NetworkMode; approval: ApprovalMode; confirmFullAccess?: boolean };
  admin?: { username: string; password: string };
  worker?: { coordinatorUrl: string; name?: string; workspace?: string; inheritModels?: boolean };
}
export interface PublicModelProfile extends Omit<ModelProfileInput, "apiKey"> { apiKeyConfigured: boolean }
export interface ProductPublicConfig extends Omit<ProductInitInput, "admin" | "models" | "coordinator"> {
  version: number;
  createdAt: number;
  coordinator: Omit<ProductInitInput["coordinator"], "databaseUrl"> & { databaseConfigured: boolean };
  models: { main?: PublicModelProfile; security: Exclude<SecurityModelBinding, { mode: "independent" }> | { mode: "independent"; profile: PublicModelProfile } };
  nodeOverrides: Record<string, { main?: PublicModelProfile; security?: ProductPublicConfig["models"]["security"] }>;
}
export interface ProductConfigUpdate extends Partial<Omit<ProductInitInput, "admin">> {
  nodeOverrides?: Record<string, { main?: ModelProfileInput; security?: SecurityModelBinding }>;
}
export interface ProductUser { userId: string; username: string; role: "admin" | "viewer"; credentialVersion: number }
export interface ResolvedModel extends NashModelConfig {
  timeoutMs: number;
  streaming: boolean;
  toolCalling: boolean;
  configurationVersion: number;
  headers?: Record<string, string>;
}
export class ProductConfigError extends Error {
  constructor(message: string, readonly code = "INVALID_CONFIG") { super(message); this.name = "ProductConfigError"; }
}
