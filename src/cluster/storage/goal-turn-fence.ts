import { ClusterStorageError, type GoalRunRecord, type GoalTurnFence } from "./cluster-store-types.js";
import { defaultTraceContext } from "../../observability/trace-context.js";

export class GoalTurnFenceError extends ClusterStorageError {}

/**
 * True when an unexpired foreground turn owns this GoalRun and the current trace is not that owner.
 * Derived-state writers (reconcilers, background replans) must then leave status and reports alone:
 * only the holder, or a post-turn pass after the lease expires, may rewrite them.
 */
export function ownedByForeignLiveTurn(goal: GoalRunRecord, now: number = Date.now()): boolean {
  if (!goal.turnLease || goal.turnLease.expiresAt <= now) return false;
  const trace = defaultTraceContext.get();
  const fence = trace?.goalRunId === goal.goalRunId ? trace?.goalTurnFence : undefined;
  if (!fence) return true;
  return fence.ownerId !== goal.turnLease.ownerId || fence.generation !== goal.turnLease.generation;
}

/** Validate the fence while holding the owning GoalRun's storage lock. */
export function assertGoalTurnFence(goal: GoalRunRecord, fence: GoalTurnFence | undefined, now: number): void {
  if (!goal.turnLeaseGeneration && !fence) return; // legacy records have no owner to fence
  const lease = goal.turnLease;
  if (!lease || !fence || lease.ownerId !== fence.ownerId || lease.turnId !== fence.turnId ||
      lease.generation !== fence.generation || lease.expiresAt <= now) {
    throw new GoalTurnFenceError("GoalRun turn lease expired or was superseded");
  }
}
