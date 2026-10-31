import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateGoalRunState } from "../src/cluster/coordinator/goal-run-state.js";

test("goal state waits for every required task and verification", () => {
  const base = { graphs: ["partially_completed" as const], turnFinished: true, verification: "partial" as const };
  assert.equal(aggregateGoalRunState({ ...base, tasks: ["completed", "running"] }), "running");
  assert.equal(aggregateGoalRunState({ ...base, tasks: ["completed", "waiting_approval"] }), "waiting_approval");
  assert.equal(aggregateGoalRunState({ ...base, tasks: ["completed", "outcome_unknown"] }), "outcome_unknown");
  assert.equal(aggregateGoalRunState({ ...base, tasks: ["completed", "failed"] }), "partially_completed");
  assert.equal(aggregateGoalRunState({ graphs: ["completed"], tasks: ["completed"], turnFinished: true, verification: "pending" }), "verifying");
  assert.equal(aggregateGoalRunState({ graphs: ["completed"], tasks: ["completed"], turnFinished: true, verification: "passed" }), "completed");
});
