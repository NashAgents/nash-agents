import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskStateProjection } from "../src/cluster/coordinator/state-projection.js";
import type { ClusterTaskRecord } from "../src/cluster/storage/cluster-store.js";
import type { SequencedEvent } from "../src/cluster/protocol/types.js";

describe("Nash Cluster TaskStateProjection", () => {
  it("应将底层事件流正确投影为可视任务状态", () => {
    const task: ClusterTaskRecord = {
      taskId: "task-proj-1",
      nodeId: "node-mac",
      projectId: "proj-nash",
      goal: "Inspect MCP and execute tests",
      status: "running",
      dispatchAttempt: 1,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const events: SequencedEvent[] = [
      { seq: 1, taskId: "task-proj-1", runId: "r1", nodeId: "node-mac", eventType: "task.started", timestamp: 1010, data: {} },
      { seq: 2, taskId: "task-proj-1", runId: "r1", nodeId: "node-mac", eventType: "tool.started", timestamp: 1050, data: { toolName: "read_file" } },
      { seq: 3, taskId: "task-proj-1", runId: "r1", nodeId: "node-mac", eventType: "tool.completed", timestamp: 1080, data: { toolName: "read_file" } },
      { seq: 4, taskId: "task-proj-1", runId: "r1", nodeId: "node-mac", eventType: "task.progress", timestamp: 1100, data: { currentStep: 2, activitySummary: "Executing bash command" } },
      { seq: 5, taskId: "task-proj-1", runId: "r1", nodeId: "node-mac", eventType: "tool.started", timestamp: 1120, data: { toolName: "bash" } },
    ];

    const projection = TaskStateProjection.project(task, events);

    assert.equal(projection.taskId, "task-proj-1");
    assert.equal(projection.nodeId, "node-mac");
    assert.equal(projection.status, "running");
    assert.equal(projection.currentStep, 2);
    assert.equal(projection.totalToolCalls, 2);
    assert.deepEqual(projection.recentTools, ["read_file", "bash"]);
    assert.equal(projection.currentActivity, "Executing tool: bash");
  });

  it("当包含 approval.requested 事件时应正确呈现 pendingApproval 字段", () => {
    const task: ClusterTaskRecord = {
      taskId: "task-proj-2",
      nodeId: "node-mac",
      projectId: "proj-nash",
      goal: "Write file outside workspace",
      status: "waiting_approval",
      dispatchAttempt: 1,
      createdAt: 1000,
      updatedAt: 1500,
    };

    const events: SequencedEvent[] = [
      {
        seq: 1,
        taskId: "task-proj-2",
        runId: "r2",
        nodeId: "node-mac",
        eventType: "approval.requested",
        timestamp: 1200,
        data: {
          approvalId: "appr-999",
          capability: "filesystem-outside-workspace",
          reason: "Writing logs to /var/log",
          target: "/var/log/audit.log",
        },
      },
    ];

    const projection = TaskStateProjection.project(task, events);
    assert.ok(projection.pendingApproval);
    assert.equal(projection.pendingApproval.approvalId, "appr-999");
    assert.equal(projection.pendingApproval.capability, "filesystem-outside-workspace");
    assert.ok(projection.currentActivity.includes("Waiting for user approval"));
  });
});
