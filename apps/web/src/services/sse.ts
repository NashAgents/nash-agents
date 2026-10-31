/**
 * Shared SSE Service for Nash Web Control Plane
 * 统一管理长连接、断线重连、去重与多页面事件广播
 */

export type SSEHandler = (event: { type: string; data: any; id?: string }) => void;

const activeConnections = new Set<SseConnection>();
const connectionPool = new Map<string, SseConnection>();

export function closeAllSseConnections() {
  for (const connection of [...activeConnections]) connection.close();
  connectionPool.clear();
}

export function getSharedSseConnection(url: string): SseConnection {
  let conn = connectionPool.get(url);
  if (!conn) {
    conn = new SseConnection(url);
    connectionPool.set(url, conn);
  }
  return conn;
}

export class SseConnection {
  private eventSource: EventSource | null = null;
  private listeners = new Set<SSEHandler>();
  private reconnectTimer: any = null;
  private backoffMs = 1000;
  private isExplicitlyClosed = false;
  private lastEventId: string | null = null;

  constructor(private readonly url: string) {}

  /** 已处理的 SSE 事件 id（有界），用于断线重放时的去重。 */
  private readonly seenIds = new Set<string>();
  private readonly seenOrder: string[] = [];
  private static readonly SEEN_LIMIT = 2000;

  /** 返回 false 表示该 id 已处理过，应丢弃。 */
  private accept(id?: string): boolean {
    if (!id) return true;
    if (this.seenIds.has(id)) return false;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SseConnection.SEEN_LIMIT) {
      const evicted = this.seenOrder.shift();
      if (evicted) this.seenIds.delete(evicted);
    }
    return true;
  }

  connect() {
    this.closeEventSource();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.isExplicitlyClosed = false;
    activeConnections.add(this);

    const fullUrl = this.lastEventId
      ? `${this.url}${this.url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(this.lastEventId)}`
      : this.url;

    try {
      this.eventSource = new EventSource(fullUrl, { withCredentials: true });

      this.eventSource.onopen = () => {
        this.backoffMs = 1000;
        this.notify({ type: "transport.open", data: {} });
      };

      this.eventSource.onmessage = (e) => {
        // SSE 规范：没有自带 id 的帧（心跳/快照）会沿用上一个事件的 lastEventId。
        // 只有「id 发生变化」才说明本帧自带 id，才参与去重；否则会把心跳误杀。
        const ownId = e.lastEventId && e.lastEventId !== this.lastEventId ? e.lastEventId : undefined;
        if (ownId && !this.accept(ownId)) return;
        if (ownId) this.lastEventId = ownId;
        let data: any = e.data;
        try {
          data = JSON.parse(e.data);
        } catch {}

        const type = data?.eventType ?? data?.type ?? "message";
        // 协议控制帧拦截：关闭与重连保护
        if (type === "stream.ended" || data?.type === "stream.ended") {
          this.close();
          return;
        }
        if (type === "stream.connected" || data?.type === "stream.connected" || type.startsWith("stream.")) {
          return;
        }
        this.notify({ type, data: data?.eventType ? { ...data.data, taskId: data.taskId, runId: data.runId, seq: data.seq, timestamp: data.timestamp } : data,
          id: e.lastEventId || (data?.seq ? String(data.seq) : undefined) });
      };

      // 监听常见自定义事件类型
      const customEvents = [
        "cluster.snapshot",
        "cluster.heartbeat",
        "goal_run.updated",
        "task.started",
        "task.progress",
        "task.completed",
        "task.failed",
        "task.cancelled",
        "task.outcome_unknown",
        "graph.created",
        "graph.started",
        "graph.paused",
        "graph.resumed",
        "graph.node_ready",
        "graph.node_activity",
        "graph.task_dispatched",
        "graph.node_dispatched",
        "graph.node_waiting_approval",
        "graph.node_cancelled",
        "graph.node_skipped",
        "graph.node_completed",
        "graph.node_failed",
        "graph.node_blocked",
        "graph.replan_committed",
        "graph.replanned",
        "graph.replan_started",
        "graph.completed",
        "graph.cancelled",
        "graph.failed",
        "graph.partially_completed",
        "graph.outcome_unknown",
        "graph.end",
        "task.control_ack",
        "approval.requested",
        "approval.resolved",
        "task.grant_applied",
        "task.grant_revoked",
        "task.grant_unconfirmed",
        "coordinator.turn_started",
        "coordinator.turn_completed",
        "coordinator.turn_cancelled",
        "coordinator.turn_interrupted",
        "coordinator.task_dispatched",
        "coordinator.phase",
        "discovery.started",
        "discovery.scout_dispatched",
        "discovery.scout_completed",
        "discovery.scout_failed",
        "discovery.scout_outcome_unknown",
        "discovery.scout_wait_expired",
        "discovery.completed",
        "stream.reset",
        "conversation.task_linked",
        "conversation.message_created",
        "conversation.message_updated",
        "conversation.title_updated",
      ];

      for (const evtName of customEvents) {
        this.eventSource.addEventListener(evtName, (e: any) => {
          const ownId = e.lastEventId && e.lastEventId !== this.lastEventId ? e.lastEventId : undefined;
          if (ownId && !this.accept(ownId)) return;
          if (ownId) this.lastEventId = ownId;
          let data: any = e.data;
          try {
            data = JSON.parse(e.data);
          } catch {}
          if (evtName === "graph.end") { this.notify({ type: evtName, data, id: e.lastEventId }); this.close(); return; }
          this.notify({ type: evtName, data, id: e.lastEventId });
        });
      }

      this.eventSource.onerror = () => {
        if (this.isExplicitlyClosed) return;
        this.notify({ type: "transport.error", data: {} });
        this.closeEventSource();
        // 指数退避重连
        const delay = Math.min(this.backoffMs, 15000) + Math.random() * 500;
        this.backoffMs = Math.min(this.backoffMs * 1.5, 30000);
        this.reconnectTimer = setTimeout(() => {
          this.connect();
        }, delay);
      };
    } catch (err) {
      console.warn(`[SseConnection] Failed to open SSE to ${this.url}:`, err);
    }
  }

  subscribe(handler: SSEHandler): () => void {
    this.listeners.add(handler);
    if (!this.eventSource && !this.reconnectTimer) {
      this.connect();
    }
    return () => {
      this.listeners.delete(handler);
      if (this.listeners.size === 0) {
        this.close();
      }
    };
  }

  private notify(event: { type: string; data: any; id?: string }) {
    for (const h of this.listeners) {
      try {
        h(event);
      } catch (err) {
        console.error("[SseConnection] Error in listener:", err);
      }
    }
  }

  private closeEventSource() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  close() {
    this.isExplicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeEventSource();
    activeConnections.delete(this);
    this.notify({ type: "transport.closed", data: {} });
  }
}

// 全局单例集群 SSE
export const globalClusterSse = new SseConnection("/api/cluster/events/stream");

// 创建针对特定 Task 的流
export function createTaskSse(taskId: string): SseConnection {
  return new SseConnection(`/api/cluster/tasks/${taskId}/stream`);
}

// 创建针对特定 Graph 的流
export function createGraphSse(graphId: string): SseConnection {
  return new SseConnection(`/api/cluster/graphs/${graphId}/stream`);
}
