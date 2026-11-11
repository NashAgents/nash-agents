import { test } from "node:test";
import assert from "node:assert/strict";
import { TeamRuntime } from "../src/team/team-runtime.js";
import { LeadWake } from "../src/team/lead-wake.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { SubAgentRuntime, type SubAgentResult, type SpawnSubAgentOptions } from "../src/agent/subagent-runtime.js";
import { AgentInterruptedError } from "../src/agent/errors.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { TaskManager } from "../src/task/task-manager.js";
import { createSubAgentTools, createTeamTools } from "../src/tools/orchestration/index.js";
import { PassThrough } from "node:stream";
import { InputManager } from "../src/cli/input-manager.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { EventBus } from "../src/observability/event-bus.js";

function fixture() {
  const agents = new AgentRegistry();
  const concurrency = new ConcurrencyController();
  const tasks = new TaskManager();
  const team = new TeamRuntime({name: "test", leaderId: "main", taskManager: tasks, agentRegistry: agents, concurrencyController: concurrency});
  const runtime = new SubAgentRuntime({agentRegistry: agents, concurrencyController: concurrency, taskManager: tasks});
  runtime.setTeamRuntime(team);
  return {agents, concurrency, tasks, team, runtime};
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return {promise, resolve};
}
const result = (agentId: string, output: string): SubAgentResult => ({agentId, output, success: true, durationMs: 1});

test("later dispatched member finishes first; wait_agent retains full output and notifications stay in original session", async t => {
  const {team, runtime, agents, tasks} = fixture(); t.after(() => team.destroy());
  const backend = deferred<SubAgentResult>(), frontend = deferred<SubAgentResult>();
  t.mock.method(runtime, "spawn", async (_prompt: string, options?: SpawnSubAgentOptions) => options?.agentId === "backend" ? backend.promise : frontend.promise);
  const tools = createSubAgentTools({subAgentRuntime: runtime, agentRegistry: agents, taskManager: tasks, agentId: "main"});
  const spawn = tools.find(x => x.name === "spawn_agent")!;
  // Explicit IDs exercise the same runtime path used by assign_task.
  runtime.spawnInBackground("backend", {agentId: "backend", taskId: "task-back", parentAgentId: "main", parentSessionId: "old"});
  runtime.spawnInBackground("frontend", {agentId: "frontend", taskId: "task-front", parentAgentId: "main", parentSessionId: "old"});
  const full = "F".repeat(4000);
  frontend.resolve(result("frontend", full));
  assert.equal((await runtime.waitForAgent("frontend"))?.output, full);
  assert.deepEqual(team.claimMessagesForStep("main", "new"), []);
  const first = team.claimMessagesForStep("main", "old");
  assert.equal(first.length, 1); assert.match(first[0]!.content, /frontend[\s\S]*task-front[\s\S]*completed/);
  assert.ok(first[0]!.content.length < 1000);
  team.mailbox.acknowledgeMessages("main", first.map(m => m.messageId));
  backend.resolve(result("backend", "backend result"));
  const wait = tools.find(x => x.name === "wait_agent")!;
  assert.match(String(await wait.execute({agentId: "backend", timeoutMs: 1000})), /backend result/);
  assert.match(team.claimMessagesForStep("main", "old")[0]!.content, /backend result/);
  assert.ok(spawn);
});

test("idle wake coalesces concurrent notices, defers old session, and stops at close", async t => {
  const {team} = fixture(); t.after(() => team.destroy());
  let session = "old", idle = false, scheduled = 0;
  let wake!: LeadWake;
  wake = new LeadWake(team, "main", () => session, () => { if (idle && wake.take()) scheduled++; });
  const send = (id: string, status: "completed" | "failed" | "interrupted" = "completed") => team.notifyBackgroundCompletion({executionId: id, agentId: id, parentAgentId: "main", parentSessionId: "old", status, summary: status});
  // Busy: completion does not start a second turn; pending is checked when becoming idle.
  send("one"); send("two", "failed"); send("two", "failed");
  assert.equal(scheduled, 0);
  session = "new"; idle = true; assert.equal(wake.take(), false);
  session = "old"; assert.equal(wake.take(), true); scheduled++;
  assert.equal(wake.take(), false);
  const messages = team.claimMessagesForStep("main", "old");
  assert.equal(messages.length, 2); assert.match(messages[1]!.content, /failed/);
  team.mailbox.acknowledgeMessages("main", messages.map(m => m.messageId));
  send("three", "interrupted"); assert.equal(scheduled, 2);
  wake.close(); send("four"); assert.equal(scheduled, 2); assert.equal(wake.take(), false);
  team.destroy(); send("five");
  assert.equal(team.mailbox.pendingNotificationIds("main", "old").includes("five"), false);
});

