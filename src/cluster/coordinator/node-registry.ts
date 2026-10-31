import type { WebSocket } from "ws";
import type { IClusterStore, ClusterNodeRecord } from "../storage/cluster-store.js";
import { NodeIdentity } from "../identity/node-identity.js";
import { InviteManager } from "../identity/invite-manager.js";
import type { NodeHelloPayload, NodeMetadata } from "../protocol/types.js";

export interface ActiveNodeConnection {
  nodeId: string;
  generation: number;
  ws: WebSocket;
  remoteIp?: string;
  connectedAt: number;
  lastHeartbeatAt: number;
  metadata: NodeMetadata;
}

export class NodeRegistry {
  private readonly connections = new Map<string, ActiveNodeConnection>(); // nodeId -> ActiveConnection
  private readonly generations = new Map<string, number>(); // nodeId -> current generation
  private heartbeatCheckTimer?: NodeJS.Timeout;
  private heartbeatCheckInFlight = false;

  constructor(
    private readonly store: IClusterStore,
    private readonly inviteManager: InviteManager,
    private readonly heartbeatTimeoutMs = 30000
  ) {}

  startMonitoring(checkIntervalMs = 10000): void {
    if (this.heartbeatCheckTimer) return;
    this.heartbeatCheckTimer = setInterval(() => {
      if (this.heartbeatCheckInFlight) return;
      this.heartbeatCheckInFlight = true;
      void this.checkHeartbeats().catch(() => {
        console.warn("[NodeRegistry] Heartbeat persistence failed; node and task authorization remains fail-closed.");
      }).finally(() => { this.heartbeatCheckInFlight = false; });
    }, checkIntervalMs);
  }

