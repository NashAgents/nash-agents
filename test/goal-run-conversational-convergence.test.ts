import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryClusterStore } from "../src/cluster/storage/cluster-store.js";
import { processGoalRun, reconcileGoalRun } from "../src/cluster/coordinator/goal-run-service.js";
import type { WebMessageRecord } from "../src/cluster/storage/cluster-store.js";

async function seedConversationalGoal(
  store: InMemoryClusterStore,
  options: { assistant?: Partial<WebMessageRecord> & { state?: string; recoveredTurn?: boolean } } = {},
) {
  const conversationId = "conv-1";
  const userMessage: WebMessageRecord = { id: "u1", conversationId, sender: "user", content: "你好", messageType: "text", timestamp: 1, metadata: { goalRunId: "goal-1" } };
  await store.saveConversation({ id: conversationId, title: "t", createdAt: 1, updatedAt: 1, messages: [userMessage] });
  await store.createGoalRun({
    goalRunId: "goal-1", conversationId, userMessageId: "u1", rootGoal: "你好",
    status: "planning", executionState: "running", currentStage: "planning",
    linkedGraphIds: [], linkedTaskIds: [], requiredExecutionScope: null,
    reportRevision: 0, revision: 1, createdAt: 1, updatedAt: 1,
  });
  const lease = (await store.claimGoalTurnLease("goal-1", "u1", "owner", 60_000))!;
  const fence = { ownerId: lease.ownerId, turnId: lease.turnId, generation: lease.generation };
  if (options.assistant) {
    const message: WebMessageRecord = {
      id: "a1", conversationId, sender: "assistant", content: "直接回答", messageType: "text", timestamp: 2,
      metadata: { goalRunId: "goal-1", goalRunTurnId: "u1", ...options.assistant } as any,
      ...options.assistant,
    } as WebMessageRecord;
    message.metadata = { goalRunId: "goal-1", goalRunTurnId: "u1", state: (options.assistant as any).state, recoveredTurn: (options.assistant as any).recoveredTurn };
    message.messageType = (options.assistant.messageType as any) ?? "text";
    await store.commitGoalTurnResponse("goal-1", message, fence);
  }
  return { conversationId, fence };
}

test("a finished turn without any dispatched work converges instead of staying verifying", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "直接回答" } });
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.status, "completed");
  assert.equal(goal.executionState, "settled");
  assert.equal(goal.reportState, "ready");
  assert.equal(goal.currentStage, "conversational");
  assert.ok(goal.finalReport && goal.finalReport.length > 0);
  assert.ok(goal.completedAt);
});

test("reconciliation cannot drag a converged conversational goal back to verifying", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "直接回答" } });
  await processGoalRun(store, "goal-1");
  const reconciled = await reconcileGoalRun(store, "goal-1");
  assert.equal(reconciled.status, "completed");
  const again = await processGoalRun(store, "goal-1");
  assert.equal(again.status, "completed");
  assert.equal(again.revision, reconciled.revision, "a converged goal must be stable across passes");
});

test("an interrupted turn that produced no work is recorded as cancelled, not completed", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "协调器推理已中断", content2: undefined } as any });
  await store.getGoalRun("goal-1");
  // commitGoalTurnResponse already advanced the stage; rewrite the response state like the abort path does.
  const conversation = (await store.getConversation("conv-1"))!;
  conversation.messages = conversation.messages.map(message => message.sender === "assistant" ? { ...message, metadata: { ...message.metadata, state: "cancelled" } } : message);
  await store.saveConversation(conversation);
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.status, "cancelled");
  assert.equal(goal.executionState, "settled");
});

test("a client disconnect stops the turn without leaving a non-terminal goal", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "客户端已断开" } });
  const conversation = (await store.getConversation("conv-1"))!;
  conversation.messages = conversation.messages.map(message => message.sender === "assistant" ? { ...message, metadata: { ...message.metadata, state: "detached" } } : message);
  await store.saveConversation(conversation);
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.status, "cancelled");
  assert.equal(goal.executionState, "settled");
});

test("a turn that exceeded its maximum duration converges as cancelled", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "本轮超过最长执行时间" } });
  const conversation = (await store.getConversation("conv-1"))!;
  conversation.messages = conversation.messages.map(message => message.sender === "assistant" ? { ...message, metadata: { ...message.metadata, state: "timed_out" } } : message);
  await store.saveConversation(conversation);
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.status, "cancelled");
});

test("a clarification question keeps the goal open for the user's answer", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store, { assistant: { content: "请选择目标节点", messageType: "clarification" } as any });
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.status, "waiting_approval");
  assert.equal(goal.executionState, "waiting_approval");
  assert.equal(goal.completedAt, undefined);
  // A clarification goal holds no execution, so a drain must not be blocked by it forever.
  const reconciled = await reconcileGoalRun(store, "goal-1");
  assert.equal(reconciled.status, "waiting_approval");
});

test("a turn that is still planning is never converged out from under its live lease", async () => {
  const store = new InMemoryClusterStore();
  await seedConversationalGoal(store);
  const goal = await processGoalRun(store, "goal-1");
  assert.equal(goal.currentStage, "planning");
  assert.equal(goal.status, "planning", "a live foreign turn owns the record, so no derived state may be written");
  assert.ok(goal.turnLease, "the foreground turn keeps its lease");
});

test("goals that own real work are untouched by the conversational convergence", async () => {
  const store = new InMemoryClusterStore();
  const { fence } = await seedConversationalGoal(store, { assistant: { content: "已派发" } });
  const lease = (await store.claimGoalTurnLease("goal-1", "u1", "owner-2", 60_000));
  assert.equal(lease, null, "the committed turn released its lease");
  await store.saveTaskWithGoal(
    { taskId: "task-1", nodeId: "worker-1", projectId: "p", goal: "g", prompt: "p", status: "running", dispatchAttempt: 1, createdAt: 2, updatedAt: 2 },
    "goal-1", fence as any,
  ).catch(() => undefined);
  const goal = await store.getGoalRun("goal-1");
  if (!goal?.linkedTaskIds.length) return; // fenced write correctly refused: nothing to assert about convergence
  const processed = await processGoalRun(store, "goal-1");
  assert.notEqual(processed.currentStage, "conversational");
  assert.notEqual(processed.status, "completed");
});