test("background failure and interruption notify and repeat delivery is suppressed after acknowledgement", async t => {
  const {team, runtime} = fixture(); t.after(() => team.destroy());
  t.mock.method(runtime, "spawn", async (_prompt: string, options?: SpawnSubAgentOptions) => { throw options?.agentId === "stop" ? new AgentInterruptedError("stop") : new Error("failure detail"); });
  runtime.spawnInBackground("", {agentId: "fail", parentAgentId: "main", parentSessionId: "s", taskId: "t"});
  runtime.spawnInBackground("", {agentId: "stop", parentAgentId: "main", parentSessionId: "s"});
  await Promise.all([runtime.waitForAgent("fail"), runtime.waitForAgent("stop")]);
  const messages = team.claimMessagesForStep("main", "s");
  assert.equal(messages.length, 2);
  assert.match(messages.find(m => m.senderAgentId === "fail")!.content, /failed[\s\S]*failure detail/);
  assert.match(messages.find(m => m.senderAgentId === "stop")!.content, /interrupted/);
  team.mailbox.acknowledgeMessages("main", messages.map(m => m.messageId));
  team.notifyBackgroundCompletion({executionId: messages[0]!.messageId, agentId: "fail", parentAgentId: "main", parentSessionId: "s", status: "failed", summary: "repeat"});
  assert.equal(team.mailbox.getUnreadCount("main", "s"), 0);
});

test("assign_task captures the caller session at dispatch", async t => {
  const {team, runtime, tasks} = fixture(); t.after(() => team.destroy());
  team.addMember({agentId: "worker", name: "worker", role: "dev", roleDescription: ""});
  tasks.createTask({id: "task", subject: "work"});
  const gate = deferred<SubAgentResult>();
  const mock = t.mock.method(runtime, "spawn", async () => gate.promise);
  const assign = createTeamTools({agentId: "main", teamRuntime: team, subAgentRuntime: runtime, taskManager: tasks}).find(x => x.name === "assign_task")!;
  await assign.execute({taskId: "task", agentId: "worker", background: true}, {sessionId: "original"});
  assert.equal(mock.mock.calls[0]!.arguments[1]?.parentSessionId, "original");
  gate.resolve(result("worker", "done")); await runtime.waitForAgent("worker");
  assert.equal(team.claimMessagesForStep("main", "other").length, 0);
  assert.equal(team.claimMessagesForStep("main", "original").length, 1);
});

test("claim rollback retries only the unacknowledged session messages", t => {
  const {team} = fixture(); t.after(() => team.destroy());
  for (const executionId of ["a", "b"]) team.notifyBackgroundCompletion({executionId, agentId: executionId, parentAgentId: "main", parentSessionId: "s", status: "completed", summary: "done"});
  const claimed = team.claimMessagesForStep("main", "s");
  team.mailbox.acknowledgeMessages("main", [claimed[0]!.messageId]);
  team.mailbox.nackMessages("main", claimed.map(m => m.messageId));
  assert.deepEqual(team.claimMessagesForStep("main", "s").map(m => m.messageId), ["b"]);
});

test("the notification ID selects an earlier execution after a member is reused", async t => {
  const {team, runtime} = fixture(); t.after(() => team.destroy());
  let run = 0;
  t.mock.method(runtime, "spawn", async () => result("worker", `result-${++run}`));
  const options = {agentId: "worker", parentAgentId: "main", parentSessionId: "s"};
  runtime.spawnInBackground("first", options);
  await runtime.waitForAgent("worker");
  const first = team.claimMessagesForStep("main", "s")[0]!;
  runtime.spawnInBackground("second", options);
  assert.equal((await runtime.waitForAgent("worker"))?.output, "result-2");
  assert.equal((await runtime.waitForAgent("worker", 1000, undefined, "main", first.messageId))?.output, "result-1");
  await assert.rejects(runtime.waitForAgent("other", 1000, undefined, "main", first.messageId));
});

