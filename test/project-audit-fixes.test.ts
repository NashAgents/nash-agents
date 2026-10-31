import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { PreToolSecurityMonitor } from "../src/security/security-monitor.js";
import { InMemoryClusterStore, type ScheduledTaskRecord, type ClusterTaskRecord } from "../src/cluster/storage/cluster-store.js";
import { ScheduleTriggerEngine } from "../src/cluster/scheduled/schedule-trigger-engine.js";
import { computeNextCronTime, isValidCronExpression } from "../src/cluster/scheduled/cron-parser.js";
import { DistributedGraphOrchestrator } from "../src/cluster/graph/graph-orchestrator.js";
import { createLocalClusterStore } from "../src/cluster/storage/local-cluster-store.js";
import { pollStream } from "../src/cluster/coordinator/stream-poller.js";
import { readTextPage } from "../src/filesystem/text-page.js";
import type { TaskScheduler } from "../src/cluster/coordinator/task-scheduler.js";
import { SseConnection } from "../apps/web/src/services/sse.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function plan(id = "s"): ScheduledTaskRecord {
  const now = Date.now();
  return { id, name: "fixture", description: "", enabled: true, triggerType: "interval", intervalMs: 3600000,
    nextRunAt: now + 3600000, targetType: "single_task", taskConfig: { goal: "fixture" },
    concurrencyPolicy: "SKIP_IF_RUNNING", misfirePolicy: "RUN_ONCE_IMMEDIATELY", maxConcurrency: 1,
    runCount: 0, createdBy: "test", createdAt: now, updatedAt: now };
}
function scheduler(store: InMemoryClusterStore) {
  const tasks: ClusterTaskRecord[] = [];
  return { tasks, createTask: async (options: Parameters<TaskScheduler["createTask"]>[0]) => {
    const task: ClusterTaskRecord = { taskId: `t-${randomUUID()}`, runId: `run-${randomUUID()}`, nodeId: "w", projectId: "p", goal: options.goal, status: "running", dispatchAttempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
    await store.saveTask(task);
    await options.beforeDispatch?.(task);
    tasks.push(task);
    return task;
  } };
}

test("MOCK_UNIT: audit snippets and nested arrays never retain credentials", async () => {
  const store = new InMemoryClusterStore();
  const secret = "CANARY_ONLY_NOT_A_REAL_SECRET";
  const monitor = new PreToolSecurityMonitor({ auditSink: record => store.saveSecurityAudit(record) });
  const args = { command: "rm -rf /", password: secret, items: [{ apiKey: secret }, [{ token: secret }]] };
  await monitor.evaluateToolCall({ toolName: "bash", toolArgs: args, rawArgs: JSON.stringify(args), argsFingerprint: "fixture", agentIdentity: { agentId: "test" }, userAuthorizationContext: { userIntent: "fixture" } });
  assert.ok(!JSON.stringify((await store.listSecurityAudits()).items).includes(secret));
});

test("MOCK_UNIT: cron rejects oversized ranges, malformed integers and empty fields before iteration", () => {
  for (const expression of ["0-1000000000000 * * * *", "99-100 * * * *", "1junk * * * *", "*/0 * * * *", "5-1/2 * * * *", "1,,2 * * * *"]) assert.equal(isValidCronExpression(expression), false, expression);
});

test("MOCK_UNIT: cron honors IANA timezones, DST gaps/folds and bounded calendar search", () => {
  const from = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(new Date(computeNextCronTime("0 9 * * *", from, "Asia/Shanghai")).toISOString(), "2026-10-25T01:00:00.000Z");
  assert.equal(new Date(computeNextCronTime("0 9 * * *", from, "UTC")).toISOString(), "2026-10-25T09:00:00.000Z");
  assert.equal(new Date(computeNextCronTime("30 2 * * *", Date.parse("2026-03-08T05:00:00Z"), "America/New_York")).toISOString(), "2026-03-09T06:30:00.000Z");
  assert.equal(new Date(computeNextCronTime("30 1 * * *", Date.parse("2026-11-01T05:45:00Z"), "America/New_York")).toISOString(), "2026-11-02T06:30:00.000Z");
  assert.throws(() => computeNextCronTime("0 0 31 2 *", from, "UTC"), /five years/);
  assert.throws(() => computeNextCronTime("0 9 * * *", from, "Not/A_Timezone"), /timezone/);
});

test("SIMULATED_INTEGRATION: manual admission is atomic across engines and survives reconstruction", async t => {
  const store = new InMemoryClusterStore(), sched = scheduler(store);
  await store.saveScheduledTask(plan());
  const first = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  const second = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  t.after(() => { first.stop(); second.stop(); });
  const runs = await Promise.all([first.runNow("s"), second.runNow("s")]);
  assert.equal(sched.tasks.length, 1);
  assert.equal(runs.filter(r => r.status === "skipped").length, 1);
  assert.equal(runs.find(r => r.status === "running")?.metrics?.isManual, true);
  await store.updateScheduledTask("s", { nextRunAt: Date.now() - 1 });
  await second.start();
  assert.equal(sched.tasks.length, 1);
});

test("SIMULATED_INTEGRATION: persistent queue drains after restart only when the prior execution is terminal", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nash-audit-queue-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = createLocalClusterStore(join(dir, "store.bin"));
  await store.saveScheduledTask!( { ...plan(), concurrencyPolicy: "QUEUE" });
  const taskStore = store as InMemoryClusterStore, sched = scheduler(taskStore);
  const first = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  const active = await first.runNow("s"), queued = await first.runNow("s");
  assert.equal(queued.status, "queued");
  await store.updateTaskStatus(active.taskId!, "completed");
  first.stop();
  store = createLocalClusterStore(join(dir, "store.bin"));
  const nextSched = scheduler(store as InMemoryClusterStore);
  const second = new ScheduleTriggerEngine({ store, scheduler: nextSched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  t.after(() => second.stop());
  await second.start();
  assert.equal((await store.getScheduledTaskRun!(active.id))?.status, "completed");
  assert.equal(nextSched.tasks.length, 1);
  assert.equal((await store.getScheduledTaskRun!(queued.id))?.status, "running");
});

test("SIMULATED_INTEGRATION: all 151 plans execute and completion outside the newest 50 records settles", async t => {
  const store = new InMemoryClusterStore(), sched = scheduler(store);
  for (let i = 0; i < 151; i++) await store.saveScheduledTask({ ...plan(`s-${i}`), nextRunAt: Date.now() - 1 });
  const engine = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  t.after(() => engine.stop());
  await engine.start();
  assert.equal(sched.tasks.length, 151);
  const oldest = sched.tasks[0];
  await store.updateTaskStatus(oldest.taskId, "completed");
  await engine.reschedule();
  assert.equal(await store.getScheduledRunByExecution(oldest.taskId), null);
  assert.equal((await store.listScheduledTaskRuns(undefined, { limit: 200 })).filter(r => r.status === "completed").length, 1);
});

test("SIMULATED_INTEGRATION: CATCH_UP preserves missed trigger identities and respects its per-pass bound", async t => {
  const store = new InMemoryClusterStore(), sched = scheduler(store);
  const task = { ...plan(), intervalMs: 1000, nextRunAt: Date.now() - 3500, misfirePolicy: "CATCH_UP" as const, concurrencyPolicy: "ALLOW_CONCURRENT" as const, maxConcurrency: 10 };
  await store.saveScheduledTask(task);
  const engine = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c", misfireThresholdMs: 1 });
  t.after(() => engine.stop());
  await engine.start();
  assert.equal(sched.tasks.length, 4);
  const runs = await store.listScheduledTaskRuns("s");
  assert.deepEqual(runs.map(r => r.triggerTime).sort(), [0,1,2,3].map(i => task.nextRunAt + i * 1000).sort());
});

test("SIMULATED_INTEGRATION: graph schedules use the graph returned by atomic creation", async t => {
  const store = new InMemoryClusterStore(), sched = scheduler(store);
  const graph = new DistributedGraphOrchestrator({ store, scheduler: sched as unknown as TaskScheduler });
  const task = { ...plan(), targetType: "graph" as const, graphConfig: { parentGoal: "fixture", nodes: [{ nodeId: "a", title: "a", goal: "a", dependencies: [] }] } };
  await store.saveScheduledTask(task);
  let started: string | undefined;
  const wrapped = { createGraph: graph.createGraph.bind(graph), startGraph: async (id: string) => { started = id; await store.updateGraphStatus(id, "completed"); return (await store.getGraph(id))!; } };
  const engine = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, orchestrator: wrapped as DistributedGraphOrchestrator, coordinatorNodeId: "c" });
  t.after(() => engine.stop());
  const run = await engine.runNow("s");
  assert.equal(run.graphId, started);
  assert.ok(await store.getGraph(started!));
  await engine.start();
  assert.equal((await store.getScheduledTaskRun(run.id))?.status, "completed");
});

