import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { AgentTranscriptProjection, formatToolDiffLines } from "../src/presentation/agent-transcript-projection.js";
import { TerminalInputParser } from "../src/cli/terminal-input-parser.js";
import { InputManager } from "../src/cli/input-manager.js";
import { createEditFileTool } from "../src/tools/edit-file.js";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";

describe("compact file activity", () => {
  it("nests bash commands and their output beneath the tool row", () => {
    const projection = new AgentTranscriptProjection("main");
    projection.addToolCallStart("bash-1", "bash", "checking git status", { command: "git status -s" });
    assert.match(stripAnsi(projection.getDisplayLines().join("\n")), /bash checking git status.*\n    └ \$ git status -s/);

    projection.completeToolCall("bash-1", "bash", true, 12, " M src/index.ts\n M package.json");
    const rendered = stripAnsi(projection.getDisplayLines().join("\n"));
    assert.match(rendered, /    └ \$ git status -s\n       M src\/index\.ts\n       M package\.json/);
  });

  it("shows changed lines from multiline replacements with a readable diff gutter", () => {
    const rendered = stripAnsi(formatToolDiffLines("edit_file", {
      edits: [{ old_text: "function run() {\n  return 'old';\n}", new_text: "function run() {\n  return 'new';\n}" }],
    }).join("\n"));
    assert.match(rendered, /└ 1 replacements/);
    assert.match(rendered, /@@ 1\/1 @@/);
    assert.match(rendered, /-   return 'old';\n      \+   return 'new';/);
    assert.doesNotMatch(rendered, /- function run\(\)/);
  });

  it("shows a numbered, highlighted file hunk from the content before an edit", () => {
    const before = "const top = 1;\nconst value = 'old';\nconst bottom = 2;\n";
    const projection = new AgentTranscriptProjection("main", () => before);
    const args = { path: "src/example.ts", old_text: "'old'", new_text: "'new'" };
    projection.addToolCallStart("edit", "edit_file", "editing src/example.ts", args);
    projection.completeToolCall("edit", "edit_file", true, 4, "saved");
    const rendered = projection.getDisplayLines().join("\n");
    const plain = stripAnsi(rendered);
    assert.match(plain, /Update\(src\/example\.ts\)/);
    assert.match(plain, /Added 1 lines, removed 1 lines/);
    assert.match(plain, /1    const top = 1;/);
    assert.match(plain, /2 -  const value = 'old';/);
    assert.match(plain, /2 \+  const value = 'new';/);
    assert.match(rendered, /\x1b\[48;5;52m/);
    assert.match(rendered, /\x1b\[48;5;22m/);
  });

  it("keeps a large write compact while leaving its preview in detailed view", () => {
    const projection = new AgentTranscriptProjection("main");
    const args = { path: "index.html", content: Array.from({ length: 100 }, (_, i) => `<p>${i}</p>`).join("\n") };
    projection.addToolCallStart("write", "write_file", "writing index.html", args);
    projection.completeToolCall("write", "write_file", true, 3, "saved");
    const compact = stripAnsi(projection.getDisplayLines().join("\n"));
    assert.match(compact, /Write\(index\.html\)/);
    assert.match(compact, /Written 100 lines/);
    assert.doesNotMatch(compact, /<p>0<\/p>/);
    projection.toggleDetailedView();
    assert.match(stripAnsi(projection.getDisplayLines().join("\n")), /<p>0<\/p>/);
  });

  it("groups repeated file calls while keeping the complete record behind Ctrl+O", () => {
    const projection = new AgentTranscriptProjection("main");
    const args = { path: "src/snake.html" };
    projection.addToolCallStart("read-1", "read_file", "snake.html", args);
    projection.completeToolCall("read-1", "read_file", true, 2, "200 lines");
    projection.addThought();
    projection.finalizeThought(3700, 300);
    projection.addToolCallStart("edit-1", "edit_file", "snake.html", { ...args, old_text: "a", new_text: "b" });
    projection.completeToolCall("edit-1", "edit_file", true, 7, "saved");
    projection.addThought();
    projection.finalizeThought(5200, 310);
    projection.addToolCallStart("edit-2", "edit_file", "snake.html", { ...args, old_text: "b", new_text: "c" });
    projection.completeToolCall("edit-2", "edit_file", true, 3, "saved");

    const compact = stripAnsi(projection.getDisplayLines().join("\n"));
    assert.match(compact, /snake\.html · 2 edits · 1 read/);
    assert.doesNotMatch(compact, /read_file/);
    assert.doesNotMatch(compact, /Thought for 5\.2s/);
    assert.equal(TerminalInputParser.parse("\x0f").events[0]?.type, "ctrl-o");

    projection.toggleDetailedView();
    const detailed = stripAnsi(projection.getDisplayLines().join("\n"));
    assert.match(detailed, /read_file/);
    assert.match(detailed, /Update\(src\/snake\.html\)/);
    assert.match(detailed, /Added 1 lines, removed 1 lines/);
    assert.doesNotMatch(detailed, /3\.7s \(3\.7s/);
  });

  it("applies several unique replacements in one write and leaves the file untouched on a later failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "nash-batch-edit-"));
    const target = path.join(dir, "example.txt");
    const tool = createEditFileTool(new FileSystemAccess({ workspaceRoot: dir, policy: createDefaultSandboxPolicy() }));
    try {
      await writeFile(target, "alpha\nbeta\ngamma\n");
      const result = await tool.execute({ path: "example.txt", edits: [
        { old_text: "alpha", new_text: "one" },
        { old_text: "gamma", new_text: "three" },
      ] });
      assert.match(String(result), /2 处替换/);
      assert.equal(await readFile(target, "utf8"), "one\nbeta\nthree\n");
      assert.match(stripAnsi(formatToolDiffLines("edit_file", { edits: [{ old_text: "alpha", new_text: "one" }, { old_text: "gamma", new_text: "three" }] }).join("\n")), /2 replacements/);

      await assert.rejects(() => tool.execute({ path: "example.txt", edits: [
        { old_text: "one", new_text: "changed" },
        { old_text: "missing", new_text: "never" },
      ] }) as Promise<unknown>, /第 2 处替换失败/);
      assert.equal(await readFile(target, "utf8"), "one\nbeta\nthree\n");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("routes Ctrl+O to the transcript detail toggle", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let toggles = 0;
    const manager = new InputManager({ input, output, isTTY: true });
    manager.startNavigationMode({ onKeyCtrlO: () => { toggles++; } }, "running-main");
    try {
      input.write("\x0f");
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(toggles, 1);
    } finally { manager.close(); }
  });
});
