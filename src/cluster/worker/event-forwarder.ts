import fs from "node:fs";
import type { SequencedEvent, EventBatchPayload } from "../protocol/types.js";
import { createEnvelope, encodeEnvelope, MAX_MESSAGE_SIZE_BYTES } from "../protocol/message-codec.js";
import type { WebSocket } from "ws";

export class WorkerEventForwarder {
  private currentSeq = 0;
  private pendingDelta?: { eventType: string; data: Record<string, unknown> };
  private readonly pendingEvents: SequencedEvent[] = [];
  private lastAckedSeq = 0;
  private flushTimer?: NodeJS.Timeout;
  private ws: WebSocket | null = null;

  constructor(
    private readonly taskId: string,
    private readonly runId: string,
    private readonly nodeId: string,
    private readonly coordinatorNodeId: string,
    private readonly flushIntervalMs = 500,
    private readonly persistencePath?: string
  ) {
    if (persistencePath && fs.existsSync(persistencePath)) {
      const saved = JSON.parse(fs.readFileSync(persistencePath, "utf8"));
      this.currentSeq = saved.currentSeq;
      this.lastAckedSeq = saved.lastAckedSeq;
      this.pendingEvents.push(...saved.pendingEvents);
    }
  }

  private persist(): void {
    if (!this.persistencePath) return;
    const temp = `${this.persistencePath}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ currentSeq: this.currentSeq, lastAckedSeq: this.lastAckedSeq, pendingEvents: this.pendingEvents }), { mode: 0o600, flush: true });
      fs.renameSync(temp, this.persistencePath);
    } finally { fs.rmSync(temp, { force: true }); }
  }

  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws;
    if (this.ws && this.pendingEvents.length > 0) {
      this.flush();
    }
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  /** Coalesce preview text before durable sequencing; all request/tool evidence retains exact ordering. */
  queueStreamDelta(eventType: string, data: Record<string, unknown>): void {
    const current = this.pendingDelta;
    if (current && (current.eventType !== eventType || current.data.agentId !== data.agentId || current.data.spanId !== data.spanId)) this.drainDelta();
    if (typeof data.delta !== "string") { this.emitEvent(eventType, data); return; }
    const previous = this.pendingDelta;
    this.pendingDelta = { eventType, data: { ...data, delta: String(previous?.data.delta ?? "") + data.delta } };
    if (String(this.pendingDelta.data.delta).length >= 4096) this.drainDelta();
  }

  private drainDelta(): void {
    const pending = this.pendingDelta;
    this.pendingDelta = undefined;
    if (pending) this.emitEvent(pending.eventType, pending.data);
  }

  /**
   * 记录并序号化新事件
   */
  emitEvent(eventType: string, data: Record<string, unknown>): SequencedEvent {
    this.drainDelta();
    const raw = JSON.stringify(data);
    if (Buffer.byteLength(raw) > MAX_MESSAGE_SIZE_BYTES / 2) {
      const spillPath = this.persistencePath ? `${this.persistencePath}.${this.currentSeq + 1}.overflow.json` : undefined;
      if (spillPath) fs.writeFileSync(spillPath, raw, { mode: 0o600, flush: true });
      data = { truncated: true, originalBytes: Buffer.byteLength(raw), spillPath, preview: raw.slice(0, 4000) };
      eventType = "event.overflow";
    }
    this.currentSeq += 1;
    const event: SequencedEvent = {
      seq: this.currentSeq,
      taskId: this.taskId,
      runId: this.runId,
      nodeId: this.nodeId,
      eventType,
      timestamp: Date.now(),
      data,
    };

    this.pendingEvents.push(event);
    this.persist();

    // 关键事件立即触发 flush
    if (["task.started", "task.completed", "task.failed", "approval.requested", "task.progress"].includes(eventType)) {
      this.flush();
    }

    return event;
  }

  /**
   * 处理 Coordinator 的确认回应
   */
  handleEventAck(lastAckedSeq: number): void {
    if (Number.isSafeInteger(lastAckedSeq) && lastAckedSeq > this.lastAckedSeq && lastAckedSeq <= this.currentSeq) {
      this.lastAckedSeq = lastAckedSeq;
      // 移除所有 seq <= lastAckedSeq 的已确认事件
      const unackedIndex = this.pendingEvents.findIndex((e) => e.seq > lastAckedSeq);
      if (unackedIndex === -1) {
        this.pendingEvents.length = 0;
      } else {
        this.pendingEvents.splice(0, unackedIndex);
      }
      this.persist();
      this.flush();
    }
  }

  /**
   * 立即刷新发送待投递事件
   */
  flush(): void {
    this.drainDelta();
    if (!this.ws || this.ws.readyState !== 1 || this.pendingEvents.length === 0) {
      return;
    }

    // 批量取未确认事件（最多单次 50 条）
    const batch: SequencedEvent[] = [];
    let bytes = 4096;
    for (const event of this.pendingEvents.slice(0, 50)) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event)) + 1;
      if (bytes + eventBytes > MAX_MESSAGE_SIZE_BYTES) break;
      batch.push(event);
      bytes += eventBytes;
    }
    if (!batch.length) return;
    const payload: EventBatchPayload = {
      taskId: this.taskId,
      runId: this.runId,
      nodeId: this.nodeId,
      events: batch,
    };

    const envelope = createEnvelope(
      "event.batch",
      payload,
      this.nodeId,
      this.coordinatorNodeId
    );

    try {
      this.ws.send(encodeEnvelope(envelope));
    } catch (err) {
      console.warn(`[WorkerEventForwarder] Failed to flush events over WSS:`, err);
    }
  }

  getPendingCount(): number {
    return this.pendingEvents.length;
  }
}
