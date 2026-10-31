import * as crypto from "node:crypto";
import EventEmitter from "node:events";
import type { Team, TeamMemberConfig, TeamChangeNotification } from "./types.js";
import { TeamNotFoundError } from "./errors.js";
import { Roster, type RosterMember } from "./roster.js";
import { Mailbox } from "./mailbox.js";
import type { TaskManager } from "../task/task-manager.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { ConcurrencyController } from "../concurrency/concurrency-controller.js";
import type { EventBus } from "../observability/event-bus.js";
import type { Task, TaskResult } from "../task/types.js";

export interface TeamRuntimeOptions {
  teamId?: string;
  name: string;
  leaderId: string;
  taskManager: TaskManager;
  agentRegistry: AgentRegistry;
  concurrencyController: ConcurrencyController;
  eventBus?: EventBus;
  mailbox?: Mailbox;
}

/**
 * TeamRuntime - 统一 Agent 协作团队运行时
 *
 * 核心设计：
 * 1. Leader + Persistent TeamMembers；
 * 2. 共享 TaskBoard (TaskManager) 与 Roster；
 * 3. 点对点/广播 Mailbox；
 * 4. waitForChange 事件驱动唤醒（零轮询）；
 * 5. 原子 Task Claim 与 Lead Assign。
 */
export class TeamRuntime {
  readonly teamId: string;
  readonly name: string;
  readonly leaderId: string;

  readonly roster: Roster;
  readonly mailbox: Mailbox;
  readonly taskManager: TaskManager;
  readonly agentRegistry: AgentRegistry;
  readonly concurrencyController: ConcurrencyController;

  private readonly eventBus?: EventBus;
  private readonly internalEmitter = new EventEmitter();
  private readonly cleanupBusSub?: () => void;

  constructor(options: TeamRuntimeOptions) {
    this.teamId = options.teamId ?? `team-${crypto.randomUUID().slice(0, 8)}`;
    this.name = options.name;
    this.leaderId = options.leaderId;

    this.taskManager = options.taskManager;
    this.agentRegistry = options.agentRegistry;
    this.concurrencyController = options.concurrencyController;
    this.eventBus = options.eventBus;
    this.mailbox =
      options.mailbox ??
      new Mailbox({
        eventBus: this.eventBus,
      });

    this.mailbox.registerRecipient(this.leaderId);
    this.roster = new Roster(this.agentRegistry, this.concurrencyController);

    // 确保 leader 记录存在
    if (!this.agentRegistry.getAgent(this.leaderId)) {
      const isMain = this.leaderId === "main";
      this.agentRegistry.register({
        agentId: this.leaderId,
        type: isMain ? "main" : "team-lead",
        name: isMain ? "Main" : "Team Leader",
        depth: 0,
      });
    }

    // 监听 EventBus 事件以驱动内部 waitForChange 唤醒
    if (this.eventBus) {
      this.cleanupBusSub = this.eventBus.subscribe("*", (event) => {
        this.internalEmitter.emit("event", event);
      });
    }

    this.emitTeamEvent("team.created", {
      team: this.getTeamInfo(),
    });
  }

