// 轮次中止语义：客户端断开 / 超时 只停止协调器等待，不能伪装成「用户手动取消」。
// 生产验收发现：断开后助手消息被标记为 cancelled 并提示“用户手动取消”，而 Worker 任务仍在运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { turnAbortOutcome } from "../src/cluster/coordinator/main-agent/coordinator-main-agent.js";

test("client disconnect is reported as detached, never as a user cancellation", () => {
  const outcome = turnAbortOutcome(new Error("Client disconnected from the conversation turn"));
  assert.equal(outcome.state, "detached");
  assert.match(outcome.message, /客户端已断开/);
  assert.doesNotMatch(outcome.message, /手动取消/);
});

test("watchdog expiry is reported as timed_out with the task still running", () => {
  const outcome = turnAbortOutcome(new Error("Turn exceeded maximum duration"));
  assert.equal(outcome.state, "timed_out");
  assert.match(outcome.message, /超过最长执行时间/);
  assert.match(outcome.message, /任务继续执行/);
});

test("only an explicit user cancel keeps the cancelled state", () => {
  for (const reason of [new Error("User cancelled conversation"), "User cancelled conversation", undefined]) {
    const outcome = turnAbortOutcome(reason);
    assert.equal(outcome.state, "cancelled");
    assert.match(outcome.message, /用户手动取消/);
  }
});
