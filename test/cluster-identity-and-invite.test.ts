import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NodeIdentity, NodeIdentityPersistenceError } from "../src/cluster/identity/node-identity.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";

describe("Nash Cluster Node Identity & Invite System", () => {
  it("拒绝悬空身份符号链接并保留原文件", { skip: process.platform === "win32" }, t => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-node-test-"));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const identityFile = path.join(tmpDir, "cluster-identity.json");
    fs.symlinkSync(path.join(tmpDir, "missing"), identityFile);
    assert.throws(() => new NodeIdentity({ customDir: tmpDir }), NodeIdentityPersistenceError);
    assert.equal(fs.lstatSync(identityFile).isSymbolicLink(), true);
  });
  it("应能生成并持久化唯一稳定 Node ID", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-node-test-"));
    try {
      const id1 = new NodeIdentity({ customDir: tmpDir });
      const firstId = id1.nodeId;
      assert.ok(firstId.startsWith("node-"));

      // 再次创建时应复用同一 Node ID
      const id2 = new NodeIdentity({ customDir: tmpDir });
      assert.equal(id2.nodeId, firstId);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("应支持配置和持久化 Node Token 与 Coordinator URL", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nash-node-test-"));
    try {
      const identity = new NodeIdentity({ customDir: tmpDir });
      const token = NodeIdentity.generateSecureToken();
      identity.setNodeToken(token);
      identity.setCoordinatorUrl("wss://cluster.example.com/ws/cluster");

      const reloaded = new NodeIdentity({ customDir: tmpDir });
      assert.equal(reloaded.nodeToken, token);
      assert.equal(reloaded.coordinatorUrl, "wss://cluster.example.com/ws/cluster");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("InviteManager 应支持创建、消费、单次限制与过期判定", () => {
    const manager = new InviteManager();

    // 1. 创建普通邀请码
    const inv1 = manager.createInvite({ role: "worker", maxUses: 1, ttlMs: 60000 });
    assert.ok(inv1.inviteCode.startsWith("nash-inv-"));

    // 首次消费成功
    const res1 = manager.verifyAndConsume(inv1.inviteCode);
    assert.equal(res1.valid, true);
    assert.equal(res1.role, "worker");

    // 再次消费应被拒绝（超额）
    const res2 = manager.verifyAndConsume(inv1.inviteCode);
    assert.equal(res2.valid, false);
    assert.equal(res2.reason, "Invite code maximum uses exceeded");

    // 2. 测试过期邀请码
    const expiredInv = manager.createInvite({ role: "worker", ttlMs: -1000 });
    const resExpired = manager.verifyAndConsume(expiredInv.inviteCode);
    assert.equal(resExpired.valid, false);
    assert.equal(resExpired.reason, "Invite code has expired");

    // 3. 测试撤销邀请码
    const activeInv = manager.createInvite({ role: "worker", ttlMs: 60000 });
    manager.revokeInvite(activeInv.inviteCode);
    const resRevoked = manager.verifyAndConsume(activeInv.inviteCode);
    assert.equal(resRevoked.valid, false);
    assert.equal(resRevoked.reason, "Invite code has been revoked");
  });
});
