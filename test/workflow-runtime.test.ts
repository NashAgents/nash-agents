import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRuntime, WorkflowCancelledError } from "../src/workflow/index.js";
import { SubAgentRuntime, AgentRegistry } from "../src/agent/index.js";
import { ConcurrencyController } from "../src/concurrency/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase D: Workflow Runtime", () => {
  it("1. Parallel 与 Barrier 汇聚编排", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController({ maxConcurrentAgents: 4 });
    const subRuntime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });
    const wf = new WorkflowRuntime({
      subAgentRuntime: subRuntime,
      concurrencyController: concurrency,
    });

    const result = await wf.execute("parallel-analysis", async (ctx) => {
      ctx.phase("Analyze");
      const [backend, frontend] = await ctx.parallel([
        async () => "backend: status ok",
        async () => "frontend: status ok",
      ]);

      ctx.phase("Synthesize");
      return `Synthesis: ${backend} + ${frontend}`;
    });

    assert.equal(result, "Synthesis: backend: status ok + frontend: status ok");
  });

  it("2. Pipeline 流水线编排", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const subRuntime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });
    const wf = new WorkflowRuntime({
      subAgentRuntime: subRuntime,
      concurrencyController: concurrency,
    });

    const items = ["auth.ts", "user.ts", "db.ts"];

    const processed = await wf.execute("pipeline-sweep", async (ctx) => {
      return await ctx.pipeline<string, { file: string; audited: boolean }>(
        items,
        async (file: string) => `scanned:${file}`,
        async (scanned: string, originalFile: string) => ({
          file: originalFile,
          audited: scanned.startsWith("scanned:"),
        })
      );
    });

    assert.equal(processed.length, 3);
    assert.equal(processed[0].file, "auth.ts");
    assert.equal(processed[0].audited, true);
    assert.equal(processed[2].file, "db.ts");
  });

  it("3. Nested Workflow 嵌套子工作流支持", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const subRuntime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });
    const wf = new WorkflowRuntime({
      subAgentRuntime: subRuntime,
      concurrencyController: concurrency,
    });

    const finalRes = await wf.execute("parent-flow", async (ctx) => {
      const childResult = await ctx.workflow("child-flow", async (childCtx) => {
        return "child-done";
      });
      return `parent:${childResult}`;
    });

    assert.equal(finalRes, "parent:child-done");
  });

  it("4. AbortSignal 取消工作流抛出 WorkflowCancelledError", async () => {
    const registry = new AgentRegistry();
    const concurrency = new ConcurrencyController();
    const subRuntime = new SubAgentRuntime({
      agentRegistry: registry,
      concurrencyController: concurrency,
    });
    const wf = new WorkflowRuntime({
      subAgentRuntime: subRuntime,
      concurrencyController: concurrency,
    });

    const abortController = new AbortController();
    abortController.abort("User clicked cancel");

    await assert.rejects(
      async () => {
        await wf.execute(
          "cancelled-flow",
          async (ctx) => {
            return "should not reach";
          },
          { signal: abortController.signal }
        );
      },
      WorkflowCancelledError
    );
  });
});
