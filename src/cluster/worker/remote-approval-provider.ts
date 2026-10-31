import * as crypto from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalProvider,
  ApprovalRequest,
} from "../../approval/types.js";
import { createEnvelope, encodeEnvelope } from "../protocol/message-codec.js";
import type { RemoteApprovalExpiredPayload, RemoteApprovalRequestPayload } from "../protocol/types.js";
import type { WebSocket } from "ws";

export const DEFAULT_APPROVAL_TIMEOUT_MS = 300000;
const MIN_APPROVAL_TIMEOUT_MS = 1000;
const MAX_APPROVAL_TIMEOUT_MS = 3600000;

export class RemoteApprovalProvider implements ApprovalProvider {
  private readonly pendingResolvers = new Map<string, (decision: ApprovalDecision) => void>();
  private ws: WebSocket | null = null;
  private readonly pendingRequests = new Map<string, RemoteApprovalRequestPayload>();
  private readonly approvalTimeoutMs: number;

  constructor(
    private readonly taskId: string,
    private readonly runId: string,
    private readonly nodeId: string,
    private readonly coordinatorNodeId: string,
    approvalTimeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS
  ) {
    this.approvalTimeoutMs = Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs >= MIN_APPROVAL_TIMEOUT_MS
      ? Math.min(approvalTimeoutMs, MAX_APPROVAL_TIMEOUT_MS)
      : DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  setWebSocket(ws: WebSocket | null): void {
    this.ws = ws;
    for (const payload of this.pendingRequests.values()) this.resend(payload);
  }

  /**
   * 审批等待超时：裁决 Fail-Closed 为 deny，并显式通知 Coordinator 收敛持久化记录。
   * 若通知发送失败，本地仍然 deny；Coordinator 侧还有过期扫描作为兜底。
   */
  private notifyExpired(payload: RemoteApprovalRequestPayload): void {
    const expired: RemoteApprovalExpiredPayload = {
      approvalId: payload.approvalId,
      taskId: payload.taskId,
      runId: payload.runId,
      nodeId: this.nodeId,
      decision: "deny",
      reason: "worker-timeout",
      resolvedAt: Date.now(),
    };
    if (!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(encodeEnvelope(createEnvelope("approval.expired", expired, this.nodeId, this.coordinatorNodeId)));
    } catch {
      // 通知失败不改变本地 Fail-Closed 结论；Coordinator 过期扫描仍会收敛记录。
    }
  }

  private resend(payload: RemoteApprovalRequestPayload): void {
    if (!this.ws || this.ws.readyState !== 1 || payload.expiresAt <= Date.now()) return;
    try { this.ws.send(encodeEnvelope(createEnvelope("approval.requested", payload, this.nodeId, this.coordinatorNodeId))); } catch {}
  }

  /**
   * 实现 ApprovalProvider.askApproval
   */
  async askApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const approvalId = request.id ?? `appr-${crypto.randomUUID().slice(0, 8)}`;
    const expiresAt = Date.now() + this.approvalTimeoutMs;

    const payload: RemoteApprovalRequestPayload = {
      approvalId,
      taskId: this.taskId,
      runId: this.runId,
      nodeId: this.nodeId,
      agentId: request.agentId ?? "main",
      agentName: request.agentName ?? "Main",
      capability: request.capability,
      reason: request.reason,
      target: request.target,
      toolName: request.toolName,
      toolArgsSummary: request.toolArgsSummary,
      createdAt: Date.now(),
      expiresAt,
    };

    const envelope = createEnvelope(
      "approval.requested",
      payload,
      this.nodeId,
      this.coordinatorNodeId
    );

    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(encodeEnvelope(envelope));
      } catch (err) {
        console.warn(`[RemoteApprovalProvider] Failed to send approval request:`, err);
        return "deny";
      }
    } else {
      console.warn(`[RemoteApprovalProvider] WebSocket offline, defaulting to deny for safety`);
      return "deny";
    }

    return new Promise<ApprovalDecision>((resolve) => {
      let timeoutTimer: NodeJS.Timeout | undefined;
      const retryTimer = setInterval(() => this.resend(payload), 5000);
      retryTimer.unref();

      const finish = (decision: ApprovalDecision) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        clearInterval(retryTimer);
        this.pendingResolvers.delete(approvalId);
        this.pendingRequests.delete(approvalId);
        resolve(decision);
      };

      timeoutTimer = setTimeout(() => {
        console.warn(`[RemoteApprovalProvider] Approval ${approvalId} timed out, failing closed to deny`);
        this.notifyExpired(payload);
        finish("deny");
      }, this.approvalTimeoutMs);

      this.pendingResolvers.set(approvalId, finish);
      this.pendingRequests.set(approvalId, payload);
    });
  }

  /**
   * 收到 Coordinator 传回的审批裁决结果
   */
  cancelPending(): void {
    for (const resolver of this.pendingResolvers.values()) resolver("deny");
  }

  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const resolver = this.pendingResolvers.get(approvalId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  }
}
