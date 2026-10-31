import * as crypto from "node:crypto";
import type { TeamMessage } from "./types.js";
import type { EventBus } from "../observability/event-bus.js";

/**
 * 带有投递确认状态的内部消息记录
 */
export interface InternalTeamMessage extends TeamMessage {
  status: "pending" | "delivered" | "acknowledged";
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export interface MailboxOptions {
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
}

/**
 * Team Mailbox - 管理 Agent 之间的异步协作消息分发与可靠 ACK 机制
 *
 * 铁律：
 * 1. 仅负责 Agent 间点对点/广播沟通，绝不是 Task 状态源；
 * 2. 消息流转状态：pending -> delivered -> acknowledged；
 * 3. 严禁一 claim 就直接彻底物理销毁，必须支持 ack 确认与 nack 回滚以防崩溃丢消息。
 */
export class Mailbox {
  private readonly inboxes = new Map<string, InternalTeamMessage[]>();
  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly sessionId: string;

  constructor(options?: MailboxOptions) {
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectId ?? "default-project";
    this.sessionId = options?.sessionId ?? "default-session";
  }

  registerRecipient(agentId: string): void {
    if (!this.inboxes.has(agentId)) this.inboxes.set(agentId, []);
  }

  unregisterRecipient(agentId: string): void { this.inboxes.delete(agentId); }

  /**
   * 发送一条团队内部消息
   */
  sendMessage(input: {
    teamId: string;
    senderAgentId: string;
    senderName?: string;
    targetAgentId: string;
    content: string;
  }): TeamMessage {
    const message: InternalTeamMessage = {
      type: "team_message",
      teamId: input.teamId,
      messageId: `msg-${crypto.randomUUID().slice(0, 8)}`,
      senderAgentId: input.senderAgentId,
      senderName: input.senderName,
      targetAgentId: input.targetAgentId,
      content: input.content,
      status: "pending",
      createdAt: Date.now(),
    };

    if (input.targetAgentId === "*") {
      for (const [agentId, queue] of this.inboxes.entries()) {
        if (agentId !== input.senderAgentId) {
          queue.push({ ...message });
        }
      }
    } else {
      let queue = this.inboxes.get(input.targetAgentId);
      if (!queue) {
        queue = [];
        this.inboxes.set(input.targetAgentId, queue);
      }
      queue.push(message);
    }

    this.emitEvent("team.message.sent", {
      message: { ...message },
    });

    return { ...message };
  }

  /**
   * 在 Step Boundary 获取所有 pending 消息，并将其原子标记为 delivered
   */
  claimPendingMessages(agentId: string): TeamMessage[] {
    const queue = this.inboxes.get(agentId);
    if (!queue || queue.length === 0) {
      return [];
    }

    const pendingMessages: InternalTeamMessage[] = [];
    const now = Date.now();

    for (const msg of queue) {
      if (msg.status === "pending") {
        msg.status = "delivered";
        msg.deliveredAt = now;
        pendingMessages.push(msg);
      }
    }

    if (pendingMessages.length > 0) {
      this.emitEvent("team.message.delivered", {
        targetAgentId: agentId,
        messageCount: pendingMessages.length,
      });
    }

    return pendingMessages.map((m) => ({ ...m }));
  }

  /**
   * 确认消息已被成功处理或已持久化写入 Durable Session (ACK)
   */
  acknowledgeMessages(agentId: string, messageIds: string[]): void {
    const queue = this.inboxes.get(agentId);
    if (!queue) return;

    const idSet = new Set(messageIds);
    const now = Date.now();

    // 标记 acknowledged 并过滤已完成的消息
    const remaining: InternalTeamMessage[] = [];
    for (const msg of queue) {
      if (idSet.has(msg.messageId)) {
        msg.status = "acknowledged";
        msg.acknowledgedAt = now;
      } else {
        remaining.push(msg);
      }
    }

    this.inboxes.set(agentId, remaining);
  }

  /**
   * 处理失败或中断时，将已 delivered 的消息重新退回 pending (NACK)
   */
  nackMessages(agentId: string, messageIds: string[]): void {
    const queue = this.inboxes.get(agentId);
    if (!queue) return;

    const idSet = new Set(messageIds);
    for (const msg of queue) {
      if (idSet.has(msg.messageId) && msg.status === "delivered") {
        msg.status = "pending";
        msg.deliveredAt = undefined;
      }
    }
  }

  /**
   * 查看未消费 (pending) 的消息数
   */
  getUnreadCount(agentId: string): number {
    const queue = this.inboxes.get(agentId);
    if (!queue) return 0;
    return queue.filter((m) => m.status === "pending").length;
  }

  /**
   * 查看全部内部消息（含 delivered）
   */
  peekAllMessages(agentId: string): TeamMessage[] {
    const queue = this.inboxes.get(agentId);
    return queue ? queue.map((m) => ({ ...m })) : [];
  }

  /**
   * 格式化消息为提示词
   */
  static formatForPrompt(messages: TeamMessage[]): string[] {
    return messages.map((msg) => {
      const senderDisplay = msg.senderName
        ? `${msg.senderName} (${msg.senderAgentId})`
        : msg.senderAgentId;
      return `[Message from teammate: ${senderDisplay}]\n${msg.content}`;
    });
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: this.sessionId,
        data,
      });
    }
  }
}
