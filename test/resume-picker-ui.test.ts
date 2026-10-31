import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { SessionPicker } from "../src/presentation/session-picker.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { InputManager } from "../src/cli/input-manager.js";
import { TerminalUI } from "../src/cli/terminal-ui.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { ContextManager } from "../src/context/context-manager.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { EventBus } from "../src/observability/event-bus.js";

function terminal() {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stream, { isTTY: true, columns: 90, rows: 20 });
  let output = "";
  stream.on("data", (chunk) => { output += chunk.toString(); });
  return { stream, read: () => stripAnsi(output) };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), 2000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("resume picker in native scrollback", () => {
  it("sorts newest first, searches last prompt, and keeps selection in bounds", () => {
    const base = { createdAt: 1, recordCount: 1, messageCount: 1, hasCompaction: false };
    const picker = new SessionPicker([
      { ...base, sessionId: "old", updatedAt: 1, firstUserPrompt: "Old task" },
      { ...base, sessionId: "new", updatedAt: 2, firstUserPrompt: "First task", lastUserPrompt: "Fix resume" },
    ], "old");
    assert.equal(picker.selected?.sessionId, "new");
    picker.setQuery("resume");
    assert.equal(picker.matches.length, 1);
    picker.move(10);
    assert.equal(picker.selected?.sessionId, "new");
    picker.setQuery("old");
    assert.match(picker.render(80, 20).join("\n"), /current/);
  });

  it("opens /resume inside the app, cancels with Esc, and restores a searched session", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "nash-picker-"));
    const input = terminal();
    const output = terminal();
    const inputManager = new InputManager({ input: input.stream as any, output: output.stream as any, isTTY: true });
    const presenter = new CliPresenter({ eventBus: new EventBus(), agentRegistry: new AgentRegistry(), stdout: output.stream, isTTY: true, nativeScrollback: true });
    const contextManager = new ContextManager({ baseDir });
    const terminalUI = new TerminalUI(output.stream);
    try {
      const old = new LocalSessionStore({ baseDir });
      await old.appendUserMessage("Old conversation");
      const target = new LocalSessionStore({ baseDir });
      await target.appendUserMessage("Find this session");

      presenter.setOnInteractionModeChange((mode) => inputManager.setInteractionMode(mode));
      inputManager.startNavigationMode(presenter.getNavigationHandler(), "session-ready");
      presenter.enterAppScreen();

      const ctx = {
        inputManager, terminalUI, contextManager, baseDir, cliPresenter: presenter,
        onSessionSwitched: async () => presenter.loadResumedSession(await contextManager.getSession().getRecords()),
      };
      const cancelled = handleSlashCommand("/resume", ctx);
      for (let i = 0; i < 20 && presenter.getInteractionMode() !== "session-picker"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(presenter.getInteractionMode(), "session-picker");
      assert.match(output.read(), /Resume a session/);
      input.stream.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 65));
      await within(cancelled, "cancel");
      assert.equal(presenter.getInteractionMode(), "empty-session");

      const resumed = handleSlashCommand("/resume", ctx);
      for (let i = 0; i < 20 && presenter.getInteractionMode() !== "session-picker"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      input.stream.write("Old");
      assert.match(output.read(), /Search > Old/);
      input.stream.write("\x15");
      input.stream.write("\x1b[200~Find this\x1b[201~\r");
      await within(resumed, "resume");
      assert.equal(contextManager.sessionId, target.sessionId);
      assert.equal(presenter.getInteractionMode(), "session-ready");
      assert.match(output.read(), /Find this session/);
      assert.doesNotMatch(output.read().slice(-1500), /Old conversation/);
    } finally {
      presenter.destroy();
      inputManager.close();
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
