import * as crypto from "node:crypto";
import type {
  DecisionKind,
  DecisionOption,
  StructuredDecision,
  CreateDecisionInput,
} from "./types.js";

export interface DecisionControllerOptions {
  onDecisionChange?: () => void;
}

/**
 * 通用结构化决策控制器 (DecisionController)
 *
 * 核心设计：
 * 1. 统一管理 Plan Approval、Sandbox Permission、Confirm/Cancel 等所有有限选项决策；
 * 2. 严格 FIFO 队列管理多决策排队，每次仅激活单一 activeDecision；
 * 3. Run-safe：任何 Timer、Agent 事件、Task 事件重绘均不重置 selectedIndex；
 * 4. 支持 ↑ / ↓ 循环切换选项、Enter 确认当前选项、Esc 取消或快捷键直接触发；
 * 5. 完全解耦自然语言文本，决策结果为强类型事件。
 */
export class DecisionController {
  private readonly queue: StructuredDecision[] = [];
  private activeDecision: StructuredDecision | null = null;
  private readonly pendingPromises = new Map<string, Promise<string>>();
  private onDecisionChange?: () => void;

  constructor(options?: DecisionControllerOptions) {
    this.onDecisionChange = options?.onDecisionChange;
  }

  setOnDecisionChange(callback: () => void): void {
    this.onDecisionChange = callback;
  }

  /**
   * 查询当前是否存在活跃的决策
   */
  hasActiveDecision(): boolean {
    return this.activeDecision !== null;
  }

  /**
   * 获取当前活跃的决策
   */
  getActiveDecision(): StructuredDecision | null {
    return this.activeDecision;
  }

  /**
   * 获取所有挂起排队中的决策数量 (包括 active)
   */
  getPendingCount(): number {
    return (this.activeDecision ? 1 : 0) + this.queue.length;
  }

  /**
   * 发起一个结构化决策请求，返回用户最终选中的 optionId (内置防重幂等机制)
   */
  requestDecision<TResult = any>(input: CreateDecisionInput<TResult>): Promise<string> {
    const id = input.id ?? `dec-${crypto.randomUUID().slice(0, 8)}`;

    // 1. 按 ID 幂等去重：若相同 id 的决策正在排队或处于 active，直接复用既有 Promise
    if (this.pendingPromises.has(id)) {
      return this.pendingPromises.get(id)!;
    }

    // 2. 按 planId 强不变量去重：同一 planId 在未决前最多只允许存在 1 个 plan-approval Decision
    const planId = (input.metadata as any)?.plan?.planId;
    if (input.kind === "plan-approval" && planId) {
      for (const [existingId, promise] of this.pendingPromises.entries()) {
        const existingDec =
          this.activeDecision?.id === existingId
            ? this.activeDecision
            : this.queue.find((d) => d.id === existingId);
        if (
          existingDec &&
          existingDec.kind === "plan-approval" &&
          (existingDec.metadata as any)?.plan?.planId === planId
        ) {
          return promise;
        }
      }
    }

    const defaultIndex = Math.max(
      0,
      Math.min(input.defaultIndex ?? 0, Math.max(0, input.options.length - 1))
    );

    const promise = new Promise<string>((resolve, reject) => {
      const decision: StructuredDecision<TResult> = {
        id,
        kind: input.kind,
        title: input.title,
        description: input.description,
        options: [...input.options],
        selectedIndex: defaultIndex,
        metadata: input.metadata ? { ...input.metadata } : undefined,
        resolve: (optionId) => {
          this.pendingPromises.delete(id);
          resolve(optionId);
        },
        reject: (err) => {
          this.pendingPromises.delete(id);
          reject(err);
        },
        onCancel: input.onCancel,
        createdAt: Date.now(),
      };

      this.queue.push(decision);
      this.processNext();
    });

    this.pendingPromises.set(id, promise);
    return promise;
  }