  getTeamInfo(): Team {
    return {
      teamId: this.teamId,
      name: this.name,
      leaderId: this.leaderId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /**
   * 向团队中添加一名常驻专业成员
   */
  addMember(config: TeamMemberConfig): RosterMember {
    const member = this.roster.addMember(config, this.leaderId);
    this.mailbox.registerRecipient(member.agentId);
    this.emitTeamEvent("team.member_added", {
      teamId: this.teamId,
      member,
    });
    this.internalEmitter.emit("change", {
      reason: "member_status_changed",
      agentId: member.agentId,
    });
    return member;
  }

  /**
   * 移除团队成员
   */
  removeMember(agentId: string): void {
    this.roster.removeMember(agentId);
    this.mailbox.unregisterRecipient(agentId);
    this.emitTeamEvent("team.member_removed", {
      teamId: this.teamId,
      agentId,
    });
    this.internalEmitter.emit("change", {
      reason: "member_status_changed",
      agentId,
    });
  }

  /**
   * Leader 分配任务
   */
  assignTask(taskId: string, agentId: string, expectedRevision?: number): Task {
    if (!this.roster.hasMember(agentId) && agentId !== this.leaderId) {
      throw new Error(`无法分配任务: Agent '${agentId}' 不是当前团队成员。`);
    }

    const task = this.taskManager.assignTask(taskId, agentId, expectedRevision);
    this.internalEmitter.emit("change", {
      reason: "task_assigned",
      agentId,
      details: { taskId },
    });
    return task;
  }

  /**
   * Team 成员自主原子认领 Ready 任务 (CAS)
   */
  claimTask(
    taskId: string,
    agentId: string,
    expectedRevision?: number,
    options?: { workspaceMode?: "shared" | "worktree" }
  ): Task {
    if (!this.roster.hasMember(agentId) && agentId !== this.leaderId) {
      throw new Error(`无法认领任务: Agent '${agentId}' 不是当前团队成员。`);
    }

    const task = this.taskManager.claimTask(taskId, agentId, expectedRevision, options);
    this.agentRegistry.updateCurrentTaskId(agentId, taskId);
    this.agentRegistry.updateStatus(agentId, "running", { currentTaskId: taskId });

    this.internalEmitter.emit("change", {
      reason: "task_assigned",
      agentId,
      details: { taskId },
    });

    return task;
  }

  /**
   * 发送团队消息
   */
  sendMessage(senderAgentId: string, targetAgentId: string, content: string): void {
    const sender = this.roster.getMember(senderAgentId);
    const msg = this.mailbox.sendMessage({
      teamId: this.teamId,
      senderAgentId,
      senderName: sender?.name ?? (senderAgentId === this.leaderId ? "Lead" : undefined),
      targetAgentId,
      content,
    });

    this.internalEmitter.emit("change", {
      reason: "mail_received",
      agentId: targetAgentId,
      details: { messageId: msg.messageId, from: senderAgentId },
    });
  }

  /**
   * 在 Step Boundary 获取并清空待处理的团队消息
   */
  claimMessagesForStep(agentId: string) {
    return this.mailbox.claimPendingMessages(agentId);
  }

  /**
   * 零轮询：等待团队状态变更（由事件总线或内部事件即时唤醒）
   *
   * @param agentId - 当前处于等待状态的 Agent ID
   * @param options - 超时或外部取消信号
   */
  async waitForChange(
    agentId: string,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
    }
  ): Promise<TeamChangeNotification> {
    // 检查是否有立即可读的未读消息或 Ready 任务
    const unreadCount = this.mailbox.getUnreadCount(agentId);
    if (unreadCount > 0) {
      return {
        reason: "mail_received",
        agentId,
        details: { unreadCount },
      };
    }

    const timeoutMs = options?.timeoutMs ?? 30_000;

    // 挂起等待前让出并发槽位，防止占用 maxConcurrentAgents 导致死锁
    const resumeSlot = this.concurrencyController.yieldSlot(agentId);

    // 将 Agent 状态标记为 waiting
    this.agentRegistry.updateStatus(agentId, "waiting");

    try {
      return await new Promise<TeamChangeNotification>((resolve) => {
        let timer: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          this.internalEmitter.off("change", onChange);
          this.internalEmitter.off("event", onBusEvent);
          if (options?.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
        };

        const onAbort = () => {
          cleanup();
          resolve({
            reason: "interrupted",
            agentId,
            details: { reason: "AbortSignal cancelled" },
          });
        };

        const onChange = (notif: { reason: any; agentId: string; details?: any }) => {
          if (notif.agentId === agentId || notif.agentId === "*" || notif.reason === "task_ready") {
            cleanup();
            this.agentRegistry.updateStatus(agentId, "running");
            resolve({
              reason: notif.reason,
              agentId,
              details: notif.details,
            });
          }
        };

        const onBusEvent = (event: any) => {
          const type = event?.type;
          if (
            type === "task.ready" ||
            type === "task.completed" ||
            type === "task.failed" ||
            type === "task.blocked"
          ) {
            cleanup();
            this.agentRegistry.updateStatus(agentId, "running");
            resolve({
              reason:
                type === "task.ready"
                  ? "task_ready"
                  : type === "task.completed"
                  ? "task_completed"
                  : type === "task.failed"
                  ? "task_failed"
                  : "task_blocked",
              agentId,
              details: event.data,
            });
          }
        };

        this.internalEmitter.on("change", onChange);
        this.internalEmitter.on("event", onBusEvent);

        if (options?.signal) {
          if (options.signal.aborted) {
            onAbort();
            return;
          }
          options.signal.addEventListener("abort", onAbort);
        }

        timer = setTimeout(() => {
          cleanup();
          resolve({
            reason: "timeout",
            agentId,
            details: { timeoutMs },
          });
        }, timeoutMs);
      });
    } finally {
      // 唤醒、超时或取消后重新安全恢复并发槽位
      await resumeSlot();
    }
  }

  destroy(): void {
    if (this.cleanupBusSub) {
      this.cleanupBusSub();
    }
    this.internalEmitter.removeAllListeners();
  }

  private emitTeamEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: "team-project",
        sessionId: this.teamId,
        data,
      });
    }
  }
}
