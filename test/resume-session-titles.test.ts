import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { SessionPicker } from "../src/presentation/session-picker.js";

describe("resume session titles and ownership", () => {
  it("uses the first actual task, ignoring greetings and background notifications", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "nash-title-"));
    try {
      const store = new LocalSessionStore({ baseDir });
      await store.appendUserMessage("你好");
      await store.appendUserMessage("帮我优化 /resume 的交互");
      await store.appendUserMessage("[Background job notification]\nCommand: python3 -c secret", { source: "background-job-notification" });
      const summary = await store.getSummary();
      assert.equal(summary.title, "帮我优化 /resume 的交互");
      assert.match(summary.lastUserPrompt!, /Background job notification/);
      const picker = new SessionPicker([summary], store.sessionId);
      const rendered = picker.render(131, 33).join("\n");
      assert.match(rendered, /帮我优化 \/resume 的交互/);
      assert.doesNotMatch(rendered, /python3 -c secret/);
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });

  it("hides old child contexts inferred from spawn calls and new marked child contexts", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "nash-child-list-"));
    try {
      const main = new LocalSessionStore({ baseDir });
      await main.appendUserMessage("构建主任务", { agentType: "main" });
      await main.appendAssistantMessage(null, [{
        id: "spawn-1", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ prompt: "只完成子任务 A" }) },
      }]);
      const oldChild = new LocalSessionStore({ baseDir });
      await oldChild.appendUserMessage("只完成子任务 A");
      const newChild = new LocalSessionStore({ baseDir });
      await newChild.appendUserMessage("只完成子任务 B", { agentType: "subagent" });
      const independent = new LocalSessionStore({ baseDir });
      await independent.appendUserMessage("独立的用户任务");

      const listed = await LocalSessionStore.listSessionSummaries(baseDir);
      assert.deepEqual(new Set(listed.map((s) => s.sessionId)), new Set([main.sessionId, independent.sessionId]));
    } finally { await rm(baseDir, { recursive: true, force: true }); }
  });
});
