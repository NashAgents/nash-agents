import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  getSlashCommandSuggestions,
  completeSlashCommand,
  SLASH_COMMANDS,
} from "../src/cli/slash-commands-registry.js";
import { InputManager } from "../src/cli/input-manager.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { SkillService, ensureDefaultSkills, DEFAULT_BUILTIN_SKILLS } from "../src/skills/index.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { SkillsPicker } from "../src/presentation/skills-picker.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { formatToolCallSummary } from "../src/presentation/activity-formatter.js";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";

describe("Slash Command Suggestions & Autocomplete (Terminal Style)", () => {
  test("1. 输入 '/' 能够返回所有可用命令候选列表", () => {
    const suggestions = getSlashCommandSuggestions("/", 50);
    assert.ok(suggestions !== null, "输入 / 应当返回建议结果");
    assert.ok(suggestions.matches.length > 0, "匹配列表应当不为空");
    assert.strictEqual(suggestions.totalMatches, SLASH_COMMANDS.length);

    const names = suggestions.matches.map((m) => m.name);
    assert.ok(names.includes("/skills"), "应当包含 /skills 命令");
    assert.ok(names.includes("/status"), "应当包含 /status 命令");
    assert.ok(names.includes("/diff"), "应当包含 /diff 命令");
  });

  test("2. 输入 '/s' 能够实时过滤匹配候选命令", () => {
    const suggestions = getSlashCommandSuggestions("/s");
    assert.ok(suggestions !== null);
    const names = suggestions.matches.map((m) => m.name);
    assert.ok(names.includes("/skills"), "应当匹配 /skills");
    assert.ok(names.includes("/status"), "应当匹配 /status");
    assert.ok(names.includes("/stats"), "应当匹配 /stats");
    assert.ok(names.includes("/session"), "应当匹配 /session");
    assert.ok(!names.includes("/diff"), "不应包含 /diff");
  });

  test("3. 输入 '/ski' 能够精准提示 '/skills' 且提供 'lls' 的 ghostText", () => {
    const suggestions = getSlashCommandSuggestions("/ski");
    assert.ok(suggestions !== null);
    assert.strictEqual(suggestions.matches.length, 1);
    assert.strictEqual(suggestions.matches[0]!.name, "/skills");
    assert.strictEqual(suggestions.ghostText, "lls");
    assert.strictEqual(suggestions.bestCompletion, "/skills ");
  });

  test("4. completeSlashCommand 能够将 '/ski' 自动补全为 '/skills '", () => {
    const completed = completeSlashCommand("/ski");
    assert.strictEqual(completed, "/skills ");

    const completedDiff = completeSlashCommand("/di");
    assert.strictEqual(completedDiff, "/diff ");

    const noop = completeSlashCommand("hello");
    assert.strictEqual(noop, "hello");
  });

  test("5. 输入 '/skills ' 时能够展示子命令提示 (如 show <name>)", () => {
    const suggestions = getSlashCommandSuggestions("/skills ");
    assert.ok(suggestions !== null);
    assert.ok(suggestions.matches.some((m) => m.name.includes("show <name>")));
  });

  test("6. InputManager 在 session-ready 模式下按 Tab 键自动补全 '/ski' 为 '/skills '", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    (input as any).isTTY = true;
    (output as any).isTTY = true;

    let latestDraft = "";
    const manager = new InputManager({
      input: input as any,
      output: output as any,
      isTTY: true,
    });

    manager.startNavigationMode({
      onComposerChange: (draft) => {
        latestDraft = draft;
      },
    }, "session-ready");

    // 模拟用户键入 "/ski"
    input.write("/ski");
    assert.strictEqual(latestDraft, "/ski");

    // 模拟用户按下 Tab 键 (\t)
    input.write("\t");
    assert.strictEqual(latestDraft, "/skills ", "按下 Tab 后草稿应当补全为 '/skills '");

    manager.close();
  });

  test("7. InputManager 在 running-main 模式下输入 Slash 命令按 Tab 优先补全而非切换 steer/queue", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    (input as any).isTTY = true;
    (output as any).isTTY = true;

    let latestDraft = "";
    let followupModeChanged = false;
    const manager = new InputManager({
      input: input as any,
      output: output as any,
      isTTY: true,
    });

    manager.startNavigationMode({
      onComposerChange: (draft) => {
        latestDraft = draft;
      },
      onFollowupModeChange: () => {
        followupModeChanged = true;
      },
    }, "running-main");

    // 键入 "/resum"
    input.write("/resum");
    assert.strictEqual(latestDraft, "/resum");

    // 按下 Tab
    input.write("\t");
    assert.strictEqual(latestDraft, "/resume ", "应当补全为 /resume ");
    assert.strictEqual(followupModeChanged, false, "输入 slash 命令时不应误触发 steer/queue 切换");

    manager.close();
  });

  test("8. handleSlashCommand 能够智能解析缩写 '/ski' 并直接执行 '/skills'", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-skill-test-"));
    await ensureDefaultSkills(path.join(tempDir, "skills"));
    const skillService = new SkillService({ nashHome: tempDir });

    let renderedInfo = "";
    const mockTerminalUI: any = {
      renderInfo: (msg: string) => { renderedInfo += msg; },
      renderWarning: (msg: string) => {},
      renderError: (msg: string) => {},
    };

    const result = await handleSlashCommand("/ski", {
      inputManager: {} as any,
      terminalUI: mockTerminalUI,
      contextManager: { sessionId: "test", getSession: () => ({} as any) } as any,
      skillService,
    });

    assert.strictEqual(result.handled, true);
    assert.ok(renderedInfo.includes("Available Skills"), "执行 /ski 应当成功路由到 /skills 并展示可用技能列表");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("9. ensureDefaultSkills 能够自动预置 'code-review' 技能及参考清单", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-default-skill-"));
    const skillsDir = path.join(tempDir, "skills");

    const installed = await ensureDefaultSkills(skillsDir);
    assert.ok(installed.includes("code-review"), "应当成功安装 code-review 技能");

    const skillMdPath = path.join(skillsDir, "code-review", "SKILL.md");
    const refMdPath = path.join(skillsDir, "code-review", "references", "review-checklist.md");

    const skillContent = await fs.readFile(skillMdPath, "utf-8");
    assert.ok(skillContent.includes("name: code-review"));
    assert.ok(skillContent.includes("## When to use"));
    assert.ok(skillContent.includes("## Procedure"));
    assert.ok(skillContent.includes("## Verification"));

    const refContent = await fs.readFile(refMdPath, "utf-8");
    assert.ok(refContent.includes("Code Review Checklist"));

    // 二次运行应当保持幂等，不再重复安装
    const secondRun = await ensureDefaultSkills(skillsDir);
    assert.strictEqual(secondRun.length, 0);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("10. CliPresenter 在输入 '/ski' 时渲染建议列表与 ghostText 提示", () => {
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
    presenter.setComposerDraft("/ski", 4);

    const plainOutput = stripAnsi(outputData);
    assert.ok(plainOutput.includes("/skills"), "界面应当渲染 /skills 建议命令");
    assert.ok(plainOutput.includes("> /skills"), "输入行应当呈现 /skills 包含幽灵补全后缀");
    assert.ok(outputData.includes("List and manage available skills"), "应当包含命令描述信息");
    assert.ok(outputData.includes("Tab to autocomplete"), "底栏应当提示 Tab 补全");

    presenter.destroy();
  });

  test("11. formatToolCallSummary 能明确展示 skill_open 加载的具体技能名称", () => {
    const summary = formatToolCallSummary("skill_open", { name: "code-review" });
    assert.strictEqual(summary, "code-review", "应当返回具体技能名而非重叠的 toolName");

    const memSummary = formatToolCallSummary("search_memory", { query: "vitest setup" });
    assert.strictEqual(memSummary, '"vitest setup"');
  });

  test("12. SkillsPicker 框内真实渲染搜索内容，且光标精准位于输入框内 (不泄漏至左下角)", async () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
    });

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    const skillService = new SkillService();
    presenter.openSkillsPicker(skillService);

    // Stream 'data' events are delivered on later ticks, so a synchronous render is not yet in
    // the buffer. Wait for the picker to settle, then only inspect what the query change emits.
    const waitForIdle = async (quietMs = 50, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      let last = -1;
      while (Date.now() < deadline) {
        if (buffer.length === last) {
          await new Promise((r) => setTimeout(r, quietMs));
          if (buffer.length === last) return;
        }
        last = buffer.length;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitForIdle();

    // 模拟用户在输入框内输入 "sdwa"
    const offset = buffer.length;
    presenter.getNavigationHandler().onSkillsQueryChange?.("sdwa");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !buffer.slice(offset).includes("sdwa")) await new Promise((r) => setTimeout(r, 10));
    const rendered = buffer.slice(offset);

    const plain = stripAnsi(rendered);
    assert.ok(plain.includes("│  sdwa"), "输入的内容 'sdwa' 应当真实呈现在搜索框内部");
    assert.ok(rendered.includes("\x1b[19A"), "光标应当向上移动至第 5 行搜索框位置");
    assert.ok(rendered.includes("\x1b[8G\x1b[?25h"), "光标应当精准位于 'sdwa' 字符末尾");
    assert.ok(!rendered.includes("\x1b[1G\x1b[?25h"), "光标绝不得泄露停留在屏幕最左下角第 1 列");

    presenter.destroy();
  });

  test("13. renderNativeScrollback 绝不输出 'Transcript updated' 破坏滚动区一致性", () => {
    const stream = new PassThrough() as unknown as NodeJS.WriteStream;
    (stream as any).isTTY = true;
    (stream as any).columns = 80;
    (stream as any).rows = 24;

    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
    });

    const presenter = new CliPresenter({
      eventBus: new EventBus(),
      agentRegistry: new AgentRegistry(),
      stdout: stream,
      isTTY: true,
      nativeScrollback: true,
    });

    // 产生动态历史
    presenter.appendTranscript({
      id: "1",
      agentId: "main",
      kind: "thought",
      timestamp: Date.now(),
      text: "Thinking 1.0s",
    });
    presenter.render();

    // 更新同一行
    presenter.appendTranscript({
      id: "2",
      agentId: "main",
      kind: "thought",
      timestamp: Date.now(),
      text: "Thinking 2.5s",
    });
    presenter.render();

    assert.ok(!buffer.includes("Transcript updated"), "终端输出中严禁出现 Transcript updated 冗余污染标记");

    presenter.destroy();
  });

  test("14. 系统内置默认 3 个基础技能 (code-review, git-commit, test-runner)", () => {
    const names = DEFAULT_BUILTIN_SKILLS.map((s) => s.name);
    assert.ok(names.includes("code-review"), "应当包含 code-review");
    assert.ok(names.includes("git-commit"), "应当包含 git-commit");
    assert.ok(names.includes("test-runner"), "应当包含 test-runner");
    assert.strictEqual(names.length, 3);
  });

  test("15. SkillsPicker 支持上下键聚焦移动、着重高亮并展示详情描述，回车循环切换模式", () => {
    const picker = new SkillsPicker([
      {
        metadata: {
          name: "code-review",
          description: "Review recent code changes or Git diff.",
          scope: "global",
          directoryPath: "/tmp",
          skillFilePath: "/tmp/SKILL.md",
        },
        mode: "on",
        estimatedTokens: 115,
      },
      {
        metadata: {
          name: "git-commit",
          description: "Author clear conventional commit messages.",
          scope: "global",
          directoryPath: "/tmp",
          skillFilePath: "/tmp/SKILL.md",
        },
        mode: "on",
        estimatedTokens: 140,
      },
      {
        metadata: {
          name: "test-runner",
          description: "Execute automated test suites and diagnose failures.",
          scope: "global",
          directoryPath: "/tmp",
          skillFilePath: "/tmp/SKILL.md",
        },
        mode: "on",
        estimatedTokens: 120,
      },
    ]);

    // 初始项选中为 0: code-review
    assert.strictEqual(picker.selectedIndex, 0);
    const render0 = picker.render(80, 24).join("\n");
    assert.ok(render0.includes("❯"), "选中项应当显示亮色 ❯ 箭头");
    assert.ok(render0.includes("code-review"), "选中项包含名称");
    assert.ok(render0.includes("↳"), "选中项应当通过 ↳ 展开描述行");
    assert.ok(render0.includes("Review recent code changes"), "应当展开首项的详细描述");

    // 向下移动光标 (选到 git-commit)
    picker.move(1);
    assert.strictEqual(picker.selectedIndex, 1);
    const render1 = picker.render(80, 24).join("\n");
    assert.ok(render1.includes("Author clear conventional commit messages."), "移动后应当着重展开 git-commit 描述");

    // 回车切换模式 (cycleCurrentMode)
    const cycle1 = picker.cycleCurrentMode();
    assert.strictEqual(cycle1?.name, "git-commit");
    assert.strictEqual(cycle1?.newMode, "off");

    const cycle2 = picker.cycleCurrentMode();
    assert.strictEqual(cycle2?.newMode, "name-only");

    const cycle3 = picker.cycleCurrentMode();
    assert.strictEqual(cycle3?.newMode, "user-only");

    const cycle4 = picker.cycleCurrentMode();
    assert.strictEqual(cycle4?.newMode, "on");

    // 再次向下移动光标 (选到 test-runner)
    picker.move(1);
    assert.strictEqual(picker.selectedIndex, 2);
    const render2 = picker.render(80, 24).join("\n");
    assert.ok(render2.includes("Execute automated test suites"), "移动后应当着重展开 test-runner 描述");
  });

  test("16. /compact 在交互式 TTY 下绝不向 stdout 裸写文本，而是通过 Presenter 系统通知与状态栏反馈优雅呈现", async () => {
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

    let stdoutRawWritten = "";
    const mockTerminalUI: any = {
      renderInfo: (msg: string) => { stdoutRawWritten += msg; },
      renderWarning: (msg: string) => { stdoutRawWritten += msg; },
      renderError: (msg: string) => { stdoutRawWritten += msg; },
    };

    let compactedNowCalled = false;
    const mockContextManager: any = {
      sessionId: "test-sess",
      compactNow: async () => {
        compactedNowCalled = true;
        return {
          id: "comp-1",
          type: "compaction",
          summary: "test summary",
          compactedRange: { startIndex: 1, endIndex: 4 },
          consolidatedCount: 1,
          createdAt: Date.now(),
        };
      },
    };

    const result = await handleSlashCommand("/compact", {
      inputManager: {} as any,
      terminalUI: mockTerminalUI,
      contextManager: mockContextManager,
      cliPresenter: presenter,
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(compactedNowCalled, true, "应当调用 contextManager.compactNow");
    assert.strictEqual(stdoutRawWritten, "", "交互式 TTY 下严禁向 terminalUI 裸写文本造成光标下移和残影");

    // 检查 Main 投影中的 system_notice
    const mainEntries = presenter.getProjection("main").getDisplayLines();
    const joined = stripAnsi(mainEntries.join("\n"));
    assert.ok(joined.includes("Context compacted successfully! Consolidated 4 messages"), "Main 视口应追加标准压缩完成通知");

    presenter.destroy();
  });

  test("17. /compact 在上下文过短无需压缩时，通过 Presenter 反馈提示，零控制台行污染", async () => {
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

    let stdoutRawWritten = "";
    const mockTerminalUI: any = {
      renderInfo: (msg: string) => { stdoutRawWritten += msg; },
      renderWarning: (msg: string) => { stdoutRawWritten += msg; },
      renderError: (msg: string) => { stdoutRawWritten += msg; },
    };

    const mockContextManager: any = {
      sessionId: "test-sess",
      compactNow: async () => null, // 消息过少，返回 null
    };

    const result = await handleSlashCommand("/compact", {
      inputManager: {} as any,
      terminalUI: mockTerminalUI,
      contextManager: mockContextManager,
      cliPresenter: presenter,
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(stdoutRawWritten, "", "无需压缩时严禁向 terminalUI 裸写换行");

    presenter.destroy();
  });

  test("18. /help 在交互式 TTY 下通过 prepareForDirectTerminalOutput 安全清退 Live 区域，防止界面重叠错位", async () => {
    let prepareCalled = false;
    let renderCalled = false;
    let helpRendered = false;

    const mockPresenter: any = {
      isInteractiveTTY: () => true,
      prepareForDirectTerminalOutput: () => { prepareCalled = true; },
      requestRender: () => { renderCalled = true; },
    };

    const mockTerminalUI: any = {
      renderHelp: () => {
        assert.strictEqual(prepareCalled, true, "在打印帮助前必须先调用 prepareForDirectTerminalOutput 清退 Live 区域");
        helpRendered = true;
      },
    };

    const result = await handleSlashCommand("/help", {
      inputManager: {} as any,
      terminalUI: mockTerminalUI,
      contextManager: {} as any,
      cliPresenter: mockPresenter,
    });

    assert.strictEqual(result.handled, true);
    assert.strictEqual(helpRendered, true);
    assert.strictEqual(renderCalled, true, "打印帮助后必须请求 requestRender 恢复绘制 Live 输入区");
  });
});


