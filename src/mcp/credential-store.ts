import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolveNashHome } from "../config/data-home.js";

export interface StoredCredential {
  serverName: string;
  type: "bearer" | "oauth" | "custom";
  token?: string;
  oauth?: {
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    tokenType?: string;
  };
  headers?: Record<string, string>;
  updatedAt: number;
}

export interface CredentialStoreOptions {
  homeDir?: string;
  nashHome?: string;
  storagePath?: string;
  useKeychain?: boolean;
  keychainService?: string;
}

const DEFAULT_KEYCHAIN_SERVICE = "nash-agents-mcp-credentials";
const LEGACY_KEYCHAIN_SERVICES = ["nash-mcp-credentials"];

/**
 * 安全凭据存储中心 (CredentialStore) - 支持 macOS Keychain 与 AES-256-GCM 本地加密
 */
export class CredentialStore {
  private readonly storagePath: string;
  private readonly memoryCache = new Map<string, StoredCredential>();
  private readonly refMap = new Map<string, string>(); // credentialRef -> serverName
  private readonly tombstones = new Set<string>(); // 记录已显式删除的凭据，防止从旧命名空间自动回流
  private globalLegacyCleared = false; // 记录是否执行过全部清除，阻断任何未重新录入的旧命名空间回流
  private readonly migratedServices = new Set<string>(); // 跟踪从 Legacy 迁移到新命名空间的服务名
  private initialized = false;
  private readonly useKeychain: boolean;
  private readonly keychainService: string;

  constructor(options?: CredentialStoreOptions) {
    const home = options?.homeDir ?? os.homedir();
    this.storagePath =
      options?.storagePath ?? path.join(options?.nashHome ?? (options?.homeDir ? path.join(home, ".nash") : resolveNashHome()), "credentials.enc.json");
    this.useKeychain = options?.useKeychain ?? (process.platform === "darwin");
    this.keychainService = options?.keychainService ?? DEFAULT_KEYCHAIN_SERVICE;
  }

