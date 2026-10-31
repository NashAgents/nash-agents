import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveNashHome } from "../config/data-home.js";
import { ProductConfigError, type ProductInitInput, type ProductPublicConfig, type ProductConfigUpdate, type ModelProfileInput, type SecurityModelBinding, type ResolvedModel, type ProductUser } from "./types.js";

type StoredProfile = Omit<ModelProfileInput, "apiKey"> & { secretId?: string };
type StoredSecurity = Exclude<SecurityModelBinding, { mode: "independent" }> | { mode: "independent"; profile: StoredProfile };
export function securityTightened(previous: ProductInitInput["security"], next: ProductInitInput["security"]): boolean {
  const filesystem = { "read-only": 0, "workspace-write": 1, "full-capability": 2, "danger-full-access": 3 };
  const approval = { never: 0, ask: 1, "auto-grant": 2 };
  return filesystem[next.filesystem] < filesystem[previous.filesystem] || (next.network === "deny" && previous.network === "allow") || approval[next.approval] < approval[previous.approval];
}
function securityChanged(previous: ProductInitInput["security"], next: ProductInitInput["security"]): boolean {
  return previous.filesystem !== next.filesystem || previous.network !== next.network || previous.approval !== next.approval;
}
interface StoredConfig extends Omit<ProductInitInput, "admin" | "models" | "coordinator"> {
  version: number; createdAt: number;
  coordinator: Omit<ProductInitInput["coordinator"], "databaseUrl"> & { databaseSecretId?: string };
  models: { main?: StoredProfile; security: StoredSecurity };
  nodeOverrides: Record<string, { main?: StoredProfile; security?: StoredSecurity }>;
}
export const productHome = resolveNashHome;
function keys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ProductConfigError(`${label}包含不支持的字段或格式`);
}
export function validateProductPatch(patch: ProductConfigUpdate): void {
  keys(patch, ["role", "coordinator", "models", "security", "worker", "nodeOverrides"], "配置");
  if (patch.coordinator !== undefined) {
    keys(patch.coordinator, ["listenHost", "listenPort", "publicUrl", "databaseUrl", "tls"], "Coordinator 配置");
    if (patch.coordinator.tls !== undefined && patch.coordinator.tls !== null) {
      keys(patch.coordinator.tls, ["certPath", "keyPath"], "TLS 配置");
      if (typeof patch.coordinator.tls.certPath !== "string" || !patch.coordinator.tls.certPath.trim()) {
        throw new ProductConfigError("TLS 证书路径 (certPath) 必须为非空字符串");
      }
      if (typeof patch.coordinator.tls.keyPath !== "string" || !patch.coordinator.tls.keyPath.trim()) {
        throw new ProductConfigError("TLS 私钥路径 (keyPath) 必须为非空字符串");
      }
    }
  }
  if (patch.security !== undefined) keys(patch.security, ["filesystem", "network", "approval", "confirmFullAccess"], "安全策略");
  if (patch.worker !== undefined) keys(patch.worker, ["coordinatorUrl", "name", "workspace", "inheritModels"], "Worker 配置");
  if (patch.models !== undefined) keys(patch.models, ["main", "security"], "模型配置");
  if (patch.nodeOverrides !== undefined) { keys(patch.nodeOverrides, patch.nodeOverrides ? Object.keys(patch.nodeOverrides) : [], "节点配置"); for (const override of Object.values(patch.nodeOverrides)) keys(override, ["main", "security"], "节点模型覆盖"); }
}
export class ProductStore {
  readonly homeDir: string;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  constructor(options: { homeDir?: string } = {}) {
    this.homeDir = path.resolve(options.homeDir ?? productHome());
    fs.mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(this.homeDir, "master.key"), dbFile = path.join(this.homeDir, "product.db");
    if (!fs.existsSync(keyFile)) {
      if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0) throw new ProductConfigError("配置密钥缺失，请从备份恢复 master.key", "KEY_MISSING");
      try { fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new ProductConfigError("配置密钥格式无效", "KEY_INVALID");
    this.db = new DatabaseSync(dbFile);
    fs.chmodSync(dbFile, 0o600);
    fs.chmodSync(keyFile, 0o600);
    const hasMeta = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_meta'").get();
    const existingSchema = hasMeta ? this.db.prepare("SELECT value FROM product_meta WHERE key='schema'").get() as { value: string } | undefined : undefined;
    if (existingSchema && existingSchema.value !== "1") { this.db.close(); throw new ProductConfigError("数据库版本比当前程序新，拒绝降级", "SCHEMA_TOO_NEW"); }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS product_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_configs (version INTEGER PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS product_secrets (id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_users (user_id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, credential_version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS product_invites (code TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS product_run_configs (run_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS product_model_checks (fingerprint TEXT PRIMARY KEY, passed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS product_security_apply (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS product_security_apply_retry (version INTEGER PRIMARY KEY, attempts INTEGER NOT NULL, state TEXT NOT NULL, next_retry_at INTEGER, error_code TEXT NOT NULL);`);
    const schema = this.db.prepare("SELECT value FROM product_meta WHERE key='schema'").get() as { value: string } | undefined;
    if (schema && schema.value !== "1") { this.db.close(); throw new ProductConfigError("数据库版本比当前程序新，拒绝降级", "SCHEMA_TOO_NEW"); }
    this.db.prepare("INSERT OR IGNORE INTO product_meta VALUES ('schema','1')").run();
  }
  close(): void { this.db.close(); }
  isInitialized(): boolean { return Boolean(this.db.prepare("SELECT value FROM product_meta WHERE key='active'").get()); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private secret(value: string): string {
    const id = randomUUID(), nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.db.prepare("INSERT INTO product_secrets VALUES (?,?)").run(id, Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64"));
    return id;
  }
  private readSecret(id?: string): string {
    if (!id) return "";
    const row = this.db.prepare("SELECT ciphertext FROM product_secrets WHERE id=?").get(id) as { ciphertext: string } | undefined;
    if (!row) throw new ProductConfigError("加密凭据缺失", "SECRET_MISSING");
    try { const data = Buffer.from(row.ciphertext, "base64"), decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"); }
    catch { throw new ProductConfigError("无法解密凭据，请恢复匹配的配置与密钥备份", "SECRET_INVALID"); }
  }
  private config(version?: number): StoredConfig {
    const active = this.db.prepare("SELECT value FROM product_meta WHERE key='active'").get() as { value: string } | undefined;
    if (!active) throw new ProductConfigError("尚未初始化，请运行 nash init", "NOT_INITIALIZED");
    const row = this.db.prepare("SELECT version,value FROM product_configs WHERE version=?").get(version ?? Number(active.value)) as { version: number; value: string } | undefined;
    if (!row) throw new ProductConfigError("配置版本不存在", "VERSION_MISSING");
    // Historical releases could persist a stale version inside the JSON payload.
    // The row key is the durable identity used by active pointers and run snapshots.
    return { ...JSON.parse(row.value), version: row.version };
  }
  private profile(input: ModelProfileInput, previous?: StoredProfile): StoredProfile {
    keys(input, ["id", "baseUrl", "model", "apiKey", "format", "timeoutMs", "streaming", "toolCalling"], "模型档案");
    if (!input || typeof input.baseUrl !== "string" || typeof input.model !== "string" || !input.model.trim() || input.model.length > 256) throw new ProductConfigError("请输入有效的模型名称与服务地址");
    let url: URL;
    try { url = new URL(input.baseUrl); } catch { throw new ProductConfigError("模型地址不是有效 URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProductConfigError("模型地址必须为不含凭据、查询参数的 HTTP(S) URL");
    if (!["completions", "responses", "messages"].includes(input.format)) throw new ProductConfigError("请选择有效的模型协议");
    if ((input.id !== undefined && (typeof input.id !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.id))) || [input.streaming, input.toolCalling].some(value => value !== undefined && typeof value !== "boolean")) throw new ProductConfigError("模型标识与能力开关格式无效");
    const timeoutMs = input.timeoutMs ?? previous?.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new ProductConfigError("模型超时应在 1–600 秒之间");
    const apiKey = input.apiKey;
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length < 1 || apiKey.length > 16384)) throw new ProductConfigError("模型凭据不能为空或过长");
    if (!apiKey && previous && previous.baseUrl.replace(/\/+$/, "") !== input.baseUrl.replace(/\/+$/, "")) throw new ProductConfigError("更换模型 Provider 时必须重新输入 API Key");
    const secretId = apiKey ? this.secret(apiKey) : previous?.secretId;
    if (!secretId) throw new ProductConfigError("请为模型配置 API Key");
    return { id: input.id ?? previous?.id ?? randomUUID(), baseUrl: input.baseUrl.replace(/\/+$/, ""), model: input.model.trim(), format: input.format, timeoutMs, streaming: input.streaming ?? previous?.streaming ?? true, toolCalling: input.toolCalling ?? previous?.toolCalling ?? true, secretId };
  }
  private securityBinding(binding: SecurityModelBinding | undefined, previous?: StoredSecurity): StoredSecurity {
    if (binding) keys(binding, ["mode", ...(binding.mode === "independent" ? ["profile"] : binding.mode === "same-provider" ? ["model"] : [])], "安全模型配置");
    const value = binding ?? previous ?? { mode: "follow-main" };
    if (value.mode === "independent") return { mode: "independent", profile: this.profile(value.profile, previous?.mode === "independent" ? previous.profile : undefined) };
    if (value.mode === "same-provider") {
      if (typeof value.model !== "string" || !value.model.trim()) throw new ProductConfigError("请输入安全模型名称");
      return { mode: "same-provider", model: value.model.trim() };
    }
    if (!["follow-main", "coordinator"].includes(value.mode)) throw new ProductConfigError("安全模型继承方式无效");
    return { mode: value.mode };
  }
  private validate(input: ProductInitInput | StoredConfig): void {
    if (!["coordinator", "worker", "coordinator-worker"].includes(input.role)) throw new ProductConfigError("节点角色无效");
    if (!input.coordinator || typeof input.coordinator.listenHost !== "string" || !input.coordinator.listenHost.trim() || !Number.isSafeInteger(input.coordinator.listenPort) || input.coordinator.listenPort < 1 || input.coordinator.listenPort > 65535) throw new ProductConfigError("Coordinator 监听地址或端口无效");
    if (!["read-only", "workspace-write", "full-capability", "danger-full-access"].includes(input.security?.filesystem) || !["allow", "deny"].includes(input.security?.network) || !["ask", "never", "auto-grant"].includes(input.security?.approval)) throw new ProductConfigError("安全策略无效");
    if (input.security.filesystem === "danger-full-access" && input.security.confirmFullAccess !== true) throw new ProductConfigError("完全访问需要用户明确确认", "FULL_ACCESS_CONFIRMATION_REQUIRED");
    if (input.security.confirmFullAccess !== undefined && typeof input.security.confirmFullAccess !== "boolean") throw new ProductConfigError("完全访问确认格式无效");
    if (input.worker) {
      if ([input.worker.name, input.worker.workspace].some(value => value !== undefined && (typeof value !== "string" || value.length > 4096)) || (input.worker.inheritModels !== undefined && typeof input.worker.inheritModels !== "boolean")) throw new ProductConfigError("Worker 配置字段格式无效");
    }
    for (const value of [input.coordinator.publicUrl, input.worker?.coordinatorUrl].filter(Boolean)) {
      let url: URL; try { url = new URL(value!); } catch { throw new ProductConfigError("Coordinator 地址无效"); }
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProductConfigError("Coordinator 地址不得包含凭据或查询参数");
    }
    if (input.role === "worker" && !input.worker?.coordinatorUrl) throw new ProductConfigError("Worker 需要 Coordinator 地址");
  }
  initialize(input: ProductInitInput): ProductPublicConfig {
    return this.transaction(() => {
      keys(input, ["role", "coordinator", "models", "security", "admin", "worker"], "初始化配置");
      const { admin: _admin, ...patch } = input; validateProductPatch(patch);
      if (input.admin) keys(input.admin, ["username", "password"], "管理员配置");
      if (this.isInitialized()) throw new ProductConfigError("已存在有效配置，请使用配置修改或升级流程", "ALREADY_INITIALIZED");
      this.validate(input);
      if (input.role !== "worker" && (!input.admin || !input.models.main)) throw new ProductConfigError("Coordinator 需要主模型与管理员");
      const { coordinator } = input;
      const { databaseUrl, ...coord } = coordinator;
      if (databaseUrl) { let url: URL; try { url = new URL(databaseUrl); } catch { throw new ProductConfigError("数据库地址无效"); } if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new ProductConfigError("仅支持 PostgreSQL 数据库地址"); }
      const stored: StoredConfig = { role: input.role, security: input.security, worker: input.worker, coordinator: { ...coord, databaseSecretId: databaseUrl ? this.secret(databaseUrl) : undefined }, models: { main: input.models.main ? this.profile(input.models.main) : undefined, security: this.securityBinding(input.models.security ?? (input.role === "worker" ? { mode: "coordinator" } : undefined)) }, version: 1, createdAt: Date.now(), nodeOverrides: {} };
      if (input.admin) this.insertUser(input.admin.username, input.admin.password, "admin");
      this.save(stored);
      return this.publicConfig(stored);
    });
  }
  validateInitialization(input: ProductInitInput): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      keys(input, ["role", "coordinator", "models", "security", "admin", "worker"], "初始化配置");
      const { admin: _admin, ...patch } = input; validateProductPatch(patch);
      if (input.admin) keys(input.admin, ["username", "password"], "管理员配置");
      if (this.isInitialized()) throw new ProductConfigError("已存在有效配置", "ALREADY_INITIALIZED");
      this.validate(input);
      if (input.role !== "worker" && (!input.admin || !input.models?.main)) throw new ProductConfigError("Coordinator 需要主模型与管理员");
      if (input.models?.main) this.profile(input.models.main);
      this.securityBinding(input.models?.security);
      if (input.admin) this.insertUser(input.admin.username, input.admin.password, "admin");
      if (input.coordinator.databaseUrl) { try { if (!["postgres:", "postgresql:"].includes(new URL(input.coordinator.databaseUrl).protocol)) throw new Error(); } catch { throw new ProductConfigError("数据库地址无效"); } }
    } finally { this.db.exec("ROLLBACK"); }
  }
  private save(config: StoredConfig): void {
    this.db.prepare("INSERT INTO product_configs VALUES (?,?,?)").run(config.version, JSON.stringify(config), Date.now());
    this.db.prepare("INSERT OR REPLACE INTO product_meta VALUES ('active',?)").run(String(config.version));
  }
  getPublicConfig(): ProductPublicConfig { return this.publicConfig(this.config()); }
  previewModel(input: ModelProfileInput, purpose: "main" | "security" = "main", nodeId?: string): ResolvedModel {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const config = this.isInitialized() ? this.config() : undefined;
      const selected = nodeId ? config?.nodeOverrides[nodeId] : config?.models;
      const previous = purpose === "main" ? selected?.main : selected?.security?.mode === "independent" ? selected.security.profile : selected?.main;
      const profile = this.profile(input, previous);
      return { baseUrl: profile.baseUrl, model: profile.model, apiKey: this.readSecret(profile.secretId), format: profile.format, timeoutMs: profile.timeoutMs ?? 120000, streaming: profile.streaming ?? true, toolCalling: profile.toolCalling ?? true, configurationVersion: config?.version ?? 0, contextWindow: 64000, compactionThreshold: 0.8 };
    } finally { this.db.exec("ROLLBACK"); }
  }
  bindRunConfiguration(runId: string, nodeId: string, taskId: string): number {
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM product_run_configs WHERE run_id=?").get(runId) as { node_id: string; task_id: string; version: number } | undefined;
      if (previous) { if (previous.node_id !== nodeId || previous.task_id !== taskId) throw new ProductConfigError("运行配置归属冲突", "RUN_MISMATCH"); return previous.version; }
      const version = this.config().version;
      this.db.prepare("INSERT INTO product_run_configs VALUES (?,?,?,?)").run(runId, nodeId, taskId, version);
      return version;
    });
  }
  private publicProfile(profile?: StoredProfile) { if (!profile) return undefined; const { secretId, ...rest } = profile; return { ...rest, apiKeyConfigured: Boolean(secretId) }; }
  private publicBinding(binding: StoredSecurity): ProductPublicConfig["models"]["security"] { return binding.mode === "independent" ? { mode: "independent", profile: this.publicProfile(binding.profile)! } : binding; }
  private publicConfig(config: StoredConfig): ProductPublicConfig {
    const { databaseSecretId, ...coord } = config.coordinator;
    return { ...config, coordinator: { ...coord, databaseConfigured: Boolean(databaseSecretId) }, models: { main: this.publicProfile(config.models.main), security: this.publicBinding(config.models.security) }, nodeOverrides: Object.fromEntries(Object.entries(config.nodeOverrides).map(([id, override]) => [id, { main: this.publicProfile(override.main), security: override.security ? this.publicBinding(override.security) : undefined }])) };
  }
  getCoordinatorRuntime(): ProductInitInput["coordinator"] { const config = this.config(); const { databaseSecretId, ...rest } = config.coordinator; return { ...rest, databaseUrl: databaseSecretId ? this.readSecret(databaseSecretId) : undefined }; }
  updateConfig(patch: ProductConfigUpdate, options: { expectedVersion: number }): ProductPublicConfig {
    return this.transaction(() => {
      validateProductPatch(patch);
      const old = this.config();
      if (old.version !== options.expectedVersion) throw new ProductConfigError("配置已被其他操作修改，请刷新", "VERSION_CONFLICT");
      const next = structuredClone(old);
      if (patch.role !== undefined && patch.role !== old.role) throw new ProductConfigError("修改节点角色需要独立迁移流程");
      if (patch.coordinator) {
        const { databaseUrl, ...coord } = patch.coordinator;
        next.coordinator = { ...next.coordinator, ...coord };
        if (databaseUrl !== undefined) { try { if (!["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) throw new Error(); } catch { throw new ProductConfigError("数据库地址无效"); } next.coordinator.databaseSecretId = this.secret(databaseUrl); }
      }
      if (patch.worker) next.worker = { ...next.worker, ...patch.worker };
      if (patch.security) next.security = { ...patch.security };
      if (patch.models?.main) next.models.main = this.profile(patch.models.main, old.models.main);
      if (patch.models?.security) next.models.security = this.securityBinding(patch.models.security, old.models.security);
      if (patch.nodeOverrides) for (const [id, value] of Object.entries(patch.nodeOverrides)) {
        if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id) || Object.hasOwn(Object.prototype, id)) throw new ProductConfigError("节点 ID 无效");
        next.nodeOverrides[id] = { main: value.main ? this.profile(value.main, old.nodeOverrides[id]?.main) : undefined, security: value.security ? this.securityBinding(value.security, old.nodeOverrides[id]?.security) : undefined };
      }
      this.validate(next);
      next.version = old.version + 1;
      this.save(next);
      if (securityTightened(old.security, next.security) || (securityChanged(old.security, next.security) && this.pendingSecurityApply())) { this.db.prepare("DELETE FROM product_security_apply_retry").run(); this.db.prepare("INSERT OR REPLACE INTO product_security_apply VALUES (1,?,?)").run(next.version, Date.now()); }
      return this.publicConfig(next);
    });
  }
  rollback(version: number, expectedVersion: number, options?: { confirmFullAccess?: boolean }): ProductPublicConfig {
    return this.transaction(() => {
      const current = this.config();
      if (current.version !== expectedVersion) throw new ProductConfigError("配置版本冲突", "VERSION_CONFLICT");
      const previous = this.config(version);
      if (previous.security.filesystem === "danger-full-access" && current.security.filesystem !== "danger-full-access" && options?.confirmFullAccess !== true) throw new ProductConfigError("回滚目标为完全访问，请先明确确认风险", "FULL_ACCESS_CONFIRMATION_REQUIRED");
      previous.version = current.version + 1; this.save(previous);
      if (securityTightened(current.security, previous.security) || (securityChanged(current.security, previous.security) && this.pendingSecurityApply())) { this.db.prepare("DELETE FROM product_security_apply_retry").run(); this.db.prepare("INSERT OR REPLACE INTO product_security_apply VALUES (1,?,?)").run(previous.version, Date.now()); }
      return this.publicConfig(previous);
    });
  }
  listVersions(): Array<{ version: number; createdAt: number }> { return this.db.prepare("SELECT version,created_at AS createdAt FROM product_configs ORDER BY version DESC LIMIT 100").all() as unknown as Array<{ version: number; createdAt: number }>; }
  pendingSecurityApply(): { version: number; updatedAt: number; attempts?: number; state?: "waiting_retry" | "blocked"; nextRetryAt?: number | null; errorCode?: string } | undefined {
    return this.db.prepare("SELECT p.version,p.updated_at AS updatedAt,r.attempts,r.state,r.next_retry_at AS nextRetryAt,r.error_code AS errorCode FROM product_security_apply p LEFT JOIN product_security_apply_retry r ON r.version=p.version WHERE p.id=1").get() as any;
  }
  recordSecurityApplyFailure(version: number, state: "waiting_retry" | "blocked", nextRetryAt: number | null, errorCode: string): void {
    this.db.prepare(`INSERT INTO product_security_apply_retry(version,attempts,state,next_retry_at,error_code)
      SELECT ?,1,?,?,? WHERE EXISTS (SELECT 1 FROM product_security_apply WHERE id=1 AND version=?)
      ON CONFLICT(version) DO UPDATE SET attempts=attempts+1,state=excluded.state,next_retry_at=excluded.next_retry_at,error_code=excluded.error_code`).run(version, state, nextRetryAt, errorCode, version);
  }
  completeSecurityApply(version: number): boolean { return this.transaction(() => { const removed = this.db.prepare("DELETE FROM product_security_apply WHERE id=1 AND version=?").run(version).changes === 1; if (removed) this.db.prepare("DELETE FROM product_security_apply_retry WHERE version=?").run(version); return removed; }); }
  resolveModel(options: { nodeId?: string; purpose: "main" | "security"; version?: number } = { purpose: "main" }): ResolvedModel {
    const config = this.config(options.version), override = options.nodeId ? config.nodeOverrides[options.nodeId] : undefined;
    const main = override?.main ?? config.models.main;
    let profile = main;
    if (options.purpose === "security") {
      const binding = override?.security ?? config.models.security;
      if (binding.mode === "independent") profile = binding.profile;
      else if (binding.mode === "same-provider") profile = main ? { ...main, model: binding.model } : undefined;
      else if (binding.mode === "coordinator") {
        const parent = config.models.security;
        profile = parent.mode === "independent" ? parent.profile : parent.mode === "same-provider" && config.models.main ? { ...config.models.main, model: parent.model } : config.models.main;
      }
    }
    if (!profile) throw new ProductConfigError("该节点使用 Coordinator 模型网关，不能读取本地 Provider 凭据", "GATEWAY_REQUIRED");
    const { secretId, ...rest } = profile;
    return { ...rest, apiKey: this.readSecret(secretId), contextWindow: 64000, compactionThreshold: 0.8, timeoutMs: rest.timeoutMs ?? 120000, streaming: rest.streaming ?? true, toolCalling: rest.toolCalling ?? true, configurationVersion: config.version };
  }
  private insertUser(username: string, password: string, role: "admin" | "viewer"): ProductUser {
    if (typeof username !== "string" || !/^[\p{L}\p{N}_.@-]{1,64}$/u.test(username) || typeof password !== "string" || password.length < 12 || password.length > 1024) throw new ProductConfigError("用户名应为 1–64 个合法字符，密码至少 12 个字符");
    const userId = `usr-${randomUUID()}`, salt = randomBytes(16).toString("hex"), hash = scryptSync(password, salt, 64).toString("hex");
    this.db.prepare("INSERT INTO product_users VALUES (?,?,?,?,?,1)").run(userId, username, salt, hash, role);
    return { userId, username, role, credentialVersion: 1 };
  }
  createAdmin(username: string, password: string): ProductUser { return this.transaction(() => this.insertUser(username, password, "admin")); }
  listUsers(): ProductUser[] { return this.db.prepare("SELECT user_id AS userId, username, role, credential_version AS credentialVersion FROM product_users").all() as unknown as ProductUser[]; }
  authenticate(username: string, password: string): ProductUser | undefined {
    const row = this.db.prepare("SELECT * FROM product_users WHERE username=?").get(username) as { user_id: string; username: string; salt: string; password_hash: string; role: "admin" | "viewer"; credential_version: number } | undefined;
    const candidate = scryptSync(password.slice(0, 1024), row?.salt ?? "00000000000000000000000000000000", 64);
    if (!row || password.length > 1024 || !timingSafeEqual(candidate, Buffer.from(row.password_hash, "hex"))) return undefined;
    return { userId: row.user_id, username: row.username, role: row.role, credentialVersion: row.credential_version };
  }
  changePassword(userId: string, password: string): void {
    if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new ProductConfigError("密码至少 12 个字符");
    const salt = randomBytes(16).toString("hex"), hash = scryptSync(password, salt, 64).toString("hex");
    const result = this.db.prepare("UPDATE product_users SET salt=?,password_hash=?,credential_version=credential_version+1 WHERE user_id=?").run(salt, hash, userId);
    if (!result.changes) throw new ProductConfigError("用户不存在");
  }
  getUser(userId: string): ProductUser | undefined { return this.listUsers().find(user => user.userId === userId); }
  saveInvite(code: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO product_invites VALUES (?,?)").run(createHash("sha256").update(code).digest("hex"), this.secret(JSON.stringify(value))); }
  loadInvites(): unknown[] { return this.db.prepare("SELECT value FROM product_invites").all().map(row => JSON.parse(this.readSecret(String(row.value)))); }
  consumeInvite<T>(code: string, update: (value: T | undefined) => T): T { return this.transaction(() => { const row = this.db.prepare("SELECT value FROM product_invites WHERE code=?").get(createHash("sha256").update(code).digest("hex")) as { value: string } | undefined; const value = update(row ? JSON.parse(this.readSecret(row.value)) : undefined); this.saveInvite(code, value); return value; }); }
}