  /**
   * 处理队列中的下一个决策
   */
  private processNext(): void {
    if (this.activeDecision !== null) {
      return;
    }

    if (this.queue.length > 0) {
      this.activeDecision = this.queue.shift() ?? null;
    } else {
      this.activeDecision = null;
    }
    this.notifyChange();
  }

  /**
   * 向上选择前一个选项 (↑)
   */
  selectPrevious(): boolean {
    if (!this.activeDecision || this.activeDecision.options.length === 0) {
      return false;
    }

    const count = this.activeDecision.options.length;
    this.activeDecision.selectedIndex =
      (this.activeDecision.selectedIndex - 1 + count) % count;
    this.notifyChange();
    return true;
  }

  /**
   * 向下选择下一个选项 (↓)
   */
  selectNext(): boolean {
    if (!this.activeDecision || this.activeDecision.options.length === 0) {
      return false;
    }

    const count = this.activeDecision.options.length;
    this.activeDecision.selectedIndex =
      (this.activeDecision.selectedIndex + 1) % count;
    this.notifyChange();
    return true;
  }

  /**
   * 确认当前高亮的选项 (Enter)
   */
  confirmSelected(): string | null {
    if (!this.activeDecision || this.activeDecision.options.length === 0) {
      return null;
    }

    const current = this.activeDecision;
    const selectedOption = current.options[current.selectedIndex];
    if (!selectedOption) {
      return null;
    }

    this.activeDecision = null;
    current.resolve(selectedOption.id);
    this.processNext();
    return selectedOption.id;
  }

  cancelDecision(id: string): boolean {
    if (this.activeDecision?.id === id) return this.cancelActive();
    const index = this.queue.findIndex(decision => decision.id === id);
    if (index < 0) return false;
    const [decision] = this.queue.splice(index, 1);
    decision!.resolve(decision!.options.find(option => option.id === "deny" || option.id === "cancel")?.id ?? "cancel");
    this.notifyChange();
    return true;
  }

  /**
   * 取消当前决策 (Esc)
   */
  cancelActive(): boolean {
    if (!this.activeDecision) {
      return false;
    }

    const current = this.activeDecision;
    this.activeDecision = null;

    if (current.onCancel) {
      try {
        current.onCancel();
      } catch {}
    }

    // 若选项中包含显式的 cancel 或 deny，优先 resolve 为该选项；否则 reject
    const cancelOption = current.options.find(
      (o) => o.id === "cancel" || o.id === "deny"
    );
    if (cancelOption) {
      current.resolve(cancelOption.id);
    } else {
      current.reject(new DOMException("Decision cancelled by user", "AbortError"));
    }

    this.processNext();
    return true;
  }

  /**
   * 根据快捷键直接触发指定选项（如 'y', 'n', 'a', 'r', 'c'）
   */
  handleShortcut(key: string): string | null {
    if (!this.activeDecision) {
      return null;
    }

    const lowerKey = key.toLowerCase();
    const matchedOption = this.activeDecision.options.find(
      (o) => o.shortcut?.toLowerCase() === lowerKey
    );

    if (!matchedOption) {
      return null;
    }

    const current = this.activeDecision;
    this.activeDecision = null;
    current.resolve(matchedOption.id);
    this.processNext();
    return matchedOption.id;
  }

  /**
   * 中断或清理所有排队的决策（如用户 Ctrl+C）
   */
  abortAll(reason = "Aborted"): void {
    this.pendingPromises.clear();
    if (this.activeDecision) {
      const current = this.activeDecision;
      this.activeDecision = null;
      if (current.onCancel) {
        try {
          current.onCancel();
        } catch {}
      }
      current.reject(new DOMException(reason, "AbortError"));
    }

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        if (item.onCancel) {
          try {
            item.onCancel();
          } catch {}
        }
        item.reject(new DOMException(reason, "AbortError"));
      }
    }

    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.onDecisionChange) {
      try {
        this.onDecisionChange();
      } catch {}
    }
  }
}