  /**
   * 从 macOS Keychain 读取指定 Server 的凭证（优先读取新命名空间，支持 Legacy 平滑迁移）
   */
  private readFromKeychain(serverName: string): string | null {
    if (process.platform !== "darwin") return null;
    try {
      const stdout = execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", serverName, "-s", this.keychainService, "-w"],
        { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
      );
      const secret = stdout.trim();
      if (secret) return secret;
    } catch {}

    if (this.keychainService === DEFAULT_KEYCHAIN_SERVICE) {
      if (this.globalLegacyCleared || this.tombstones.has(serverName)) {
        return null;
      }
      for (const legacyService of LEGACY_KEYCHAIN_SERVICES) {
        try {
          const stdout = execFileSync(
            "/usr/bin/security",
            ["find-generic-password", "-a", serverName, "-s", legacyService, "-w"],
            { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
          );
          const secret = stdout.trim();
          if (secret) {
            // 平滑迁移：写入当前正式服务名，并记录已迁移服务
            this.writeToKeychain(serverName, secret);
            this.migratedServices.add(serverName);
            this.persist();
            return secret;
          }
        } catch {}
      }
    }
    return null;
  }

  /**
   * 向 macOS Keychain 写入凭据
   */
  private writeToKeychain(serverName: string, secretValue: string): boolean {
    if (process.platform !== "darwin") return false;
    try {
      execFileSync(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-a",
          serverName,
          "-s",
          this.keychainService,
          "-w",
          secretValue,
          "-U", // 若存在则更新
        ],
        { stdio: ["pipe", "pipe", "ignore"] }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 从 macOS Keychain 删除凭据（仅删除当前产品的凭据命名空间，绝不影响旧产品）
   */
  private deleteFromKeychain(serverName: string): void {
    if (process.platform !== "darwin") return;
    try {
      execFileSync(
        "/usr/bin/security",
        ["delete-generic-password", "-a", serverName, "-s", this.keychainService],
        { stdio: ["pipe", "pipe", "ignore"] }
      );
    } catch {}
  }

  /**
   * 基于机器特征与用户环境派生本地加密主密钥
   */
  private deriveMasterKey(): Buffer {
    const seed = `${os.hostname()}:${os.userInfo().username}:nash-agent-credential-seed`;
    return crypto.createHash("sha256").update(seed).digest();
  }

  /**
   * AES-256-GCM 加密
   */
  private encrypt(text: string): { iv: string; tag: string; data: string } {
    const key = this.deriveMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(text, "utf-8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return {
      iv: iv.toString("hex"),
      tag,
      data: encrypted,
    };
  }

  /**
   * AES-256-GCM 解密
   */
  private decrypt(payload: { iv: string; tag: string; data: string }): string {
    const key = this.deriveMasterKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
    let decrypted = decipher.update(payload.data, "hex", "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  }

  private ensureLoaded(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, "utf-8");
        const payload = JSON.parse(raw);
        if (payload.iv && payload.tag && payload.data) {
          const decryptedJson = this.decrypt(payload);
          const parsed = JSON.parse(decryptedJson);
          if (parsed && typeof parsed === "object") {
            const creds = parsed.credentials && typeof parsed.credentials === "object" ? parsed.credentials : parsed;
            for (const [k, v] of Object.entries(creds)) {
              if (k !== "tombstones" && v && typeof v === "object") {
                this.memoryCache.set(k, v as StoredCredential);
              }
            }
            if (Array.isArray(parsed.tombstones)) {
              for (const t of parsed.tombstones) {
                if (typeof t === "string") this.tombstones.add(t);
              }
            }
            if (parsed.globalLegacyCleared === true) {
              this.globalLegacyCleared = true;
            }
            if (Array.isArray(parsed.migratedServices)) {
              for (const s of parsed.migratedServices) {
                if (typeof s === "string") this.migratedServices.add(s);
              }
            }
          }
        }
      }
    } catch {}
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const obj: Record<string, StoredCredential> = {};
    for (const [k, v] of this.memoryCache.entries()) {
      obj[k] = v;
    }

    const storePayload = {
      credentials: obj,
      tombstones: Array.from(this.tombstones),
      globalLegacyCleared: this.globalLegacyCleared,
      migratedServices: Array.from(this.migratedServices),
    };

    const encrypted = this.encrypt(JSON.stringify(storePayload));
    const tempFile = `${this.storagePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tempFile, JSON.stringify(encrypted, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tempFile, this.storagePath);
  }

  /**
   * 检查是否已执行过全量凭据清除（彻底阻断任何旧命名空间凭据自动回流）
   */
  public isLegacyCleared(): boolean {
    this.ensureLoaded();
    return this.globalLegacyCleared;
  }

  /**
   * 检查指定服务是否处于已删除墓碑状态（防止从 Legacy 命名空间自动回流）
   */
  public isTombstoned(serverName: string): boolean {
    this.ensureLoaded();
    return this.tombstones.has(serverName);
  }

  /**
   * 获取指定服务的凭据信息
   */
  public getCredential(serverName: string): StoredCredential | undefined {
    this.ensureLoaded();

    // 优先尝试读取 macOS Keychain
    if (this.useKeychain) {
      const keychainSecret = this.readFromKeychain(serverName);
      if (keychainSecret) {
        let cred: StoredCredential;
        try {
          const parsed = JSON.parse(keychainSecret);
          cred = parsed as StoredCredential;
        } catch {
          cred = {
            serverName,
            type: "bearer",
            token: keychainSecret,
            updatedAt: Date.now(),
          };
        }
        this.memoryCache.set(serverName, cred);
        return cred;
      }
    }

    return this.memoryCache.get(serverName);
  }

  /**
   * 安全录入 Bearer Token，并生成不含密钥的凭据引用 (credentialRef)
   */
  public createBearerCredential(
    serverName: string,
    token: string
  ): { credentialRef: string } {
    this.ensureLoaded();

    const cred: StoredCredential = {
      serverName,
      type: "bearer",
      token,
      updatedAt: Date.now(),
    };

    if (this.useKeychain) {
      this.writeToKeychain(serverName, JSON.stringify(cred));
    }
    this.tombstones.delete(serverName);
    this.memoryCache.set(serverName, cred);
    this.persist();

    // 生成不含密钥的随机凭据句柄，供 LLM 引用
    const ref = `cred_ref_${crypto.randomBytes(8).toString("hex")}`;
    this.refMap.set(ref, serverName);

    return { credentialRef: ref };
  }

  /**
   * 设置 Bearer Token
   */
  public setBearerToken(serverName: string, token: string): void {
    this.createBearerCredential(serverName, token);
  }

  /**
   * 通过 credentialRef 校验或绑定
   */
  public resolveCredentialRef(ref: string): string | undefined {
    return this.refMap.get(ref);
  }

  /**
   * 设置 OAuth 凭据
   */
  public setOAuthCredential(
    serverName: string,
    oauthData: NonNullable<StoredCredential["oauth"]>
  ): void {
    this.ensureLoaded();
    const existing = this.getCredential(serverName);
    const cred: StoredCredential = {
      serverName,
      type: "oauth",
      oauth: {
        ...existing?.oauth,
        ...oauthData,
      },
      updatedAt: Date.now(),
    };

    if (this.useKeychain) {
      this.writeToKeychain(serverName, JSON.stringify(cred));
    }
    this.tombstones.delete(serverName);
    this.memoryCache.set(serverName, cred);
    this.persist();
  }

  /**
   * 删除凭据
   */
  public removeCredential(serverName: string): boolean {
    this.ensureLoaded();
    if (this.useKeychain) {
      this.deleteFromKeychain(serverName);
    }
    this.tombstones.add(serverName);
    this.migratedServices.delete(serverName);
    const deleted = this.memoryCache.delete(serverName);
    this.persist();
    return deleted;
  }

  /**
   * 清除全部凭据（同时阻断所有未重新录入的旧命名空间凭据自动回流）
   */
  public clearAll(): void {
    this.ensureLoaded();
    const allKnown = new Set([
      ...this.memoryCache.keys(),
      ...this.migratedServices,
    ]);
    for (const k of allKnown) {
      if (this.useKeychain) {
        this.deleteFromKeychain(k);
      }
      this.tombstones.add(k);
    }
    this.globalLegacyCleared = true;
    this.memoryCache.clear();
    this.migratedServices.clear();
    this.refMap.clear();
    this.persist();
  }
}
