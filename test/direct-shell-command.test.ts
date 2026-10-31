import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";

import {
  isShellCommand,
  formatShellConversationBlock,
  executeDirectShellCommand,
} from "../src/cli/direct-shell-executor.js";
import { ContextManager } from "../src/context/context-manager.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";

describe("Direct Shell Command Execution (! <command>) Feature", () => {
  test("1. isShellCommand 能够准确识别 '!' 前缀命令并过滤普通文本", () => {
    assert.strictEqual(isShellCommand("! ls -la"), true);
    assert.strictEqual(isShellCommand("!git status"), true);
    assert.strictEqual(isShellCommand("  ! npm test  "), true);
    assert.strictEqual(isShellCommand("!"), true);
    assert.strictEqual(isShellCommand("/status"), false);
    assert.strictEqual(isShellCommand("echo 'hello!'"), false);
    assert.strictEqual(isShellCommand("帮我运行一下 ! 符号"), false);
  });

  test("2. formatShellConversationBlock 能够生成标准规范的对话块格式", () => {
    const formatted = formatShellConversationBlock(
      "git status",
      "On branch main\nnothing to commit",
      0,
      45
    );
    assert.ok(formatted.startsWith("! git status\n\n[Command Output]"));
    assert.ok(formatted.includes("$ git status"));
    assert.ok(formatted.includes("(exit 0 · 45ms)"));
    assert.ok(formatted.includes("On branch main"));
  });

  test("3. executeDirectShellCommand 正常执行本地命令，捕获输出并同步沉淀到 Context 与 Session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-shell-test-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionId = "test-session-shell-1";

    const sessionStore = new LocalSessionStore({
      sessionId,
      sessionsDir,
    });

    const contextManager = new ContextManager({
      sessionId,
      sessionStore,
    });

    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const result = await executeDirectShellCommand({
      command: 'echo "hello-nash-direct-shell"',
      cwd: tempDir,
      cliPresenter: presenter,
      contextManager,
      writeToConsole: false,
    });

    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.output.includes("hello-nash-direct-shell"));
    assert.ok(result.durationMs >= 1);

    // 1. 验证持久化入 session.jsonl
    const records = await sessionStore.getRecords();
    assert.strictEqual(records.length, 1);
    const rec = records[0]!;
    assert.strictEqual(rec.type, "user");
    assert.strictEqual(rec.metadata?.isShellCommand, true);
    assert.strictEqual(rec.metadata?.command, 'echo "hello-nash-direct-shell"');
    assert.strictEqual(rec.metadata?.exitCode, 0);

    // 2. 验证 Active LLM Context 注入
    const active = contextManager.getActiveMessages();
    assert.ok(active.length >= 1);
    const lastActive = active[active.length - 1]!;
    assert.strictEqual(lastActive.role, "user");
    assert.ok(String(lastActive.content).includes("hello-nash-direct-shell"));

    // 3. 验证 Main Transcript 投影包含专用的 direct_shell 卡片
    const displayLines = presenter.getProjection("main").getDisplayLines();
    const joined = stripAnsi(displayLines.join("\n"));
    assert.ok(joined.includes('! echo "hello-nash-direct-shell"'));
    assert.ok(joined.includes("hello-nash-direct-shell"));
    assert.ok(joined.includes("exit 0"));

    presenter.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("4. executeDirectShellCommand 捕获非零退出码与 stderr 错误流", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-shell-err-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionId = "test-session-shell-2";

    const sessionStore = new LocalSessionStore({
      sessionId,
      sessionsDir,
    });

    const contextManager = new ContextManager({
      sessionId,
      sessionStore,
    });

    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const result = await executeDirectShellCommand({
      command: process.platform === "win32" ? "[Console]::Error.WriteLine('bad error occurred'); exit 42" : 'sh -c "echo \\"bad error occurred\\" >&2; exit 42"',
      cwd: tempDir,
      cliPresenter: presenter,
      contextManager,
      writeToConsole: false,
    });

    assert.strictEqual(result.exitCode, 42);
    assert.ok(result.output.includes("bad error occurred"));

    const displayLines = presenter.getProjection("main").getDisplayLines();
    const joined = stripAnsi(displayLines.join("\n"));
    assert.ok(joined.includes("✖"));
    assert.ok(joined.includes("exit 42"));
    assert.ok(joined.includes("bad error occurred"));

    presenter.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("5. AgentTranscriptProjection.projectFromSessionRecords 能够恢复历史中的 Shell 执行卡片", () => {
    const projection = new AgentTranscriptProjection("main");

    const records: any[] = [
      {
        type: "user",
        id: "rec-1",
        content: "! git status\n\n[Command Output]\n$ git status\n(exit 0 · 12ms)\nOn branch main",
        createdAt: 1000,
        metadata: {
          isShellCommand: true,
          command: "git status",
          output: "On branch main",
          exitCode: 0,
          durationMs: 12,
        },
      },
    ];

    projection.projectFromSessionRecords(records);
    const lines = projection.getDisplayLines();
    const joined = stripAnsi(lines.join("\n"));

    assert.ok(joined.includes("✔ ! git status"));
    assert.ok(joined.includes("12ms (exit 0)"));
    assert.ok(joined.includes("On branch main"));
  });

  test("6. CliPresenter 当 Composer 键入 '!' 时底栏提示 local-shell 快捷语义", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 100;
    (stream as any).rows = 30;

    let outputData = "";
    stream.on("data", (chunk: Buffer | string) => {
      outputData += chunk.toString();
    });

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
    });

    presenter.enterAppScreen();
    presenter.setComposerDraft("! git status", 12);

    const plain = stripAnsi(outputData);
    assert.ok(plain.includes("> ! git status"), "输入行应当展示 ! 命令内容");
    assert.ok(
      plain.includes("permissions: local-shell · enter to run ! command · output lands directly in conversation"),
      "底栏状态行应当呈现直观的 local-shell 执行与对话沉淀提示"
    );

    presenter.destroy();
  });

  test("7. executeDirectShellCommand 默认情况下在 TTY 模式下绝不裸写 console.stdout，输出收敛于 Transcript", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-shell-stdout-"));
    const sessionsDir = path.join(tempDir, "sessions");
    const sessionId = "test-session-shell-quiet";

    const sessionStore = new LocalSessionStore({
      sessionId,
      sessionsDir,
    });

    const contextManager = new ContextManager({
      sessionId,
      sessionStore,
    });

    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    // 监听 process.stdout 是否被直接写入裸字符
    let directStdoutWritten = false;
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      directStdoutWritten = true;
      return true;
    }) as any;

    try {
      // 不传 writeToConsole，验证默认行为
      const result = await executeDirectShellCommand({
        command: 'echo "should-not-leak-to-raw-stdout"',
        cwd: tempDir,
        cliPresenter: presenter,
        contextManager,
      });

      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(
        directStdoutWritten,
        false,
        "在 TTY Presenter 模式下绝不得向 process.stdout.write 裸吐子进程数据"
      );
      assert.ok(result.output.includes("should-not-leak-to-raw-stdout"));
    } finally {
      process.stdout.write = originalWrite;
      presenter.destroy();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("8. 用户消息渲染规范：具备深灰背景 \\x1b[48;5;236m、高亮白字与平直卡片格式", () => {
    const projection = new AgentTranscriptProjection("main");
    projection.addUserMessage("帮我查看当前目录的文件列表");

    const lines = projection.getDisplayLines(80);
    assert.ok(lines.length >= 1, "应当包含至少 1 行用户消息");

    const firstLine = lines[0]!;
    // 验证包含深灰背景 ANSI 236
    assert.ok(
      firstLine.includes("\x1b[48;5;236m"),
      `用户消息必须包含深灰背景色 \\x1b[48;5;236m，实际为: ${firstLine}`
    );
    // 验证包含高亮白字 \\x1b[38;5;255m
    assert.ok(
      firstLine.includes("\x1b[38;5;255m"),
      `用户消息必须包含高亮白字 \\x1b[38;5;255m，实际为: ${firstLine}`
    );
    // 验证包含极简箭头 > 前缀
    assert.ok(
      firstLine.includes(">"),
      `用户消息必须包含 > 箭头前缀，实际为: ${firstLine}`
    );
    // 验证包含用户输入文本
    assert.ok(
      firstLine.includes("帮我查看当前目录的文件列表"),
      `用户消息必须包含用户输入文本，实际为: ${firstLine}`
    );
  });
});