test("wait_for_change ignores another session's completion and wakes for its own", async t => {
  const {team} = fixture(); t.after(() => team.destroy());
  const waiting = team.waitForChange("main", {sessionId: "active", timeoutMs: 1000});
  team.notifyBackgroundCompletion({executionId: "other", agentId: "worker", parentAgentId: "main", parentSessionId: "other", status: "completed", summary: "other"});
  team.notifyBackgroundCompletion({executionId: "active", agentId: "worker", parentAgentId: "main", parentSessionId: "active", status: "completed", summary: "active"});
  const change = await waiting;
  assert.equal(change.reason, "mail_received");
  assert.equal(change.details?.messageId, "active");
});

test("automatic run transition preserves an unsent composer draft and cursor", t => {
  const input = new PassThrough();
  const output = new PassThrough() as PassThrough & { isTTY: boolean; columns: number; rows: number };
  output.isTTY = true; output.columns = 100; output.rows = 30;
  const bus = new EventBus(), agents = new AgentRegistry({eventBus: bus});
  const presenter = new CliPresenter({eventBus: bus, agentRegistry: agents, stdout: output as any, isTTY: true});
  const manager = new InputManager({input: input as any, output: output as any, isTTY: true});
  t.after(() => { manager.close(); presenter.destroy(); input.destroy(); output.destroy(); });
  let draft = "", cursor = 0;
  const handler = {onComposerChange: (value: string, position?: number) => { draft = value; cursor = position ?? 0; presenter.setComposerDraft(value, position); }};
  presenter.enterAppScreen();
  manager.startNavigationMode(handler, "session-ready");
  input.write("draft"); input.write("\x1b[D");
  assert.equal(draft, "draft"); assert.equal(cursor, 4);
  presenter.beginRunTransition("automatic", undefined, "main", {preserveComposer: true});
  manager.startNavigationMode(handler, "running-main", {preserveComposer: true});
  presenter.commitRunTransition();
  input.write("X");
  assert.equal(draft, "drafXt"); assert.equal(cursor, 5);
  assert.equal((presenter as any).composerDraft, "drafXt");
  presenter.stopRun("done");
  assert.equal((presenter as any).composerDraft, "drafXt");
});

test("switching session projection preserves active agents and task board", t => {
  const {team, agents, tasks} = fixture();
  const presenter = new CliPresenter({eventBus: new EventBus(), agentRegistry: agents, taskManager: tasks, isTTY: false});
  t.after(() => { presenter.destroy(); team.destroy(); });
  team.addMember({agentId: "worker", name: "worker", role: "dev", roleDescription: ""});
  tasks.createTask({id: "old-task", subject: "work"});
  team.claimTask("old-task", "worker");
  presenter.loadResumedSession([], {preserveRuntime: true});
  assert.equal(agents.getAgent("worker")?.status, "running");
  assert.equal(tasks.getTask("old-task")?.status, "running");
  assert.equal(team.roster.getMember("worker")?.agentId, "worker");
});

test("finishing Lead does not change an executing background agent's status", t => {
  const {team, agents, tasks, runtime} = fixture();
  const gate = deferred<SubAgentResult>();
  t.mock.method(runtime, "spawn", async () => gate.promise);
  const presenter = new CliPresenter({eventBus: new EventBus(), agentRegistry: agents, taskManager: tasks, isTTY: false, isAgentExecuting: id => runtime.isExecuting(id)});
  t.after(async () => { gate.resolve(result("worker", "done")); await runtime.waitForAgent("worker"); presenter.destroy(); team.destroy(); });
  agents.register({agentId: "worker", type: "subagent", depth: 1, status: "running"});
  runtime.spawnInBackground("work", {agentId: "worker", parentAgentId: "main", parentSessionId: "s"});
  presenter.beginRunTransition("lead"); presenter.commitRunTransition(); presenter.stopRun("done");
  assert.equal(agents.getAgent("worker")?.status, "running");
});
