/**
 * Distributed Agent Mailbox & A2A Communication (Phase 4)
 * 跨物理节点 Agent 点对点/广播通信、可靠投递、ACK 去重与安全隔离门面
 * 严格限制同一 Graph 作用域、杜绝消息提权伪造、复用 Outbox/Inbox 投递保障
 */

import * as crypto from "node:crypto";
import { Mailbox } from "../../team/mailbox.js";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import { createEnvelope, encodeEnvelope } from "../protocol/message-codec.js";
import type { AgentMessageSendPayload, AgentMessageAckPayload } from "../protocol/types.js";

export interface DistributedMessageInput {
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  sourceTaskId?: string;
  targetNodeId: string;
  targetAgentId: string;
  targetTaskId?: string;
  messageType?: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  ttlMs?: number;
}

export interface DistributedMessageRecord {
  messageId: string;
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  sourceTaskId?: string;
  targetNodeId: string;
  targetAgentId: string;
  targetTaskId?: string;
  messageType: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  deliveryStatus: "pending" | "delivered" | "acknowledged" | "failed" | "expired";
  sentAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  expiresAt: number;
}

export async function validateMessageMembership(store: IClusterStore, input: DistributedMessageInput): Promise<void> {
  const graph = await store.getGraph?.(input.graphId);
  const nodes = await store.listGraphNodes?.(input.graphId) ?? [];
  const matches = (nodeId: string, taskId?: string) => nodes.some((node) => node.assignedNodeId === nodeId && (!taskId || node.taskId === taskId));
  if (!graph || !matches(input.sourceNodeId, input.sourceTaskId) || !matches(input.targetNodeId, input.targetTaskId)) {
    throw new Error("Security Violation: A2A sender and recipient must belong to the same persisted graph");
  }
}

export class DistributedMailbox {
  private readonly localMailbox: Mailbox;

  constructor(
    private readonly store: IClusterStore,
    private readonly localNodeId: string,
    private readonly registry?: NodeRegistry
  ) {
    this.localMailbox = new Mailbox();
  }

  get local(): Mailbox {
    return this.localMailbox;
  }

  /**
   * 发送跨节点 A2A 消息
   */
  async sendMessage(input: DistributedMessageInput): Promise<DistributedMessageRecord> {
    // 1. 安全边界检查：拒绝无图归属的消息与危险指令提升
    if (!input.graphId) {
      throw new Error("Security Violation: Distributed A2A message must specify a valid graphId.");
    }

    const payload = input.payload ?? {};
    if (payload.isSystemApproval || payload.escalatePrivileges || payload.bypassSandbox) {
      throw new Error("Security Violation: A2A messages cannot forge system approvals or elevate privileges.");
    }

    await validateMessageMembership(this.store, input);
    if (input.targetNodeId !== this.localNodeId && (!input.sourceTaskId || !input.targetTaskId)) throw new Error("Security Violation: remote A2A requires source and target task identity");

    const messageId = `msg-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();
    const expiresAt = now + (input.ttlMs ?? 300000); // 默认 5 分钟有效期

    const record: DistributedMessageRecord = {
      messageId,
      graphId: input.graphId,
      sourceNodeId: input.sourceNodeId,
      sourceAgentId: input.sourceAgentId,
      sourceTaskId: input.sourceTaskId,
      targetNodeId: input.targetNodeId,
      targetAgentId: input.targetAgentId,
      targetTaskId: input.targetTaskId,
      messageType: input.messageType ?? "agent.message",
      correlationId: input.correlationId,
      payload: input.payload,
      deliveryStatus: "pending",
      sentAt: now,
      expiresAt,
    };

    // 2. 持久化至集群 Mailbox 表
    await this.store.saveAgentMessage?.(record);

    // 3. 若目标即为当前本地节点，直接转交本地 Mailbox
    if (input.targetNodeId === this.localNodeId) {
      this.localMailbox.sendMessage({
        teamId: input.graphId,
        senderAgentId: `${input.sourceNodeId}::${input.sourceAgentId}`,
        targetAgentId: input.targetAgentId,
        content: JSON.stringify(input.payload),
      });
      await this.store.updateAgentMessageStatus?.(messageId, "delivered", now);
      record.deliveryStatus = "delivered";
      return record;
    }

    // 4. 远程目标节点投递：经由 WSS 与 Outbox
    if (this.registry) {
      const conn = this.registry.getConnection(input.targetNodeId);
      const envelope = createEnvelope(
        "agent.message_deliver",
        record as AgentMessageSendPayload,
        this.localNodeId,
        input.targetNodeId,
        input.correlationId
      );

      envelope.messageId = messageId;
      // 写入 Outbox
      await this.store.enqueueOutbox?.({
        targetNodeId: input.targetNodeId,
        messageId,
        messageType: "agent.message_deliver",
        payload: record,
        status: "pending",
        attempts: 1,
        nextRetryAt: now + 5000,
        createdAt: now,
      });

      if (conn && conn.ws.readyState === 1) {
        try {
          conn.ws.send(encodeEnvelope(envelope));
        } catch (err) {
          console.warn(`[DistributedMailbox] Failed to send message over WSS to ${input.targetNodeId}: ${err}`);
        }
      }
    }

    return record;
  }

  /**
   * 目标 Worker 处理入站消息并入队本地邮箱
   */
  async handleInboundMessage(envelopePayload: AgentMessageSendPayload): Promise<boolean> {
    const { messageId, graphId, targetNodeId, targetAgentId, payload } = envelopePayload;

    await validateMessageMembership(this.store, envelopePayload);
    if (targetNodeId !== this.localNodeId || envelopePayload.expiresAt <= Date.now()) return false;
    // 1. 幂等去重检查
    if (this.store.checkAndRecordInbox) {
      const isNew = await this.store.checkAndRecordInbox(messageId, envelopePayload.sourceNodeId);
      if (!isNew) {
        // 重复消息直接丢弃并返回确认
        return true;
      }
    }

    // 2. 注入本地 Mailbox
    this.localMailbox.sendMessage({
      teamId: graphId,
      senderAgentId: `${envelopePayload.sourceNodeId}::${envelopePayload.sourceAgentId}`,
      targetAgentId,
      content: typeof payload === "string" ? payload : JSON.stringify(payload),
    });

    // 3. 更新持久化状态为 delivered
    await this.store.updateAgentMessageStatus?.(messageId, "delivered", Date.now());
    return true;
  }

  /**
   * 确认消息已被处理 (ACK)
   */
  async acknowledge(messageId: string): Promise<void> {
    await this.store.updateAgentMessageStatus?.(messageId, "acknowledged", Date.now());
  }
}
