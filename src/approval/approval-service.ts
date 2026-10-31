import * as crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ApprovalDecision,
  ApprovalProvider,
  ApprovalRequest,
  QueuedApprovalItem,
} from "./types.js";
import type { EventBus } from "../observability/event-bus.js";

const approvalWaitContext = new AsyncLocalStorage<{ start(): void; end(): void }>();
export function withApprovalWaitContext<T>(observer: { start(): void; end(): void }, fn: () => T): T {
  return approvalWaitContext.run(observer, fn);
}

export interface RequestApprovalOptions {
  /**
   * 等待审批时让出并发槽位的回调函数
   */
  yieldSlot?: () => () => Promise<void>;

  /**
   * 中断或取消信号
   */
  signal?: AbortSignal;

  /**
   * 发起请求的 Agent 标识
   */
  agentId?: string;

  /**
   * 发起请求的 Agent 易读名称
   */
  agentName?: string;
}

export interface ApprovalServiceOptions {
  provider?: ApprovalProvider;
  eventBus?: EventBus;
  isTTY?: boolean;
}

/**
 * 集中管理多 Agent 提权审批交互的核心服务。
 * 遵循依赖注入原则，解耦具体 UI 实现。
 *
 * 核心设计：
 * 1. 全域共享单一 ApprovalQueue，严格按 FIFO 顺序排队处理并发审批；
 * 2. 审批等待期间主动调用 yieldSlot 释放并发槽位，避免并发死锁；
 * 3. 审批完成后调用 resumeSlot 恢复执行槽位；
 * 4. 支持由主 CLI / Navigation 模式实时裁决 (resolveActive)；
 * 5. Non-TTY / 无提供者时严格遵循 Fail-Closed，默认拒绝 (deny)。
 */
export class ApprovalService {
  private readonly provider?: ApprovalProvider;
  private readonly eventBus?: EventBus;
  private readonly isTTY: boolean;
  private readonly queue: QueuedApprovalItem[] = [];
  private activeItem: QueuedApprovalItem | null = null;
  private readonly preApprovedGrants = new Map<string, { expiresAt: number }>();

  constructor(options?: ApprovalProvider | ApprovalServiceOptions) {
    if (options && "askApproval" in options) {
      this.provider = options;
      this.isTTY = true;
    } else if (options) {
      this.provider = options.provider;
      this.eventBus = options.eventBus;
      this.isTTY = options.isTTY ?? true;
    } else {
      this.isTTY = true;
    }
  }

  /**
   * 判断当前审批服务是否具备可交互的提供者
   */
  hasProvider(): boolean {
    return Boolean(this.provider);
  }

  /**
   * 获取当前正在展示的活跃审批项
   */
  getActiveApproval(): QueuedApprovalItem | null {
    return this.activeItem;
  }

  /**
   * 获取所有挂起等待中的审批项列表
   */
  getPendingApprovals(): QueuedApprovalItem[] {
    return [...this.queue];
  }

  /**
   * 查询是否有正在处理或排队中的审批
   */
  hasPending(): boolean {
    return this.activeItem !== null || this.queue.length > 0;
  }

  /**
   * 注册单步预授权凭证（防双重审批，仅在 TTL 内有效，单次消耗即作废）
   */
  grantPreApproved(key: string, ttlMs = 10000): void {
    this.preApprovedGrants.set(key, { expiresAt: Date.now() + ttlMs });
  }

  /**
   * 校验并单次消耗预授权凭证
   */
  consumePreApproved(key: string): boolean {
    const grant = this.preApprovedGrants.get(key);
    if (!grant) return false;
    this.preApprovedGrants.delete(key);
    return grant.expiresAt > Date.now();
  }

