import type { HarnessEvent, HarnessEventType } from "./types.js";

export type EventSubscriber<T = any> = (event: HarnessEvent<T>) => void | Promise<void>;

/**
 * EventBus：轻量级、强类型事件分发总线
 * 遵循 Fail-Safe 与 Best-Effort 原则：任何 Subscriber 抛出的异常均被内部捕获隔离，绝不影响 Agent 主逻辑
 */
export class EventBus {
  private readonly subscribers = new Map<string, Set<EventSubscriber>>();

  /**
   * 订阅指定类型事件，或使用 "*" 订阅全部事件
   * @returns 取消订阅函数 (unsubscribe)
   */
  subscribe<T = any>(
    type: HarnessEventType | "*",
    subscriber: EventSubscriber<T>
  ): () => void {
    let set = this.subscribers.get(type);
    if (!set) {
      set = new Set();
      this.subscribers.set(type, set);
    }
    set.add(subscriber as EventSubscriber);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const currentSet = this.subscribers.get(type);
      if (currentSet) {
        currentSet.delete(subscriber as EventSubscriber);
        if (currentSet.size === 0) {
          this.subscribers.delete(type);
        }
      }
    };
  }

  /**
   * 同步/异步广播事件给所有匹配的订阅者
   */
  emit<T = Record<string, unknown>>(event: HarnessEvent<T>): void {
    const specificSubscribers = this.subscribers.get(event.type);
    const wildcardSubscribers = this.subscribers.get("*");

    const allSubscribers: EventSubscriber[] = [];
    if (specificSubscribers) {
      for (const sub of specificSubscribers) {
        allSubscribers.push(sub);
      }
    }
    if (wildcardSubscribers) {
      for (const sub of wildcardSubscribers) {
        allSubscribers.push(sub);
      }
    }

    for (const subscriber of allSubscribers) {
      try {
        const res = subscriber(event);
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch((_err: unknown) => {
            // best-effort 忽略异步 subscriber 异常
          });
        }
      } catch (_err: unknown) {
        // best-effort 忽略同步 subscriber 异常
      }
    }
  }

  /**
   * 清除所有订阅者，防止引用泄漏
   */
  clear(): void {
    this.subscribers.clear();
  }

  /**
   * 获取当前订阅者数量
   */
  get subscriberCount(): number {
    let count = 0;
    for (const set of this.subscribers.values()) {
      count += set.size;
    }
    return count;
  }
}