test("SIMULATED_INTEGRATION: a failed stream query closes the stream, and slow polls never overlap", async () => {
  const stream = new PassThrough(); stream.resume();
  let active = 0, peak = 0, count = 0;
  const stop = pollStream(stream as unknown as ServerResponse, 1, async () => {
    peak = Math.max(peak, ++active);
    await pause(8); active--; count++;
    if (count === 3) throw new Error("fixture database outage");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("stream did not close")), 1000);
      stream.once("finish", () => { clearTimeout(timeout); resolve(); });
    });
    assert.equal(peak, 1); assert.equal(count, 3);
  } finally { stop(); stream.destroy(); }
});

test("SIMULATED_INTEGRATION: long lines and UTF-8/CRLF boundaries stay bounded and hash the exact file", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nash-audit-read-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const content = "中".repeat(30000) + "\r\nsecond\r\nthird\n";
  const file = join(dir, "fixture.txt"); await writeFile(file, content);
  const page = await readTextPage(file, 2, 1, 100);
  assert.deepEqual(page.lines, ["2: second"]); assert.equal(page.totalLines, 3);
  assert.equal(page.sha256, createHash("sha256").update(content).digest("hex"));
  const bounded = await readTextPage(file, 1, 10, 50);
  assert.ok(bounded.lines.join("\n").length <= 52); assert.equal(bounded.truncated, true);
});