  /**
   * 向用户或交互环境发起提权审批请求
   *
   * @param request - 审批请求上下文详情
   * @param options - 槽位让出与中断选项
   * @returns 审批裁决：'allow-once'（单次放行）或 'deny'（拒绝）
   */
  async requestApproval(
    request: ApprovalRequest,
    options?: RequestApprovalOptions
  ): Promise<ApprovalDecision> {
    const effectiveAgentId = options?.agentId ?? request.agentId ?? "main";
    const specificKey = `${effectiveAgentId}::${request.capability}`;
    const wildcardKey = `${effectiveAgentId}::*`;

    // 检查是否有前置上层安全审查刚通过的预授权凭证，单次放行，杜绝双重打扰
    if (this.consumePreApproved(specificKey) || this.consumePreApproved(wildcardKey)) {
      return "allow-once";
    }

    if (!this.provider) {
      return "deny";
    }

    const id = request.id ?? `appr-${crypto.randomUUID().slice(0, 8)}`;
    const enrichedRequest: ApprovalRequest = {
      ...request,
      id,
      agentId: request.agentId ?? options?.agentId,
      agentName: request.agentName ?? options?.agentName ?? request.agentId,
      createdAt: request.createdAt ?? Date.now(),
    };

    // 1. 若提供了 yieldSlot，在进入等待前立即让出并发槽位
    let resumeSlot: (() => Promise<void>) | undefined;
    if (options?.yieldSlot) {
      try {
        resumeSlot = options.yieldSlot();
      } catch {}
    }

    const observer = approvalWaitContext.getStore();
    observer?.start();
    try {
    return await new Promise<ApprovalDecision>((resolve, reject) => {
      const item: QueuedApprovalItem = {
        id,
        request: enrichedRequest,
        agentId: enrichedRequest.agentId ?? "main",
        agentName: enrichedRequest.agentName ?? enrichedRequest.agentId ?? "Main",
        createdAt: enrichedRequest.createdAt ?? Date.now(),
        resolve: async (decision) => {
          if (resumeSlot) {
            try {
              await resumeSlot();
            } catch {}
          }
          resolve(decision);
        },
        reject: async (err) => {
          if (resumeSlot) {
            try {
              await resumeSlot();
            } catch {}
          }
          reject(err);
        },
        yieldResumeSlot: resumeSlot,
        abortSignal: options?.signal,
      };

      if (options?.signal?.aborted) {
        item.resolve("deny");
        return;
      }

      options?.signal?.addEventListener("abort", () => {
        this.removeItem(id, "deny");
      });

      this.queue.push(item);
      this.emitEvent("approval.requested", {
        id,
        request: enrichedRequest,
        queueLength: this.queue.length,
      });

      this.processNext();
    });
    } finally { observer?.end(); }
  }

  /**
   * 外部（如 Presenter / NavigationHandler）直接裁决当前活跃的审批项
   */
  resolveActive(decision: ApprovalDecision): boolean {
    if (!this.activeItem) return false;
    const item = this.activeItem;
    this.activeItem = null;
    this.provider?.cancelApproval?.(item.id);

    this.emitEvent("approval.resolved", {
      id: item.id,
      decision,
      agentId: item.agentId,
      agentName: item.agentName,
    });

    item.resolve(decision);
    this.processNext();
    return true;
  }

  /**
   * 处理队列中的下一个审批项
   */
  private processNext(): void {
    if (this.activeItem || this.queue.length === 0) return;

    this.activeItem = this.queue.shift()!;
    const current = this.activeItem;

    if (this.provider) {
      this.provider
        .askApproval(current.request)
        .then((decision) => {
          if (this.activeItem?.id === current.id) {
            this.resolveActive(decision);
          }
        })
        .catch(() => {
          if (this.activeItem?.id === current.id) {
            this.resolveActive("deny");
          }
        });
    }
  }

  private removeItem(id: string, fallbackDecision: ApprovalDecision = "deny"): void {
    if (this.activeItem && this.activeItem.id === id) {
      this.resolveActive(fallbackDecision);
      return;
    }
    const idx = this.queue.findIndex((q) => q.id === id);
    if (idx !== -1) {
      const [removed] = this.queue.splice(idx, 1);
      removed.resolve(fallbackDecision);
    }
  }

  /**
   * 中断并拒绝所有挂起的审批项
   */
  abortAll(reason = "Aborted"): void {
    if (this.activeItem) {
      const item = this.activeItem;
      this.activeItem = null;
      this.provider?.cancelApproval?.(item.id);
      item.resolve("deny");
    }
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.resolve("deny");
    }
  }

  /**
   * 中断指定 Agent 的所有挂起审批项
   */
  abortAgent(agentId: string): void {
    if (this.activeItem && this.activeItem.agentId === agentId) {
      this.resolveActive("deny");
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].agentId === agentId) {
        const [removed] = this.queue.splice(i, 1);
        removed.resolve("deny");
      }
    }
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        projectId: "default-project",
        sessionId: "default-session",
        timestamp: new Date().toISOString(),
        data,
      });
    }
  }
}
