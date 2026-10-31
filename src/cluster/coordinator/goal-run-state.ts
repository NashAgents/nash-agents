import type { GoalRunRecord, ClusterTaskStatus } from "../storage/cluster-store-types.js";
import type { GraphStatus } from "../graph/types.js";

/** A task's terminal state alone is not proof that the user's goal was verified. */
export function aggregateGoalRunState(input: {
  tasks: Array<ClusterTaskStatus | "missing">;
  graphs: Array<GraphStatus | "missing">;
  turnFinished: boolean;
  verification: "pending" | "passed" | "partial" | "failed";
}): GoalRunRecord["status"] {
  const states: string[] = [...input.tasks, ...input.graphs];
  if (states.includes("outcome_unknown") || states.includes("missing")) return "outcome_unknown";
  if (states.includes("waiting_approval")) return "waiting_approval";
  if (states.includes("replanning")) return "recovering";
  if (!input.turnFinished || states.some(s => ["created", "queued", "dispatched", "accepted", "running", "interrupting", "cancelling", "planning", "ready", "paused", "blocked"].includes(s))) return "running";
  if (states.includes("cancelled")) return "cancelled";
  if (input.verification === "pending") return "verifying";
  // An empty state list must never be vacuously "completed": verification alone is not coverage.
  if (input.verification === "passed" && states.length > 0 && states.every(s => s === "completed")) return "completed";
  if (input.verification === "failed" || (states.length > 0 && states.every(s => s === "failed"))) return "failed";
  return "partially_completed";
}
