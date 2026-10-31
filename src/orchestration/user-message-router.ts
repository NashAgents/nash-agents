import * as crypto from "node:crypto";
import type { EventBus } from "../observability/event-bus.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { JobManager } from "../jobs/job-manager.js";

export type UserFollowupMode = "steer" | "queue" | "interrupt";

export interface UserFollowupMessage {
  id: string;
  targetAgentId: string;
  mode: UserFollowupMode;
  content: string;
  createdAt: number;
}

export interface UserMessageRouterOptions {
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
  agentRegistry?: AgentRegistry;
  jobManager?: JobManager;
}

/**
 * UserMessageRouter - 统一管理运行期间用户输入的 Steer / Queue / Interrupt 消息路由与安全步边界注入
 *
 * 核心职责：
 * 1. SteerBuffer: 暂存针对特定 Agent 的调整指令，在 AgentLoop 严格的 step boundary 处被 drain 注入；
 * 2. FollowupQueue: 暂存队列消息，当前 Run 结束后 FIFO 取出作为下一轮 User Run 处理；
 * 3. InterruptController: 维护 Run-level 与 Agent-level 的 AbortController，安全中断活跃模型请求与子进程；
 * 4. ToolInterruptController: 维护正在运行的具体 Tool 的取消控制器，支持 Esc 立即截断当前 Tool 执行并推进 LLM；
 * 5. Target Routing: 明确消息归属（Main / SubAgent / TeamMember），支持按 agentId 或 name 智能寻址。
 */
export class UserMessageRouter {
  private readonly steerBuffers = new Map<string, UserFollowupMessage[]>();
  private readonly followupQueue: UserFollowupMessage[] = [];
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly toolAbortControllers = new Map<string, AbortController>();
  private readonly eventBus?: EventBus;
  private readonly projectId?: string;
  private readonly sessionId?: string;
  private readonly agentRegistry?: AgentRegistry;
  private readonly jobManager?: JobManager;

  constructor(options?: UserMessageRouterOptions) {
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectId;
    this.sessionId = options?.sessionId;
    this.agentRegistry = options?.agentRegistry;
    this.jobManager = options?.jobManager;
  }

  /**
   * 将输入的 target 解析为规范的 agentId
   */
  resolveAgentId(target: string): string {
    if (this.agentRegistry) {
      const match = this.agentRegistry.getAgent(target) ?? this.agentRegistry.findByName(target);
      if (match) return match.agentId;
    }
    return target;
  }

  /**
   * 注册指定 Agent 或整个 Run 的 AbortController
   */
  registerAbortController(agentId: string, controller: AbortController): void {
    const canonicalId = this.resolveAgentId(agentId);
    this.abortControllers.set(canonicalId, controller);
    if (canonicalId !== agentId) {
      this.abortControllers.set(agentId, controller);
    }
  }

  /**
   * 注销指定 Agent 的 AbortController
   */
  unregisterAbortController(agentId: string): void {
    const canonicalId = this.resolveAgentId(agentId);
    this.abortControllers.delete(canonicalId);
    this.abortControllers.delete(agentId);
  }

  /**
   * 获取指定 Agent 的 AbortController
   */
  getAbortController(agentId: string): AbortController | undefined {
    const canonicalId = this.resolveAgentId(agentId);
    return this.abortControllers.get(canonicalId) ?? this.abortControllers.get(agentId);
  }

  /**
   * 注册指定 Agent 当前正在运行的 Tool 的 AbortController
   */
  registerToolAbortController(agentId: string, controller: AbortController): void {
    const canonicalId = this.resolveAgentId(agentId);
    this.toolAbortControllers.set(canonicalId, controller);
    if (canonicalId !== agentId) {
      this.toolAbortControllers.set(agentId, controller);
    }
  }

  /**
   * 注销指定 Agent 当前运行的 Tool 的 AbortController
   */
  unregisterToolAbortController(agentId: string): void {
    const canonicalId = this.resolveAgentId(agentId);
    this.toolAbortControllers.delete(canonicalId);
    this.toolAbortControllers.delete(agentId);
  }

