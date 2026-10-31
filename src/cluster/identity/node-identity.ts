import { resolveNashHome } from "../../config/data-home.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as crypto from "node:crypto";

export interface StoredNodeIdentity {
  nodeId: string;
  name: string;
  role: "coordinator" | "worker" | "coordinator-worker";
  nodeToken?: string;
  coordinatorUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NodeIdentityOptions {
  customDir?: string;
  explicitNodeId?: string;
  name?: string;
  role?: "coordinator" | "worker" | "coordinator-worker";
}

export class NodeIdentityPersistenceError extends Error {
  constructor(message: string) { super(message); this.name = "NodeIdentityPersistenceError"; }
}

/**
 * NodeIdentity 管理本地节点的持久身份标识与安全凭证
 * 存储于 NASH_HOME/cluster-identity.json（默认 ~/.nash-agents，权限 0600）
 */
export class NodeIdentity {
  private readonly identityFilePath: string;
  private identity: StoredNodeIdentity;

  constructor(options?: NodeIdentityOptions) {
    const baseDir = options?.customDir ?? resolveNashHome();
    if (!fs.existsSync(baseDir)) {
      try { fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 }); }
      catch { throw new NodeIdentityPersistenceError("Cannot create node identity directory; registration was not saved"); }
    }

    this.identityFilePath = path.join(baseDir, "cluster-identity.json");
    this.identity = this.loadOrCreate(options);
  }

  get nodeId(): string {
    return this.identity.nodeId;
  }

  get name(): string {
    return this.identity.name;
  }

  get role(): "coordinator" | "worker" | "coordinator-worker" {
    return this.identity.role;
  }

  get nodeToken(): string | undefined {
    return this.identity.nodeToken;
  }

  get coordinatorUrl(): string | undefined {
    return this.identity.coordinatorUrl;
  }

  setCoordinatorUrl(url: string): void {
    this.identity.coordinatorUrl = url;
    this.identity.updatedAt = Date.now();
    this.save();
  }

  setNodeToken(token: string): void {
    this.identity.nodeToken = token;
    this.identity.updatedAt = Date.now();
    this.save();
  }

  setNodeId(nodeId: string): void {
    this.identity.nodeId = nodeId;
    this.identity.updatedAt = Date.now();
    this.save();
  }

  private loadOrCreate(options?: NodeIdentityOptions): StoredNodeIdentity {
    let identityExists = false;
    try { fs.lstatSync(this.identityFilePath); identityExists = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new NodeIdentityPersistenceError("Cannot inspect existing node identity; the original file was preserved");
    }
    if (identityExists) {
      try {
        if (!fs.lstatSync(this.identityFilePath).isFile() || fs.lstatSync(this.identityFilePath).isSymbolicLink()) throw new NodeIdentityPersistenceError("Node identity must be an ordinary file");
        const raw = fs.readFileSync(this.identityFilePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<StoredNodeIdentity>;
        if (typeof parsed.nodeId === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(parsed.nodeId) &&
            (parsed.nodeToken === undefined || typeof parsed.nodeToken === "string" && parsed.nodeToken.length > 0) &&
            (parsed.coordinatorUrl === undefined || typeof parsed.coordinatorUrl === "string")) {
          return {
            nodeId: options?.explicitNodeId ?? parsed.nodeId,
            name: options?.name ?? parsed.name ?? os.hostname(),
            role: options?.role ?? parsed.role ?? "worker",
            nodeToken: parsed.nodeToken,
            coordinatorUrl: parsed.coordinatorUrl,
            createdAt: parsed.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          };
        }
        throw new NodeIdentityPersistenceError("Existing node identity is invalid; restore its backup rather than re-registering silently");
      } catch (error) {
        if (error instanceof NodeIdentityPersistenceError) throw error;
        throw new NodeIdentityPersistenceError("Cannot read existing node identity; the original file was preserved");
      }
    }

    // 生成稳定 Node ID: 包含主机名简写与随机指纹
    const cleanHost = os.hostname().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 16) || "node";
    const randSuffix = crypto.randomBytes(4).toString("hex");
    const generatedId = options?.explicitNodeId ?? `node-${cleanHost}-${randSuffix}`;

    const newIdentity: StoredNodeIdentity = {
      nodeId: generatedId,
      name: options?.name ?? os.hostname(),
      role: options?.role ?? "worker",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const temporary = `${this.identityFilePath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(newIdentity, null, 2), { mode: 0o600, flag: "wx", flush: true });
      // An atomic no-replace publish prevents concurrent constructors from changing identity.
      try { fs.linkSync(temporary, this.identityFilePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.loadOrCreate(options); throw error; }
      return newIdentity;
    } catch (error) {
      if (error instanceof NodeIdentityPersistenceError) throw error;
      throw new NodeIdentityPersistenceError("Cannot persist node identity; registration was not completed");
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private save(): void {
    const temporary = `${this.identityFilePath}.${crypto.randomUUID()}.tmp`;
    try {
      if (fs.lstatSync(this.identityFilePath).isSymbolicLink()) throw new NodeIdentityPersistenceError("Node identity cannot be a symbolic link");
      fs.writeFileSync(temporary, JSON.stringify(this.identity, null, 2), { mode: 0o600, flag: "wx", flush: true });
      fs.renameSync(temporary, this.identityFilePath);
    } catch { throw new NodeIdentityPersistenceError("Cannot save node credentials; registration must not be reported as successful"); }
    finally { fs.rmSync(temporary, { force: true }); }
  }

  /**
   * 哈希计算 Token (SHA-256)，Coordinator 只存储 Token Hash，不存明文
   */
  static hashToken(token: string): string {
    return crypto.createHash("sha256").update(token, "utf-8").digest("hex");
  }

  /**
   * 生成全新的加密安全 Node Token
   */
  static generateSecureToken(): string {
    return `ntk_${crypto.randomBytes(24).toString("base64url")}`;
  }
}
