import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { InputManager } from "../src/cli/input-manager.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { EventBus } from "../src/observability/event-bus.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { tailToDisplayWidth } from "../src/presentation/terminal-renderer.js";
import { ProposedPlanProjection } from "../src/presentation/proposed-plan-projection.js";
import { resolveComposerDestination } from "../src/orchestration/composer-routing.js";

function tty(columns: number, rows: number) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stream, { isTTY: true, columns, rows });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString(); });
  return { stream, read: () => stripAnsi(output), raw: () => output };
}

describe("CLI UI", () => {
  it("keeps ordinary y/n input when no approval is pending", async () => {
    const input = tty(80, 24);
    const output = tty(80, 24);
    const manager = new InputManager({ input: input.stream as any, output: output.stream as any, isTTY: true });
    const drafts: string[] = [];
    manager.startNavigationMode({
      onApprovalKey: () => false,
      onComposerChange: (draft) => drafts.push(draft),
    });
    input.stream.write("y");
    input.stream.write("n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(drafts.at(-1), "yn");
    manager.close();
  });

  it("keeps CJK and emoji at the visible end of a long composer draft", () => {
    assert.equal(tailToDisplayWidth("abcdefgh你好👩‍💻", 7), "…你好👩‍💻");
  });

  it("edits the running composer at grapheme boundaries", async () => {
    const input = tty(80, 24);
    const output = tty(80, 24);
    const manager = new InputManager({ input: input.stream as any, output: output.stream as any, isTTY: true });
    let latest = "";
    let cursor = -1;
    manager.startNavigationMode({
      onComposerChange: (draft, index) => { latest = draft; cursor = index ?? -1; },
    }, "running-main");
    try {
      input.stream.write("A你好👩‍💻B");
      input.stream.write("\x1b[D");
      input.stream.write("\x7f");
      input.stream.write("X");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(latest, "A你好XB");
      assert.equal(cursor, 4);
    } finally {
      manager.close();
    }
  });

  it("lets the user inspect later plan steps before approval", () => {
    const screen = tty(80, 24);
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: screen.stream, isTTY: true });
    const plan = {
      planId: "p1", goal: "Refactor UI", summary: "Update the runtime UI",
      steps: Array.from({ length: 9 }, (_, i) => ({ subject: `Step ${i + 1}` })),
      createdAt: Date.now(),
    };
    try {
      presenter.startRun("make a plan");
      presenter.triggerPlanApproval(plan);
      presenter.render();
      assert.match(screen.read(), /Step 1/);
      presenter.getNavigationHandler().onPlanPageDown?.();
      assert.match(screen.read(), /Step 5/);
      const page = ProposedPlanProjection.render(plan, { maxVisibleSteps: 4, stepOffset: 4 }).join(" ");
      assert.match(page, /5\. Step 5/);
    } finally {
      presenter.destroy();
    }
  });

  it("uses Ctrl+X for agent interruption and accepts x as text", async () => {
    const input = tty(80, 24);
    const output = tty(80, 24);
    const manager = new InputManager({ input: input.stream as any, output: output.stream as any, isTTY: true });
    let interruptions = 0;
    let draft = "";
    manager.startNavigationMode({
      onAgentInterrupt: () => { interruptions++; },
      onComposerChange: (value) => { draft = value; },
    }, "agent-detail");
    try {
      input.stream.write("x");
      input.stream.write("\x18");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(draft, "x");
      assert.equal(interruptions, 1);
    } finally {
      manager.close();
    }
  });

  it("shows team hierarchy and preserves transcript space in a small terminal", () => {
    const screen = tty(48, 10);
    const registry = new AgentRegistry();
    registry.register({ agentId: "main", type: "main", depth: 0 });
    registry.register({ agentId: "lead", name: "lead", type: "team-lead", parentAgentId: "main", depth: 1 });
    registry.register({ agentId: "worker", name: "worker", type: "team-member", parentAgentId: "lead", depth: 2 });
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: registry, stdout: screen.stream, isTTY: true });
    try {
      presenter.startRun("inspect UI");
      presenter.getNavigationHandler().onKeyDown?.();
      const rendered = screen.read();
      assert.match(rendered, /Agents/);
      assert.match(rendered, /└ Lead/);
      assert.match(rendered, /> inspect UI/);
      assert.match(screen.raw(), /\x1b\[10;1H/);
    } finally {
      presenter.destroy();
    }
  });

  it("selects agents independently from the viewed transcript and returns to Main", () => {
    const screen = tty(100, 28);
    const registry = new AgentRegistry();
    registry.register({ agentId: "main", type: "main" });
    registry.register({ agentId: "one", name: "One", type: "subagent", parentAgentId: "main" });
    registry.register({ agentId: "two", name: "Two", type: "subagent", parentAgentId: "main" });
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: registry, stdout: screen.stream, isTTY: true });
    try {
      presenter.startRun("work");
      const nav = presenter.getNavigationHandler();
      nav.onKeyDown?.();
      assert.equal(presenter.getSelectedAgentId(), "one");
      assert.equal(presenter.getActiveViewAgentId(), "main");
      nav.onKeyEnter?.();
      assert.equal(presenter.getActiveViewAgentId(), "one");
      nav.onKeyDown?.();
      assert.equal(presenter.getSelectedAgentId(), "two");
      assert.equal(presenter.getActiveViewAgentId(), "one");
      assert.match(screen.read(), /One · subagent \[view\]/);
      nav.onKeyEnter?.();
      assert.equal(presenter.getActiveViewAgentId(), "two");
      nav.onKeyEscape?.();
      assert.equal(presenter.getActiveViewAgentId(), "main");
      assert.equal(presenter.getSelectedAgentId(), "main");
    } finally { presenter.destroy(); }
  });

  it("switches Main composer between steer and queue with Tab", async () => {
    const input = tty(80, 24);
    const output = tty(80, 24);
    const manager = new InputManager({ input: input.stream as any, output: output.stream as any, isTTY: true });
    const modes: string[] = [];
    const submissions: string[] = [];
    manager.startNavigationMode({
      onFollowupModeChange: (mode) => modes.push(mode),
      onComposerSubmit: (_draft, mode) => submissions.push(mode),
    }, "running-main");
    try {
      input.stream.write("\tqueued\r");
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(modes.at(-1), "queue");
      assert.equal(submissions.at(-1), "queue");
    } finally { manager.close(); }
  });

  it("routes idle child input to a new Main turn and plan revision to revision", () => {
    assert.equal(resolveComposerDestination({ interactionMode: "agent-detail", isRunActive: false, viewedAgentId: "one", requestedMode: "steer" }), "start-run");
    assert.equal(resolveComposerDestination({ interactionMode: "agent-detail", isRunActive: true, viewedAgentId: "one", requestedMode: "steer" }), "steer");
    assert.equal(resolveComposerDestination({ interactionMode: "running-main", isRunActive: true, viewedAgentId: "main", requestedMode: "queue" }), "queue");
    assert.equal(resolveComposerDestination({ interactionMode: "plan-revision", isRunActive: true, viewedAgentId: "main", requestedMode: "start-run" }), "plan-revision");
  });

  it("shows plan risks and expands per-step dependencies and scope", () => {
    const plan = { planId: "p2", goal: "Ship", summary: "Upgrade UI", risks: ["Migration"], assumptions: ["TTY"], steps: [{ subject: "Build", description: "Implement navigation", dependencies: ["design"], writeScopes: ["src/ui"] }], createdAt: Date.now() };
    const compact = ProposedPlanProjection.render(plan).join("\n");
    const detailed = ProposedPlanProjection.render(plan, { showDetails: true }).join("\n");
    assert.match(compact, /Risks: Migration/);
    assert.doesNotMatch(compact, /After: design/);
    assert.match(detailed, /After: design/);
    assert.match(detailed, /Files: src\/ui/);
  });
});