  /**
   * 检查指定 Agent 或全局是否存在正在执行的 Tool（包括 bash 子进程或活跃工具调用）
   */
  hasActiveTool(agentId?: string): boolean {
    if (agentId && agentId !== "main") {
      const canonicalId = this.resolveAgentId(agentId);
      if (this.toolAbortControllers.has(canonicalId) || this.toolAbortControllers.has(agentId)) {
        return true;
      }
      if (
        this.jobManager?.getRunningJobs().some(
          (j) => j.ownerAgentId === canonicalId || j.ownerAgentId === agentId
        )
      ) {
        return true;
      }
      return false;
    }

    if (this.toolAbortControllers.size > 0) return true;
    if (this.jobManager && this.jobManager.getRunningJobs().length > 0) return true;
    return false;
  }

  /**
   * 中断当前正在执行的 Tool（杀掉子进程并结束工具调用，保留 steer 注入）
   */
  interruptActiveTool(agentId?: string): boolean {
    let interruptedAny = false;
    const targetId = agentId ? this.resolveAgentId(agentId) : undefined;

    if (targetId && targetId !== "main") {
      const ctrl =
        this.toolAbortControllers.get(targetId) ??
        (agentId ? this.toolAbortControllers.get(agentId) : undefined);
      if (ctrl && !ctrl.signal.aborted) {
        ctrl.abort("Tool interrupted by user");
        interruptedAny = true;
      }
      if (this.jobManager) {
        for (const job of this.jobManager.getRunningJobs()) {
          if (job.ownerAgentId === targetId || job.ownerAgentId === agentId) {
            void job.kill("SIGTERM");
            interruptedAny = true;
          }
        }
      }
    }

    // 若针对特定 target 未找到活跃 Tool/Job，或者 target 为 main：
    // 全局中止所有正在执行的活跃 Tool 与 Job，确保不会遗漏运行中的子进程
    if (!interruptedAny) {
      for (const ctrl of this.toolAbortControllers.values()) {
        if (!ctrl.signal.aborted) {
          ctrl.abort("Tool interrupted by user");
          interruptedAny = true;
        }
      }
      if (this.jobManager) {
        for (const job of this.jobManager.getRunningJobs()) {
          void job.kill("SIGTERM");
          interruptedAny = true;
        }
      }
    }

    if (interruptedAny) {
      this.emitEvent("tool.interrupted_by_user", {
        targetAgentId: targetId ?? "all",
      });
    }

    return interruptedAny;
  }

  /**
   * 提交一条用户运行期消息
   */
  submit(
    content: string,
    targetAgentId = "main",
    mode: UserFollowupMode = "steer"
  ): UserFollowupMessage {
    const canonicalId = this.resolveAgentId(targetAgentId);
    const msg: UserFollowupMessage = {
      id: crypto.randomUUID(),
      targetAgentId: canonicalId,
      mode,
      content: content.trim(),
      createdAt: Date.now(),
    };

    if (mode === "steer") {
      const list = this.steerBuffers.get(canonicalId) ?? [];
      list.push(msg);
      this.steerBuffers.set(canonicalId, list);
      if (targetAgentId !== canonicalId) {
        this.steerBuffers.set(targetAgentId, list);
      }

      this.emitEvent("user.steer_queued", {
        messageId: msg.id,
        targetAgentId: canonicalId,
        content: msg.content,
      });
    } else if (mode === "queue") {
      this.followupQueue.push(msg);

      this.emitEvent("user.queue_appended", {
        messageId: msg.id,
        targetAgentId: canonicalId,
        content: msg.content,
        queueLength: this.followupQueue.length,
      });
    } else if (mode === "interrupt") {
      this.triggerInterrupt(canonicalId, content || "User requested interrupt");
    }

    return msg;
  }

