/**
 * 安全审查并发限流器 (Per-node Security Review Limiter)
 *
 * 背景：每个 Worker 任务各自创建 PreToolSecurityMonitor，一次并行工具轮次里
 * N 个任务 × M 个工具会同时打到同一个上游安全模型，触发 429/5xx 雪崩。
 * 节点级共享一个 ReviewLimiter 把真实模型审查的在途数量收敛到固定上限。
 *
 * 硬约束：
 * - 排队中的调用必须响应自己的 AbortSignal（用户取消/超时立即出队），不得悬挂；
 * - 限流只削减并发，绝不把任何 BLOCK / REQUIRE_APPROVAL 判定改写成 ALLOW。
 */

interface Waiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ReviewLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly maxInFlight: number;

  constructor(maxInFlight = 2) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) {
      throw new RangeError(`ReviewLimiter maxInFlight must be a positive integer, received ${maxInFlight}`);
    }
    this.maxInFlight = maxInFlight;
  }

  get limit(): number {
    return this.maxInFlight;
  }

  /** 当前持有槽位的审查数量。 */
  get inFlight(): number {
    return this.active;
  }

  /** 当前排队等待槽位的审查数量。 */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * 在限流保护下执行一次受保护操作。
   * 排队期间 signal 中止会立即以中止原因拒绝，且不会占用槽位。
   */
  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maxInFlight) {
      this.active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 槽位直接转交给下一个等待者，active 不变，避免出现瞬时超限。
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.resolve();
      return;
    }
    this.active--;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as { reason?: unknown }).reason ?? new DOMException("The operation was aborted.", "AbortError");
}