  stopMonitoring(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = undefined;
    }
  }

  /**
   * 验证并注册节点连接
   */
  async authenticateNode(
    payload: NodeHelloPayload,
    ws: WebSocket,
    remoteIp?: string
  ): Promise<{ success: boolean; reason?: string; generation: number; nodeToken: string }> {
    const { nodeId, nodeToken, inviteCode } = payload;

    let targetToken = nodeToken;
    let existingNode = await this.store.getNode(nodeId);

    // 1. 若提供了 inviteCode 进行首次配对
    if (inviteCode) {
      if (existingNode) {
        return { success: false, reason: "Node identity already exists; authenticate with its token", generation: 0, nodeToken: "" };
      }
      const inviteResult = this.inviteManager.verifyAndConsume(inviteCode);
      if (!inviteResult.valid) {
        return { success: false, reason: inviteResult.reason ?? "Invalid invite code", generation: 0, nodeToken: "" };
      }

      // 颁发全新的 Node Token
      targetToken = NodeIdentity.generateSecureToken();
      const tokenHash = NodeIdentity.hashToken(targetToken);

      const record: ClusterNodeRecord = {
        nodeId,
        name: payload.name,
        role: (inviteResult.role as any) ?? "worker",
        platform: payload.platform,
        arch: payload.arch,
        hostname: payload.hostname,
        tokenHash,
        status: "online",
        lastSeenAt: Date.now(),
        metadata: {
          nodeVersion: payload.nodeVersion,
          nashVersion: payload.nashVersion,
          runtimeRelease: payload.runtimeRelease,
          sandboxBackend: payload.sandboxBackend,
          capabilities: payload.capabilities,
          maxConcurrentRuns: payload.maxConcurrentRuns,
          projects: payload.projects,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      if (!await this.store.createNodeIfAbsent(record)) {
        return { success: false, reason: "Node identity already exists", generation: 0, nodeToken: "" };
      }
      existingNode = record;
    } else {
      // 2. 使用已有 Token 认证
      if (!existingNode) {
        return { success: false, reason: "Node not registered and no invite provided", generation: 0, nodeToken: "" };
      }

      if (existingNode.status === "revoked") {
        return { success: false, reason: "Node has been revoked", generation: 0, nodeToken: "" };
      }

      if (!targetToken) {
        return { success: false, reason: "Node token is required", generation: 0, nodeToken: "" };
      }

      const inputHash = NodeIdentity.hashToken(targetToken);
      if (inputHash !== existingNode.tokenHash) {
        return { success: false, reason: "Invalid node token", generation: 0, nodeToken: "" };
      }
    }

    // 3. 代际递增并替代旧连接
    const prevGen = this.generations.get(nodeId) ?? 0;
    const nextGen = prevGen + 1;
    this.generations.set(nodeId, nextGen);

    const metadata: NodeMetadata = {
      nodeId,
      name: payload.name,
      role: existingNode.role,
      platform: payload.platform as any,
      arch: payload.arch,
      hostname: payload.hostname,
      nodeVersion: payload.nodeVersion,
      nashVersion: payload.nashVersion,
          runtimeRelease: payload.runtimeRelease,
      sandboxBackend: payload.sandboxBackend as any,
      capabilities: payload.capabilities,
      maxConcurrentRuns: payload.maxConcurrentRuns,
      projects: payload.projects,
    };

    const activeConn: ActiveNodeConnection = {
      nodeId,
      generation: nextGen,
      ws,
      remoteIp,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      metadata,
    };

    const updatedRecord: ClusterNodeRecord = {
      ...existingNode,
      name: payload.name,
      platform: payload.platform as any,
      arch: payload.arch,
      hostname: payload.hostname,
      status: "online",
      lastSeenAt: Date.now(),
      metadata: metadata as any,
      updatedAt: Date.now(),
    };
    const activated = await this.store.updateNodeConnection(updatedRecord);
    if (!activated || this.generations.get(nodeId) !== nextGen) {
      return { success: false, reason: "Node was revoked, replaced or superseded during authentication", generation: 0, nodeToken: "" };
    }

    const oldConn = this.connections.get(nodeId);
    if (oldConn && oldConn.ws !== ws) {
      try {
        oldConn.ws.close(4001, "Superseded by new connection generation");
      } catch {}
    }

    this.connections.set(nodeId, activeConn);

    return {
      success: true,
      generation: nextGen,
      nodeToken: targetToken ?? "",
    };
  }

  /**
   * 记录节点心跳
   */
  async recordHeartbeat(nodeId: string, generation: number): Promise<boolean> {
    const conn = this.connections.get(nodeId);
    if (!conn) return false;
    if (conn.generation !== generation) return false;

    conn.lastHeartbeatAt = Date.now();
    await this.store.updateNodeLastSeen(nodeId, Date.now());
    return true;
  }

  /**
   * 节点主动断开或连接关闭
   */
  async handleDisconnect(nodeId: string, generation: number): Promise<void> {
    const conn = this.connections.get(nodeId);
    if (!conn || conn.generation !== generation) {
      return; // 属于旧代际或已清理
    }

    this.connections.delete(nodeId);
    await this.store.updateNodeStatus(nodeId, "offline");
  }

  /**
   * 获取指定节点的活跃连接
   */
  getConnection(nodeId: string): ActiveNodeConnection | undefined {
    return this.connections.get(nodeId);
  }

  /**
   * 列出所有当前在线连接
   */
  listOnlineConnections(): ActiveNodeConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * 心跳周期探查，标记失联节点
   */
  private async checkHeartbeats(): Promise<void> {
    const now = Date.now();
    for (const [nodeId, conn] of this.connections.entries()) {
      const elapsed = now - conn.lastHeartbeatAt;
      if (elapsed > this.heartbeatTimeoutMs) {
        // 超时失联
        try {
          conn.ws.close(4002, "Heartbeat timeout");
        } catch {}
        this.connections.delete(nodeId);
        await this.store.updateNodeStatus(nodeId, "offline");
      } else if (elapsed > this.heartbeatTimeoutMs / 2) {
        // 疑似掉线
        await this.store.updateNodeStatus(nodeId, "suspect");
      }
    }
  }

  /**
   * 轮换节点凭证。
   *
   * 只接受新凭证的 SHA-256；明文 Token 由节点本地生成并留在节点上，
   * 协调器永远不会看到它，也就不会出现在日志、报告或 API 响应里。
   * Node Identity 保持不变，仅使旧凭证立即失效并踢掉当前连接。
   */
  async rotateNodeToken(nodeId: string, tokenHash: string): Promise<boolean> {
    if (!this.store.rotateNodeToken) return false;
    const node = await this.store.getNode(nodeId);
    if (!node || node.status === "revoked") return false;
    const ok = await this.store.rotateNodeToken(nodeId, tokenHash);
    if (!ok) return false;
    // 让当前连接立即失效：正在运行的 Worker 必须用新凭证重新认证。
    this.generations.set(nodeId, (this.generations.get(nodeId) ?? 0) + 1);
    const conn = this.connections.get(nodeId);
    if (conn) {
      try { conn.ws.close(4003, "Node token rotated; reconnect with the new credential"); } catch {}
      this.connections.delete(nodeId);
    }
    if (node.status === "online" || node.status === "suspect") await this.store.updateNodeStatus(nodeId, "offline");
    return true;
  }

  /**
   * 撤销节点访问权限
   */
  async revokeNode(nodeId: string): Promise<boolean> {
    // Invalidate any authentication that is still waiting for durable activation.
    this.generations.set(nodeId, (this.generations.get(nodeId) ?? 0) + 1);
    const conn = this.connections.get(nodeId);
    if (conn) {
      try {
        conn.ws.close(4003, "Node access revoked");
      } catch {}
      this.connections.delete(nodeId);
    }
    await this.store.updateNodeStatus(nodeId, "revoked");
    return true;
  }
}
