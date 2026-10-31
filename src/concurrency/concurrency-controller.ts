import type { RuntimeLimitsConfig } from "./types.js";
import { resolveRuntimeLimits } from "./runtime-limits.js";
import {
  AgentDepthLimitError,
  AgentTotalLimitError,
  AgentChildrenLimitError,
  AgentConcurrencyLimitError,
  TeamMemberLimitError,
  TaskLimitError,
  ReplanLimitError,
  ExecutionTimeoutError,
  NoProgressDetectedError,
} from "./errors.js";

/**
 * 并发控制与资源限制控制器
 *
 * 铁律：
 * 1. 绝不充当“智能 Scheduler”或做任务派发决策；
 * 2. 仅在资源层面严格把关瞬时并发 (Semaphore)、累计上限、递归深度 (depth) 与防死循环；
 * 3. 支持父子 Agent await 时的槽位让出与恢复 (yield/resume)，杜绝小并发限制下的死锁 (Deadlock)。
 */
export class ConcurrencyController {
  private readonly limits: Required<RuntimeLimitsConfig>;
  private totalAgentsCreated = 0;
  private currentRunningAgents = 0;
  private readonly slotOwners = new Set<string>();
  private totalReplansCount = 0;
  private totalTasksCount = 0;
  private currentTeamMembersCount = 0;
  private readonly childrenCountMap = new Map<string, number>();
  private readonly waitQueue: Array<() => void> = [];
  private readonly startTime: number;
  private consecutiveNoProgressCount = 0;

  constructor(config?: RuntimeLimitsConfig) {
    this.limits = resolveRuntimeLimits(config);
    this.startTime = Date.now();
  }

  getLimits(): Required<RuntimeLimitsConfig> {
    return { ...this.limits };
  }

  /**
   * 校验待创建 Agent 的深度与总数，若合规则原子递增计数
   */
  registerAgentSpawn(depth: number, parentAgentId?: string): void {
    this.checkWallTime();

    if (depth > this.limits.maxAgentDepth) {
      throw new AgentDepthLimitError(depth, this.limits.maxAgentDepth);
    }

    if (this.totalAgentsCreated >= this.limits.maxTotalAgents) {
      throw new AgentTotalLimitError(
        this.totalAgentsCreated,
        this.limits.maxTotalAgents
      );
    }

    if (parentAgentId) {
      const currentChildren = this.childrenCountMap.get(parentAgentId) ?? 0;
      if (currentChildren >= this.limits.maxChildrenPerAgent) {
        throw new AgentChildrenLimitError(
          parentAgentId,
          currentChildren,
          this.limits.maxChildrenPerAgent
        );
      }
      this.childrenCountMap.set(parentAgentId, currentChildren + 1);
    }

    this.totalAgentsCreated++;
  }

  /**
   * 获取一个并发执行槽位 (异步信号量 Semaphore)
   * 若当前 running 已满，则在 Promise 队列中排队等待空闲，绝不使用 setInterval 轮询
   *
   * @returns 释放槽位的回调函数 release()
   */
  async acquireSlot(signal?: AbortSignal, agentId?: string): Promise<() => void> {
    this.checkWallTime();
    signal?.throwIfAborted();

    if (this.currentRunningAgents < this.limits.maxConcurrentAgents) {
      this.currentRunningAgents++;
      if (agentId) this.slotOwners.add(agentId);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          if (agentId) this.slotOwners.delete(agentId);
          this.releaseSlot();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waitQueue.indexOf(activate);
        if (index >= 0) this.waitQueue.splice(index, 1);
        reject(signal?.reason);
      };
      const activate = () => {
        signal?.removeEventListener("abort", onAbort);
        if (agentId) this.slotOwners.add(agentId);
        let released = false;
        resolve(() => { if (!released) { released = true; if (agentId) this.slotOwners.delete(agentId); this.releaseSlot(); } });
      };
      this.waitQueue.push(activate);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  /**
   * 父 Agent await 子 Agent 或进入 waiting 状态时临时让出 (Yield) 槽位
   * 避免由于 maxConcurrentAgents 较小导致父子互相等待死锁
   *
   * @returns 恢复槽位 (Resume) 的异步函数
   */
  yieldSlot(agentId?: string): () => Promise<void> {
    if (agentId && !this.slotOwners.delete(agentId)) return async () => {};
    this.releaseSlot();
    let resumed = false;
    return async () => {
      if (resumed) return;
      resumed = true;
      await this.acquireSlot(undefined, agentId);
    };
  }

  /**
   * 立即尝试非阻塞申请槽位，若满则直接抛出 ConcurrencyLimitError
   */
  tryAcquireSlotNow(): () => void {
    this.checkWallTime();
    if (this.currentRunningAgents >= this.limits.maxConcurrentAgents) {
      throw new AgentConcurrencyLimitError(
        this.currentRunningAgents,
        this.limits.maxConcurrentAgents
      );
    }
    this.currentRunningAgents++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.releaseSlot();
      }
    };
  }

  private releaseSlot(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      // 将槽位直接移交给下一个等待者
      next();
    } else {
      this.currentRunningAgents = Math.max(0, this.currentRunningAgents - 1);
    }
  }

  registerTeamMember(): void {
    if (this.currentTeamMembersCount >= this.limits.maxTeamMembers) {
      throw new TeamMemberLimitError(
        this.currentTeamMembersCount,
        this.limits.maxTeamMembers
      );
    }
    this.currentTeamMembersCount++;
  }

  unregisterTeamMember(): void {
    this.currentTeamMembersCount = Math.max(0, this.currentTeamMembersCount - 1);
  }

  registerTask(): void {
    if (this.totalTasksCount >= this.limits.maxTasks) {
      throw new TaskLimitError(this.totalTasksCount, this.limits.maxTasks);
    }
    this.totalTasksCount++;
  }

  recordReplan(): void {
    if (this.totalReplansCount >= this.limits.maxReplans) {
      throw new ReplanLimitError(this.totalReplansCount, this.limits.maxReplans);
    }
    this.totalReplansCount++;
  }

  reportStepProgress(hasProgress: boolean): void {
    if (!this.limits.enableNoProgressDetection) {
      return;
    }

    if (hasProgress) {
      this.consecutiveNoProgressCount = 0;
    } else {
      this.consecutiveNoProgressCount++;
      if (
        this.consecutiveNoProgressCount >= this.limits.noProgressThreshold
      ) {
        throw new NoProgressDetectedError(this.consecutiveNoProgressCount);
      }
    }
  }

  checkWallTime(): void {
    const elapsed = Date.now() - this.startTime;
    if (elapsed > this.limits.maxWallTimeMs) {
      throw new ExecutionTimeoutError(elapsed, this.limits.maxWallTimeMs);
    }
  }

  getRunningCount(): number {
    return this.currentRunningAgents;
  }

  getWaitingQueueLength(): number {
    return this.waitQueue.length;
  }

  getTotalAgentsCreated(): number {
    return this.totalAgentsCreated;
  }

  getStats() {
    return {
      totalAgentsCreated: this.totalAgentsCreated,
      currentRunningAgents: this.currentRunningAgents,
      waitingQueueLength: this.waitQueue.length,
      totalTasksCount: this.totalTasksCount,
      totalReplansCount: this.totalReplansCount,
      currentTeamMembersCount: this.currentTeamMembersCount,
      elapsedMs: Date.now() - this.startTime,
    };
  }
}
