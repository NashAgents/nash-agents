import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore, type ClusterTaskRecord } from "../src/cluster/storage/cluster-store.js";
import type { SequencedEvent } from "../src/cluster/protocol/types.js";

describe("Nash Cluster Storage & Task State Lifecycle", () => {
  it("应正确保存、更新和查询 Task 状态生命周期", async () => {
    const store = new InMemoryClusterStore();

    const task: ClusterTaskRecord = {
      taskId: "task-1001",
      nodeId: "node-worker-1",
      projectId: "proj-nash",
      goal: "Run test suite",
      status: "created",
      dispatchAttempt: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.saveTask(task);
    const loaded = await store.getTask("task-1001");
    assert.ok(loaded);
    assert.equal(loaded.status, "created");

    // 流转为 running
    await store.updateTaskStatus("task-1001", "running", { resultSummary: "Test in progress" });
    const running = await store.getTask("task-1001");
    assert.equal(running?.status, "running");
    assert.equal(running?.resultSummary, "Test in progress");

    // 流转为 completed
    await store.updateTaskStatus("task-1001", "completed", { finalAnswer: "All 775 tests passed!" });
    const completed = await store.getTask("task-1001");
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.finalAnswer, "All 775 tests passed!");
    assert.ok(completed?.completedAt);
  });

  it("应保证任务事件按 seq 单调持久化，并幂等忽略重复 seq", async () => {
    const store = new InMemoryClusterStore();
    const taskId = "task-seq-test";

    const events: SequencedEvent[] = [
      { seq: 1, taskId, runId: "r1", nodeId: "n1", eventType: "task.started", timestamp: 100, data: {} },
      { seq: 2, taskId, runId: "r1", nodeId: "n1", eventType: "tool.started", timestamp: 105, data: { toolName: "bash" } },
      { seq: 3, taskId, runId: "r1", nodeId: "n1", eventType: "tool.completed", timestamp: 110, data: { toolName: "bash" } },
    ];

    const insertedCount = await store.appendEvents(events);
    assert.equal(insertedCount, 3);

    // 重复插入相同 seq 2，应被幂等忽略
    const duplicateEvent: SequencedEvent = {
      seq: 2,
      taskId,
      runId: "r1",
      nodeId: "n1",
      eventType: "tool.started",
      timestamp: 105,
      data: { toolName: "bash" },
    };
    const dupCount = await store.appendEvents([duplicateEvent]);
    assert.equal(dupCount, 0);

    const retrieved = await store.getEventsForTask(taskId, 1, 10);
    assert.equal(retrieved.length, 3);
    assert.deepEqual(retrieved.map((e) => e.seq), [1, 2, 3]);
  });

  it("Outbox 与 Inbox 机制应支持投递队列与幂等去重", async () => {
    const store = new InMemoryClusterStore();

    // 1. Inbox 去重
    const isFirst = await store.checkAndRecordInbox("msg-uniq-1", "node-1");
    assert.equal(isFirst, true);

    const isSecond = await store.checkAndRecordInbox("msg-uniq-1", "node-1");
    assert.equal(isSecond, false); // 重复消息应拦截

    // 2. Outbox 投递与确认
    await store.enqueueOutbox({
      targetNodeId: "node-2",
      messageId: "msg-out-1",
      messageType: "task.dispatch",
      payload: { taskId: "t1" },
      status: "pending",
      attempts: 1,
      nextRetryAt: 0,
      createdAt: Date.now(),
    });

    const pending = await store.pollPendingOutbox(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].messageId, "msg-out-1");

    await store.markOutboxSent("msg-out-1");
    const pendingAfter = await store.pollPendingOutbox(10);
    assert.equal(pendingAfter.length, 0);
  });

  it("Remote Approval 应支持保存、查询与决议", async () => {
    const store = new InMemoryClusterStore();

    await store.saveApproval({
      approvalId: "appr-1",
      taskId: "task-1",
      runId: "run-1",
      nodeId: "node-1",
      agentId: "main",
      capability: "filesystem-write",
      reason: "Need to write output.txt",
      target: "/path/to/output.txt",
      status: "pending",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60000,
    });

    const pending = await store.listPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].approvalId, "appr-1");

    const resolved = await store.resolveApproval("appr-1", "allow-once", "admin-cli");
    assert.equal(resolved, true);

    const updated = await store.getApproval("appr-1");
    assert.equal(updated?.status, "resolved");
    assert.equal(updated?.decision, "allow-once");
    assert.equal(updated?.resolvedBy, "admin-cli");
  });
});
