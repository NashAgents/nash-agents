import { test } from "node:test";
import assert from "node:assert/strict";
import { scopedExecutionTasks, executionSummary, type ExecutionTask } from "../apps/web/src/services/task-monitor.js";

const task = (taskId: string, nodeId: string, status = "running"): ExecutionTask => ({ taskId, nodeId, status, isScout: true, createdAt: 100 });

test("三节点 Scout 按节点展示全部任务，不能因为最后一个任务或完成收缩成单节点", () => {
  const tasks = [task("linux", "Linux"), task("wsl", "WSL", "completed"), task("mac", "Mac")];
  const summary = executionSummary(tasks);
  assert.equal(summary.title, "多节点探查监控");
  assert.equal(summary.groups.length, 3); assert.equal(summary.completed, 1);
  assert.equal(summary.status.label, "执行中");
  const ended = tasks.map(task => ({ ...task, status: "completed" }));
  assert.equal(executionSummary(ended).groups.length, 3);
  assert.equal(executionSummary(ended).status.label, "已完成");
  assert.equal(executionSummary(ended, true).status.label, "正在汇总");
});

test("多轮同节点任务按物理节点去重；失败、审批、结果未知保留真实语义", () => {
  const sameNode = [task("first", "Mac"), task("second", "Mac", "completed")];
  assert.equal(executionSummary(sameNode).groups.length, 1);
  assert.equal(executionSummary(sameNode).title, "探查任务监控");
  for (const [status, label] of [["failed", "存在失败"], ["waiting_approval", "等待审批"], ["outcome_unknown", "结果待确认"], ["cancelled", "已取消"]]) {
    assert.equal(executionSummary([task("one", "Mac", status)]).status.label, label);
  }
  assert.equal(executionSummary([task("one", "Mac", "unknown")], true).status.label, "状态待确认");
});

test("会话、草稿和本轮隔离；去重合并实时状态，同时保留历史仍在执行的任务", () => {
  const conversation = { linkedTaskIds: ["old", "still-running", "new"], messages: [{ sender: "user", timestamp: 200 }] };
  const tasks = [task("old", "Linux", "completed"), task("still-running", "WSL"), { ...task("new", "Mac"), createdAt: 201 },
    { ...task("new", "Mac", "completed"), createdAt: 201 }, task("foreign", "Other")];
  const visible = scopedExecutionTasks(conversation, tasks);
  assert.deepEqual(visible.map(task => task.taskId), ["still-running", "new"]);
  assert.equal(visible[1].status, "completed");
  assert.deepEqual(scopedExecutionTasks({ messages: [] }, tasks), []);
});
