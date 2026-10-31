import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/in-memory-cluster-store.js";
import { NodeRegistry } from "../src/cluster/coordinator/node-registry.js";
import { InviteManager } from "../src/cluster/identity/invite-manager.js";
import { NodeIdentity } from "../src/cluster/identity/node-identity.js";
import type { NodeHelloPayload } from "../src/cluster/protocol/types.js";

/**
 * 节点凭证轮换：保留 Node Identity，旧凭证立即失效，新凭证可认证。
 * 明文 Token 全程只存在于节点侧，协调器只接收 SHA-256。
 */

const OLD_TOKEN = "ntk_old-credential-for-rotation-test";
const NEW_TOKEN = "ntk_new-credential-for-rotation-test";
const NODE_ID = "node-rotation-fixture";

function hello(token: string): NodeHelloPayload {
  return {
    nodeId: NODE_ID,
    nodeToken: token,
    name: "fixture-worker",
    platform: "linux",
    arch: "x64",
    hostname: "fixture",
    nodeVersion: "24.0.0",
    nashVersion: "0.1.0",
    sandboxBackend: "linux-landlock",
    capabilities: [],
    maxConcurrentRuns: 1,
    projects: [],
  } as unknown as NodeHelloPayload;
}

function fakeWs() {
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    closed,
    ws: {
      readyState: 1,
      send: () => {},
      close: (code?: number, reason?: string) => { closed.push({ code, reason }); },
    } as any,
  };
}

async function setup() {
  const store = new InMemoryClusterStore();
  await store.saveNode({
    nodeId: NODE_ID,
    name: "fixture-worker",
    role: "worker",
    platform: "linux",
    arch: "x64",
    hostname: "fixture",
    tokenHash: NodeIdentity.hashToken(OLD_TOKEN),
    status: "online",
    lastSeenAt: Date.now(),
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  const registry = new NodeRegistry(store, new InviteManager());
  return { store, registry };
}

test("轮换后旧凭证失效、新凭证通过，Node Identity 与角色保持不变", async () => {
  const { store, registry } = await setup();
  const before = await store.getNode(NODE_ID);

  // 轮换前：旧凭证可认证。
  const first = fakeWs();
  const okBefore = await registry.authenticateNode(hello(OLD_TOKEN), first.ws);
  assert.equal(okBefore.success, true);

  const rotated = await registry.rotateNodeToken(NODE_ID, NodeIdentity.hashToken(NEW_TOKEN));
  assert.equal(rotated, true);
  // 当前连接必须被立即踢下线，防止用旧凭证继续工作。
  assert.equal(first.closed.length, 1);
  assert.equal(first.closed[0]!.code, 4003);

  // 旧凭证不再可用。
  const oldAttempt = fakeWs();
  const okOld = await registry.authenticateNode(hello(OLD_TOKEN), oldAttempt.ws);
  assert.equal(okOld.success, false);
  assert.match(okOld.reason ?? "", /Invalid node token/);

  // 新凭证明可用。
  const newAttempt = fakeWs();
  const okNew = await registry.authenticateNode(hello(NEW_TOKEN), newAttempt.ws);
  assert.equal(okNew.success, true);

  // 身份不被重建：nodeId / role / createdAt 全部保留。
  const after = await store.getNode(NODE_ID);
  assert.equal(after!.nodeId, before!.nodeId);
  assert.equal(after!.role, before!.role);
  assert.equal(after!.createdAt, before!.createdAt);
  assert.notEqual(after!.tokenHash, before!.tokenHash);
});

test("非法哈希与已撤销节点拒绝轮换", async () => {
  const { store, registry } = await setup();
  assert.equal(await registry.rotateNodeToken(NODE_ID, "not-a-hash"), false);
  assert.equal(await registry.rotateNodeToken(NODE_ID, "A".repeat(64)), false, "只接受小写十六进制");

  await store.updateNodeStatus(NODE_ID, "revoked");
  assert.equal(await registry.rotateNodeToken(NODE_ID, NodeIdentity.hashToken(NEW_TOKEN)), false);
});

test("未知节点轮换直接失败，不会凭空创建身份", async () => {
  const { registry } = await setup();
  assert.equal(await registry.rotateNodeToken("node-does-not-exist", NodeIdentity.hashToken(NEW_TOKEN)), false);
});
