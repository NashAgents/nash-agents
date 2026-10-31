import type { IClusterStore } from "../storage/cluster-store.js";
import type { RemoteApprovalExpiredPayload } from "../protocol/types.js";

export interface ApprovalExpiryResult {
  approvalId: string;
  taskId: string;
  /** 任务是否从 waiting_approval 恢复到 running（Worker 仍在继续执行，只是本次操作被拒绝）。 */
  resumed: boolean;
  /** 审批此前已经被裁决，本次消息只是重复投递。 */
  alreadyResolved: boolean;
}

/**
 * 应用 Worker 上报的审批超时（approval.expired）。
 *
 * 持久化记录必须从 pending 收敛为 resolved/deny，否则 UI 侧
 * `listPendingApprovals()` 会因 expires_at <= now 直接过滤掉它，
 * 而任务仍然停留在 waiting_approval —— 记录消失但任务永远悬挂。
 *
 * 返回 null 表示归属校验失败（审批不存在或 task/run/node 不匹配）。
 */
export async function applyWorkerApprovalExpiry(
  store: IClusterStore,
  payload: RemoteApprovalExpiredPayload,
): Promise<ApprovalExpiryResult | null> {
  const approval = await store.getApproval(payload.approvalId);
  if (
    !approval ||
    approval.taskId !== payload.taskId ||
    approval.runId !== payload.runId ||
    approval.nodeId !== payload.nodeId
  ) {
    return null;
  }

  if (approval.status !== "pending") {
    return { approvalId: payload.approvalId, taskId: payload.taskId, resumed: false, alreadyResolved: true };
  }

  await store.resolveApproval(payload.approvalId, "deny", payload.reason || "worker-timeout");

  const task = await store.getTask(payload.taskId);
  let resumed = false;
  if (task?.status === "waiting_approval") {
    await store.updateTaskStatus(payload.taskId, "running");
    resumed = true;
  }

  return { approvalId: payload.approvalId, taskId: payload.taskId, resumed, alreadyResolved: false };
}
