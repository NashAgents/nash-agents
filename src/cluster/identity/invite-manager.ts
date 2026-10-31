import * as crypto from "node:crypto";
import { NodeIdentity } from "./node-identity.js";
import type { ProductStore } from "../../product/store.js";

export interface InviteRecord {
  inviteCode: string;
  tokenHash: string;
  role: "worker" | "coordinator-worker";
  maxUses: number;
  usesCount: number;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number;
}

export class InviteManager {
  private readonly memoryInvites = new Map<string, InviteRecord>();
  constructor(private readonly persistence?: ProductStore) {}

  /**
   * 创建新的配对邀请码
   */
  createInvite(options?: {
    role?: "worker" | "coordinator-worker";
    ttlMs?: number;
    maxUses?: number;
  }): { inviteCode: string; expiresAt: number } {
    const rawCode = `nash-inv-${crypto.randomBytes(8).toString("hex")}`;
    const ttl = options?.ttlMs ?? 24 * 60 * 60 * 1000; // 默认 24h
    const expiresAt = Date.now() + ttl;
    const tokenHash = NodeIdentity.hashToken(rawCode);

    const record: InviteRecord = {
      inviteCode: rawCode,
      tokenHash,
      role: options?.role ?? "worker",
      maxUses: options?.maxUses ?? 1,
      usesCount: 0,
      expiresAt,
      createdAt: Date.now(),
    };

    if (this.persistence) this.persistence.saveInvite(rawCode, record);
    else this.memoryInvites.set(rawCode, record);
    return { inviteCode: rawCode, expiresAt };
  }

  /**
   * 验证并消费邀请码
   */
  verifyAndConsume(inviteCode: string): { valid: boolean; reason?: string; role?: "worker" | "coordinator-worker" } {
    if (this.persistence) {
      let result: ReturnType<InviteManager["verifyAndConsume"]> = { valid: false, reason: "Invalid invite code" };
      try { this.persistence.consumeInvite<InviteRecord>(inviteCode, record => { if (!record) throw new Error("Invite code does not exist"); result = this.consume(record); if (!result.valid) throw new Error(result.reason); return record; }); }
      catch (error) { return { valid: false, reason: (error as Error).message }; }
      return result;
    }
    const record = this.memoryInvites.get(inviteCode);
    if (!record) {
      return { valid: false, reason: "Invite code does not exist" };
    }

    return this.consume(record);
  }
  private consume(record: InviteRecord): { valid: boolean; reason?: string; role?: "worker" | "coordinator-worker" } {
    if (record.revokedAt) {
      return { valid: false, reason: "Invite code has been revoked" };
    }

    if (Date.now() > record.expiresAt) {
      return { valid: false, reason: "Invite code has expired" };
    }

    if (record.usesCount >= record.maxUses) {
      return { valid: false, reason: "Invite code maximum uses exceeded" };
    }

    record.usesCount += 1;
    return { valid: true, role: record.role };
  }

  /**
   * 撤销指定邀请码
   */
  revokeInvite(inviteCode: string): boolean {
    if (this.persistence) {
      try { this.persistence.consumeInvite<InviteRecord>(inviteCode, record => { if (!record) throw new Error("Invite not found"); return { ...record, revokedAt: Date.now() }; }); return true; } catch { return false; }
    }
    const record = this.memoryInvites.get(inviteCode);
    if (!record) return false;
    record.revokedAt = Date.now();
    return true;
  }

  /**
   * 列出所有当前有效的邀请码
   */
  listActiveInvites(): InviteRecord[] {
    const now = Date.now();
    return (this.persistence ? this.persistence.loadInvites() as InviteRecord[] : Array.from(this.memoryInvites.values())).filter(
      (inv) => !inv.revokedAt && inv.expiresAt > now && inv.usesCount < inv.maxUses
    );
  }
}