test("SIMULATED_INTEGRATION: named title events reach SSE subscribers", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  class Source extends EventTarget {
    static latest: Source;
    constructor() { super(); Source.latest = this; }
    close() {}
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, writable: true, value: Source });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "EventSource", descriptor); else Reflect.deleteProperty(globalThis, "EventSource"); });
  const connection = new SseConnection("/fixture");
  let received: unknown;
  const unsubscribe = connection.subscribe(event => { if (event.type === "conversation.title_updated") received = event.data; });
  t.after(unsubscribe);
  Source.latest.dispatchEvent(new MessageEvent("conversation.title_updated", { data: JSON.stringify({ conversationId: "c", title: "updated" }) }));
  assert.deepEqual(received, { conversationId: "c", title: "updated" });
});

test("SIMULATED_INTEGRATION: pausing while dispatch is pending cannot be undone by trigger bookkeeping", async t => {
  const store = new InMemoryClusterStore();
  const task = { ...plan(), nextRunAt: Date.now() - 1 };
  await store.saveScheduledTask(task);
  const sched = { createTask: async () => {
    await store.updateScheduledTask(task.id, { enabled: false });
    return { taskId: "paused-execution" };
  } };
  const engine = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  t.after(() => engine.stop());
  await engine.start();
  assert.equal((await store.getScheduledTask(task.id))?.enabled, false);
});

test("SIMULATED_INTEGRATION: an unlinked crash claim stays unknown and cannot be forced into another execution", async t => {
  const store = new InMemoryClusterStore(), sched = scheduler(store), task = plan();
  await store.saveScheduledTask(task);
  await store.claimScheduledTaskRun({ id: "crashed", scheduledTaskId: task.id, targetType: "single_task", triggerTime: 1, startedAt: 1, createdAt: 1, status: "running" });
  const engine = new ScheduleTriggerEngine({ store, scheduler: sched as unknown as TaskScheduler, coordinatorNodeId: "c" });
  t.after(() => engine.stop());
  await engine.start();
  assert.equal((await store.getScheduledTaskRun("crashed"))?.status, "outcome_unknown");
  assert.equal((await engine.runNow(task.id, true)).status, "skipped");
  assert.equal(sched.tasks.length, 0);
  await store.saveScheduledTask({ ...task, id: "invalid", concurrencyPolicy: "ALLOW_CONCURRENT", maxConcurrency: NaN });
  await assert.rejects(engine.runNow("invalid"), /concurrency limit/);
});

test("SIMULATED_INTEGRATION: scheduled terminal events and restart reconciliation preserve result summaries", async t => {
  const { EventBus } = await import("../src/observability/event-bus.js");
  const store=new InMemoryClusterStore(),fake=scheduler(store),bus=new EventBus();
  const schedule=plan("summary");await store.saveScheduledTask(schedule);
  const engine=new ScheduleTriggerEngine({store,scheduler:fake as unknown as TaskScheduler,eventBus:bus,coordinatorNodeId:"c"});
  t.after(()=>engine.stop());await engine.start();const run=await engine.runNow(schedule.id);
  await store.updateTaskStatus(run.taskId!,"completed",{finalAnswer:"durable summary"});
  bus.emit({id:randomUUID(),type:"task.completed",timestamp:new Date().toISOString(),projectId:"p",sessionId:"s",data:{taskId:run.taskId,finalAnswer:"durable summary"}});
  await pause(30);assert.equal((await store.getScheduledTaskRun(run.id))!.resultSummary,"durable summary");
  engine.stop();const pending=await engine.runNow(schedule.id);await store.updateTaskStatus(pending.taskId!,"failed",{error:"retained failure",resultSummary:"partial evidence"});
  await engine.start();const reconciled=(await store.getScheduledTaskRun(pending.id))!;
  assert.equal(reconciled.error,"retained failure");assert.equal(reconciled.resultSummary,"partial evidence");
});