  /**
   * 触发中断 (区分 Run-level 与 Agent-level)
   */
  triggerInterrupt(targetAgentId = "main", reason = "User interrupted"): void {
    if (targetAgentId === "main" || targetAgentId === "all") {
      // Run-level 中断：中止主 Agent 及所有已注册的子 Agent
      for (const [id, controller] of this.abortControllers.entries()) {
        try {
          controller.abort(reason);
        } catch {}
      }
      this.steerBuffers.clear();
      this.emitEvent("user.interrupted", {
        level: "run",
        targetAgentId: "main",
        reason,
      });
    } else {
      // Agent-level 中断：只中断目标 Agent
      const canonicalId = this.resolveAgentId(targetAgentId);
      const controller =
        this.abortControllers.get(canonicalId) ?? this.abortControllers.get(targetAgentId);
      if (controller) {
        try {
          controller.abort(reason);
        } catch {}
      }
      this.steerBuffers.delete(canonicalId);
      this.steerBuffers.delete(targetAgentId);
      this.emitEvent("user.interrupted", {
        level: "agent",
        targetAgentId,
        reason,
      });
    }
  }

  /**
   * 在 AgentLoop 的 Step Boundary 取出指定 Agent 的待注入 Steer 消息
   */
  drainSteer(agentId: string): UserFollowupMessage[] {
    const canonicalId = this.resolveAgentId(agentId);
    let list = this.steerBuffers.get(canonicalId) ?? this.steerBuffers.get(agentId);

    if ((!list || list.length === 0) && this.agentRegistry) {
      const rec = this.agentRegistry.getAgent(canonicalId);
      if (rec?.name && this.steerBuffers.has(rec.name)) {
        list = this.steerBuffers.get(rec.name);
      }
    }

    if (!list || list.length === 0) {
      return [];
    }

    this.steerBuffers.delete(canonicalId);
    this.steerBuffers.delete(agentId);
    if (this.agentRegistry) {
      const rec = this.agentRegistry.getAgent(canonicalId);
      if (rec?.name) this.steerBuffers.delete(rec.name);
    }

    for (const msg of list) {
      this.emitEvent("user.steer_applied", {
        messageId: msg.id,
        targetAgentId: canonicalId,
        content: msg.content,
      });
    }

    return list;
  }

  /**
   * 检查指定 Agent 是否存在待注入的 Steer 消息
   */
  hasPendingSteer(agentId: string): boolean {
    const canonicalId = this.resolveAgentId(agentId);
    const list = this.steerBuffers.get(canonicalId) ?? this.steerBuffers.get(agentId);
    if (list && list.length > 0) return true;
    if (this.agentRegistry) {
      const rec = this.agentRegistry.getAgent(canonicalId);
      if (rec?.name) {
        const nameList = this.steerBuffers.get(rec.name);
        if (nameList && nameList.length > 0) return true;
      }
    }
    return false;
  }

  /**
   * 检查全局是否存在任何待注入的 Steer 消息
   */
  hasAnyPendingSteer(): boolean {
    for (const list of this.steerBuffers.values()) {
      if (list && list.length > 0) return true;
    }
    return false;
  }

  /**
   * 获取指定 Agent 的待注入 Steer 消息快照（不执行删除）
   */
  getPendingSteerList(agentId?: string): UserFollowupMessage[] {
    if (agentId) {
      const canonicalId = this.resolveAgentId(agentId);
      const list = this.steerBuffers.get(canonicalId) ?? this.steerBuffers.get(agentId);
      if (list && list.length > 0) return list.slice();
      if (this.agentRegistry) {
        const rec = this.agentRegistry.getAgent(canonicalId);
        if (rec?.name) {
          const nameList = this.steerBuffers.get(rec.name);
          if (nameList && nameList.length > 0) return nameList.slice();
        }
      }
      return [];
    }
    const all: UserFollowupMessage[] = [];
    for (const list of this.steerBuffers.values()) {
      all.push(...list);
    }
    return all;
  }

  /**
   * 获取当前 Followup Queue 长度
   */
  getQueueLength(): number {
    return this.followupQueue.length;
  }

  /**
   * 当前 Run 结束后，出队下一条 Followup 消息
   */
  dequeueFollowup(): UserFollowupMessage | undefined {
    return this.followupQueue.shift();
  }

  /**
   * 清空所有缓冲区
   */
  clear(): void {
    this.steerBuffers.clear();
    this.followupQueue.length = 0;
    this.abortControllers.clear();
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId ?? "default-project",
        sessionId: this.sessionId ?? "default-session",
        data,
      });
    }
  }
}
