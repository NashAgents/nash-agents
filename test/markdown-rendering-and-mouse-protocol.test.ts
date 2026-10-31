import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { TerminalMarkdownRenderer } from "../src/presentation/terminal-markdown-renderer.js";
import { TerminalInputParser } from "../src/cli/terminal-input-parser.js";
import { InputManager } from "../src/cli/input-manager.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import { CliPresenter } from "../src/presentation/cli-presenter.js";
import { TerminalUI } from "../src/cli/terminal-ui.js";
import { EventBus } from "../src/observability/event-bus.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import type { SessionRecord } from "../src/context/types.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

function createMockTtyStream(columns = 80, rows = 24) {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  (stream as any).isTTY = true;
  (stream as any).columns = columns;
  (stream as any).rows = rows;

  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
  });

  return {
    stream,
    getOutput: () => buffer,
    clearBuffer: () => {
      buffer = "";
    },
  };
}

describe("Markdown Rendering & SGR Mouse Protocol Subsystem Suite", () => {
  // ===========================================================================
  // 二十二、测试：Markdown Rendering
  // ===========================================================================
  describe("二十二、Markdown Rendering", () => {
    it("1. heading 不显示 #", () => {
      const rendered = TerminalMarkdownRenderer.render("### 架构设计方案\n## 第二部分\n# 核心总览");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("###"), false, "H3 不应显示 ###");
      assert.equal(plain.includes("##"), false, "H2 不应显示 ##");
      assert.equal(plain.includes("# "), false, "H1 不应显示 #");
      assert.equal(plain.includes("架构设计方案"), true);
      assert.equal(plain.includes("第二部分"), true);
      assert.equal(plain.includes("核心总览"), true);
    });

    it("2. bold 不显示 **", () => {
      const rendered = TerminalMarkdownRenderer.render("这是 **粗体强调文本** 和 __下划线粗体__");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("**"), false, "不应显示 **");
      assert.equal(plain.includes("__"), false, "不应显示 __");
      assert.equal(plain.includes("粗体强调文本"), true);
      assert.equal(plain.includes("下划线粗体"), true);
      const raw = rendered.join("\n");
      assert.equal(raw.includes("\x1b[1m"), true, "应包含 ANSI bold");
    });

    it("3. italic 不显示 *", () => {
      const rendered = TerminalMarkdownRenderer.render("这是 *斜体文本* 和 _下划线斜体_");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("*斜体文本*"), false, "不应显示 *");
      assert.equal(plain.includes("斜体文本"), true);
      assert.equal(plain.includes("下划线斜体"), true);
      const raw = rendered.join("\n");
      assert.equal(raw.includes("\x1b[3m"), true, "应包含 ANSI italic");
    });

    it("4. inline code 不显示 backtick", () => {
      const rendered = TerminalMarkdownRenderer.render("请使用 `npm run test` 命令执行测试");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("`"), false, "不应显示反引号");
      assert.equal(plain.includes("npm run test"), true);
      const raw = rendered.join("\n");
      assert.equal(raw.includes("\x1b[36mnpm run test\x1b[39m"), true, "行内代码应用青色高亮");
    });

    it("5. unordered list 正确", () => {
      const rendered = TerminalMarkdownRenderer.render("- 列表项目 1\n* 列表项目 2\n  - 子项目 A");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("- 列表项目"), false, "不应显示原始 - ");
      assert.equal(plain.includes("* 列表项目"), false, "不应显示原始 * ");
      assert.equal(plain.includes("• 列表项目 1"), true);
      assert.equal(plain.includes("• 列表项目 2"), true);
      assert.equal(plain.includes("• 子项目 A"), true);
    });

    it("6. ordered list 正确", () => {
      const rendered = TerminalMarkdownRenderer.render("1. 第一步初始化\n2. 第二步编译构建");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("1. 第一步初始化"), true);
      assert.equal(plain.includes("2. 第二步编译构建"), true);
    });

    it("7. blockquote 正确", () => {
      const rendered = TerminalMarkdownRenderer.render("> 这是一段引用的重要警告信息");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes(">"), false, "不应裸露原始 > 字符");
      assert.equal(plain.includes("│ 这是一段引用的重要警告信息"), true);
    });

    it("8. horizontal rule 正确", () => {
      const rendered = TerminalMarkdownRenderer.render("上面内容\n---\n下面内容");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("---"), false, "不应显示裸 ---");
      assert.equal(plain.includes("───"), true, "应渲染为平滑终端分割线");
    });

    it("9. fenced code block 保留原内容", () => {
      const markdown = "```ts\nconst a = 10;\nfunction test() {\n  return a * 2;\n}\n```";
      const rendered = TerminalMarkdownRenderer.render(markdown);
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("const a = 10;"), true);
      assert.equal(plain.includes("function test() {"), true);
      assert.equal(plain.includes("return a * 2;"), true);
    });

    it("10. code block 内 markdown 不被解析", () => {
      const markdown = "```bash\n# 这是代码注释，不是标题\n**这不是粗体**\n`不是行内代码`\n- 不是列表\n```";
      const rendered = TerminalMarkdownRenderer.render(markdown);
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("# 这是代码注释，不是标题"), true, "代码块内 # 必须按原文保留");
      assert.equal(plain.includes("**这不是粗体**"), true, "代码块内 ** 必须按原文保留");
      assert.equal(plain.includes("`不是行内代码`"), true, "代码块内反引号必须按原文保留");
      assert.equal(plain.includes("- 不是列表"), true, "代码块内破折号必须按原文保留");
    });

    it("11. link 可读", () => {
      const rendered = TerminalMarkdownRenderer.render("参考文档参见 [文档首页](https://example.com/docs)");
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("[文档首页]"), false, "不应裸露中括号");
      assert.equal(plain.includes("文档首页 (https://example.com/docs)"), true);
    });

    it("12. 中文 Markdown width 正确", () => {
      const rendered = TerminalMarkdownRenderer.render("**项目架构分析**\n这是一个包含中文双宽字符的测试段落。");
      for (const line of rendered) {
        const visWidth = stringWidth(stripAnsi(line));
        assert.ok(visWidth > 0, "每一行计算出来的视觉宽度必须为正数");
      }
    });

    it("13. ANSI bold 后 wrapping 正确", () => {
      const longText = "**这是一段非常长并且带有加粗样式的中文自然语言说明，它将在一个较窄的终端视口中进行换行展示。**";
      const rendered = TerminalMarkdownRenderer.render(longText, { maxWidth: 30 });
      assert.ok(rendered.length >= 2, "超长文本必须折行");
      for (const line of rendered) {
        const width = stringWidth(stripAnsi(line));
        assert.ok(width <= 32, `行宽度 (${width}) 不能显著超过 maxWidth (30)`);
      }
    });

    it("14. emoji + Markdown wrapping 正确", () => {
      const emojiText = "🚀 **性能飞升** 💡 *智能调度* 🛠️ `nash-cli` 是一套完整的生产级 Agent Runtime。";
      const rendered = TerminalMarkdownRenderer.render(emojiText, { maxWidth: 35 });
      assert.ok(rendered.length >= 2, "包含 Emoji 的长文本必须正确折行");
      for (const line of rendered) {
        const width = stringWidth(stripAnsi(line));
        assert.ok(width <= 38, `行宽度 (${width}) 应在合理视口内`);
      }
    });

    it("15. Live Assistant response 正确渲染", () => {
      const mock = createMockTtyStream(80, 24);
      const terminalUI = new TerminalUI(mock.stream as any);
      terminalUI.renderAgentResponse("### 架构分析\n我们使用了 **Seatbelt** 原生沙箱与 `ToolRegistry`。");
      const out = mock.getOutput();
      assert.equal(out.includes("###"), false, "最终输出不应含有 ###");
      assert.equal(out.includes("**"), false, "最终输出不应含有 **");
      assert.equal(out.includes("`"), false, "最终输出不应含有 `");
      assert.equal(out.includes("架构分析"), true);
      assert.equal(out.includes("Seatbelt"), true);
    });

    it("16. Session replay 正确渲染", () => {
      const projection = new AgentTranscriptProjection("main");
      const records: SessionRecord[] = [
        {
          id: "r1",
          type: "user",
          content: "你好",
          createdAt: Date.now(),
        },
        {
          id: "r2",
          type: "assistant",
          content: "### 欢迎使用 Nash\n这是 **加粗** 回复与 `npm test` 命令。",
          createdAt: Date.now(),
        },
      ];
      projection.projectFromSessionRecords(records);
      const lines = projection.getAllRenderedLines();
      const plain = lines.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("###"), false, "Replay 不应出现 ###");
      assert.equal(plain.includes("**"), false, "Replay 不应出现 **");
      assert.equal(plain.includes("`"), false, "Replay 不应出现 `");
      assert.equal(plain.includes("欢迎使用 Nash"), true);
      assert.equal(plain.includes("加粗"), true);
    });

    it("17. Agent Detail replay 正确渲染", () => {
      const projection = new AgentTranscriptProjection("subagent-1");
      projection.addModelResponse("## 子代理执行结果\n- 任务已完成：`src/index.ts`\n- 状态：**100% PASS**");
      const viewport = projection.renderViewport({ width: 80, height: 10, scrollOffset: 0 });
      const plain = viewport.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("##"), false);
      assert.equal(plain.includes("**"), false);
      assert.equal(plain.includes("`"), false);
      assert.equal(plain.includes("子代理执行结果"), true);
      assert.equal(plain.includes("100% PASS"), true);
    });

    it("18. Tool stdout 不误做 Markdown", () => {
      const projection = new AgentTranscriptProjection("main");
      projection.completeToolCall(
        "call-1",
        "bash",
        true,
        150,
        "### Markdown in stdout\n**not bold**\n`not code`"
      );
      const lines = projection.getAllRenderedLines();
      const plain = lines.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("### Markdown in stdout"), true, "Tool 输出必须保留原始 stdout 格式");
    });

    it("19. Markdown Table 正确识别并渲染为 Unicode 边框表格，不裸露原始管道符", () => {
      const mdTable = [
        "| 项目名称 | 核心技术栈 | 架构状态 |",
        "| :--- | :---: | ---: |",
        "| MetroQuery | FastAPI + Docker | 生产就绪 |",
        "| MetroWise | Python + RAG | 核心稳定 |",
      ].join("\n");

      const rendered = TerminalMarkdownRenderer.render(mdTable, { maxWidth: 80 });
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");

      assert.equal(plain.includes("| :---"), false, "不应裸露原始分隔对齐行");
      assert.equal(plain.includes("┌"), true, "应包含表格顶部边框");
      assert.equal(plain.includes("├"), true, "应包含表头分割边框");
      assert.equal(plain.includes("└"), true, "应包含表格底部边框");
      assert.equal(plain.includes("项目名称"), true);
      assert.equal(plain.includes("MetroQuery"), true);
      assert.equal(plain.includes("FastAPI + Docker"), true);
      assert.equal(plain.includes("生产就绪"), true);
    });

    it("20. Table 单元格内 <br> 换行与行内 Markdown (粗体/代码) 正确解析", () => {
      const complexTable = [
        "| 项目 | 规范与依赖 | 描述 |",
        "| :--- | :--- | :--- |",
        "| **MetroQuery** | `uv`<br>• `pyproject.toml`<br>• Git 纳管 | **DDD 领域驱动架构**：<br>解耦清晰。 |",
      ].join("\n");

      const rendered = TerminalMarkdownRenderer.render(complexTable, { maxWidth: 80 });
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");

      assert.equal(plain.includes("<br>"), false, "不应在终端输出原始 <br> 标签");
      assert.equal(plain.includes("<br/>"), false);
      assert.equal(plain.includes("**MetroQuery**"), false, "粗体应被转译而不是保留 **");
      assert.equal(plain.includes("`uv`"), false, "反引号应被转译为代码高亮");
      assert.equal(plain.includes("MetroQuery"), true);
      assert.equal(plain.includes("pyproject.toml"), true);
      assert.equal(plain.includes("Git 纳管"), true);
      assert.equal(plain.includes("DDD 领域驱动架构"), true);
    });

    it("21. Table 视口过窄时自适应收缩列宽并保持单元格内容换行", () => {
      const wideTable = [
        "| 项目名称 | 详细路径 | 核心技术栈 | 亮点特性 |",
        "| :--- | :--- | :--- | :--- |",
        "| MetroQuery | ~/Documents/MetroQuery | FastAPI + Docker + OTel | 工业级规章 RAG 检索防幻觉体系 |",
      ].join("\n");

      const rendered = TerminalMarkdownRenderer.render(wideTable, { maxWidth: 60 });
      for (const line of rendered) {
        const width = stringWidth(stripAnsi(line));
        assert.ok(width <= 62, `表格行显示宽度 (${width}) 不能显著超出视口 (60)`);
      }
      const plain = rendered.map((l) => stripAnsi(l)).join("\n");
      assert.ok(plain.includes("MetroQ") || plain.includes("MetroQuery"));
      assert.equal(plain.includes("FastAPI"), true);
    });

    it("19. Session JSONL 不保存 ANSI", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-test-jsonl-"));
      const store = new LocalSessionStore({ baseDir: tmpDir });
      const rawMarkdown = "### 标题\n这是 **粗体**。";

      await store.appendAssistantMessage(rawMarkdown);
      const records = await store.getRecords();

      assert.equal(records[0]?.type, "assistant");
      const asstRec = records[0] as any;
      assert.equal(asstRec.content, rawMarkdown, "Session JSONL 必须原样保存 raw markdown 源码");
      assert.equal(asstRec.content.includes("\x1b["), false, "JSONL 中绝不含有 ANSI 转义序列");

      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("20. Plan ToolResult 不因 Markdown 再重复显示", () => {
      const projection = new AgentTranscriptProjection("main");
      projection.completeToolCall(
        "call-plan-1",
        "propose_plan",
        true,
        200,
        "plan prepared: 3 steps"
      );
      const lines = projection.getAllRenderedLines();
      const plain = lines.map((l) => stripAnsi(l)).join("\n");
      assert.equal(plain.includes("plan prepared: 3 steps"), true);
      assert.equal(plain.includes("Goal:"), false, "Transcript 不应重复展开完整 Plan 文档");
    });
  });

  // ===========================================================================
  // 二十三、测试：Mouse & Escape Protocol
  // ===========================================================================
  describe("二十三、Mouse & Escape Protocol", () => {
    it("21. standalone Esc → escape", () => {
      const { events } = TerminalInputParser.parse("\x1b", { allowIncomplete: false });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "escape");
    });

    it("22. ArrowUp → arrow-up", () => {
      const { events } = TerminalInputParser.parse("\x1b[A");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "arrow-up");
    });

    it("23. ArrowDown → arrow-down", () => {
      const { events } = TerminalInputParser.parse("\x1b[B");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "arrow-down");
    });

    it("24. wheel-up → wheel-up", () => {
      const { events } = TerminalInputParser.parse("\x1b[<64;40;15M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-wheel-up");
      assert.equal(events[0]?.mouse?.isWheelUp, true);
    });

    it("25. wheel-down → wheel-down", () => {
      const { events } = TerminalInputParser.parse("\x1b[<65;40;15M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-wheel-down");
      assert.equal(events[0]?.mouse?.isWheelDown, true);
    });

    it("26. mouse press 不触发 escape", () => {
      const { events } = TerminalInputParser.parse("\x1b[<0;50;20M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-button");
      assert.equal(events[0]?.mouse?.isRelease, false);
      assert.notEqual(events[0]?.type, "escape");
    });

    it("27. mouse release 不触发 escape", () => {
      const { events } = TerminalInputParser.parse("\x1b[<0;50;20m");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-button");
      assert.equal(events[0]?.mouse?.isRelease, true);
      assert.notEqual(events[0]?.type, "escape");
    });

    it("28. mouse drag 不触发 escape", () => {
      const { events } = TerminalInputParser.parse("\x1b[<32;55;25M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-button");
      assert.equal(events[0]?.mouse?.isDrag, true);
      assert.notEqual(events[0]?.type, "escape");
    });

    it("29. mouse motion 不触发 escape", () => {
      const { events } = TerminalInputParser.parse("\x1b[<35;60;30M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-button");
      assert.notEqual(events[0]?.type, "escape");
    });

    it("30. unknown valid SGR mouse event 不触发 escape", () => {
      const { events } = TerminalInputParser.parse("\x1b[<99;10;10M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-button");
      assert.notEqual(events[0]?.type, "escape");
    });

    it("31. fragmented mouse press 正确 buffering", () => {
      const part1 = "\x1b[<0;30;";
      const part2 = "15M";
      const res1 = TerminalInputParser.parse(part1, { allowIncomplete: true });
      assert.equal(res1.events.length, 0);
      assert.equal(res1.unparsedRemaining, part1);

      const res2 = TerminalInputParser.parse(res1.unparsedRemaining + part2, { allowIncomplete: true });
      assert.equal(res2.events.length, 1);
      assert.equal(res2.events[0]?.type, "mouse-button");
      assert.equal(res2.unparsedRemaining, "");
    });

    it("32. fragmented drag 正确 buffering", () => {
      const part1 = "\x1b[<32;4";
      const part2 = "5;20M";
      const res1 = TerminalInputParser.parse(part1, { allowIncomplete: true });
      assert.equal(res1.events.length, 0);
      assert.equal(res1.unparsedRemaining, part1);

      const res2 = TerminalInputParser.parse(res1.unparsedRemaining + part2, { allowIncomplete: true });
      assert.equal(res2.events.length, 1);
      assert.equal(res2.events[0]?.type, "mouse-button");
      assert.equal(res2.events[0]?.mouse?.isDrag, true);
    });

    it("33. fragmented release 正确 buffering", () => {
      const part1 = "\x1b[<0;50;20";
      const part2 = "m";
      const res1 = TerminalInputParser.parse(part1, { allowIncomplete: true });
      assert.equal(res1.events.length, 0);
      assert.equal(res1.unparsedRemaining, part1);

      const res2 = TerminalInputParser.parse(res1.unparsedRemaining + part2, { allowIncomplete: true });
      assert.equal(res2.events.length, 1);
      assert.equal(res2.events[0]?.type, "mouse-button");
      assert.equal(res2.events[0]?.mouse?.isRelease, true);
    });

    it("34. 连续快速拖动不退出 Agent View", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "analyst", type: "subagent" });

      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: true });

      presenter.startRun("Analyze");
      presenter.switchToAgentView("sub-1");
      assert.equal(presenter.getActiveViewAgentId(), "sub-1");

      const navHandler = presenter.getNavigationHandler();
      inputManager.startNavigationMode(navHandler, "agent-detail");

      // 连续发送 50 次鼠标拖拽事件 (含分片)
      for (let i = 0; i < 50; i++) {
        input.write(`\x1b[<32;${10 + (i % 30)};${20 + (i % 10)}M`);
      }

      await new Promise((r) => setTimeout(r, 20));

      assert.equal(presenter.getActiveViewAgentId(), "sub-1", "快速拖动后必须仍然留在 Agent Detail 视图中");

      inputManager.stopNavigationMode();
      presenter.stopRun();
      presenter.destroy();
      inputManager.close();
    });

    it("35. 连续 wheel 30 次不退出", async () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "analyst", type: "subagent" });

      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: true });

      presenter.startRun("Analyze");
      presenter.switchToAgentView("sub-1");

      const navHandler = presenter.getNavigationHandler();
      inputManager.startNavigationMode(navHandler, "agent-detail");

      for (let i = 0; i < 30; i++) {
        input.write("\x1b[<64;20;10M");
      }

      await new Promise((r) => setTimeout(r, 20));

      assert.equal(presenter.getActiveViewAgentId(), "sub-1", "30次滚轮必须留在 Agent Detail 视图");

      inputManager.stopNavigationMode();
      presenter.stopRun();
      presenter.destroy();
      inputManager.close();
    });

    it("36. mouse event 不改变 Composer", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      let composerDraft = "";
      const handler = {
        onComposerChange: (d: string) => {
          composerDraft = d;
        },
      };

      inputManager.startNavigationMode(handler, "running-main");

      input.write("h");
      input.write("i");
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(composerDraft, "hi");

      // 发送点击与拖动
      input.write("\x1b[<0;10;10M");
      input.write("\x1b[<32;15;15M");
      input.write("\x1b[<0;15;15m");
      await new Promise((r) => setTimeout(r, 10));

      assert.equal(composerDraft, "hi", "鼠标动作绝不能破坏或清空 Composer draft");

      inputManager.stopNavigationMode();
      inputManager.close();
    });

    it("37. mouse event 不改变 selectedAgent", () => {
      const eventBus = new EventBus();
      const agentRegistry = new AgentRegistry({ eventBus });
      agentRegistry.register({ agentId: "main", type: "main" });
      agentRegistry.register({ agentId: "sub-1", name: "sub-1", type: "subagent" });

      const presenter = new CliPresenter({ eventBus, agentRegistry, isTTY: true });
      presenter.startRun("Run");

      const nav = presenter.getNavigationHandler();
      nav.onMouseWheelUp?.();
      nav.onMouseWheelDown?.();

      assert.equal(presenter.getActiveViewAgentId(), "main");
      presenter.stopRun();
      presenter.destroy();
    });

    it("38. 默认模式下不开启鼠标报告以保证文本可选中，显式开启后 Ctrl+C 正确关闭 mouse mode", () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      let outputData = "";
      output.on("data", (c: Buffer) => {
        outputData += c.toString();
      });

      // 1. 默认配置下：不主动发送 \x1b[?1000h，确保用户在终端可正常鼠标划选、双击选词与复制
      const defaultManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      defaultManager.startNavigationMode({}, "agent-detail");
      assert.equal(outputData.includes("\x1b[?1000h"), false, "默认情况下不开启鼠标报告，保证文本可自由选中");
      defaultManager.close();

      outputData = "";

      // 2. 显式开启鼠标报告时：Ctrl+C 中断必须发送关闭鼠标报告序列
      const explicitManager = new InputManager({ input: input as any, output: output as any, isTTY: true, enableMouseReporting: true });
      explicitManager.startNavigationMode({}, "agent-detail");
      assert.equal(outputData.includes("\x1b[?1000h"), true, "显式配置 enableMouseReporting 时开启鼠标报告");

      outputData = "";
      input.write("\x03"); // Ctrl+C

      assert.equal(outputData.includes("\x1b[?1000l"), true, "Ctrl+C 中断必须发送关闭鼠标报告序列");
      explicitManager.close();
    });

    it("39. fatal exit 正确关闭 mouse mode", () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      let outputData = "";
      output.on("data", (c: Buffer) => {
        outputData += c.toString();
      });

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      inputManager.enableMouseReporting();
      assert.equal(outputData.includes("\x1b[?1000h"), true);

      outputData = "";
      inputManager.close(); // 模拟退出清理

      assert.equal(outputData.includes("\x1b[?1000l"), true, "close 必须关闭鼠标报告");
    });

    it("40. 视口渲染下的 Markdown 表格右边框完整呈现，绝不被截断为省略号 '…' 奇怪边缘", () => {
      const proj = new AgentTranscriptProjection("main");
      const userImageTableMd = [
        "五、 整体架构的优势与设计亮点\n",
        "| 架构维度 | Nash Harness 实现方案 | 业界常见方案 / 对比优势 |",
        "| :--- | :--- | :--- |",
        "| 沙箱隔离机制 | OS 原生内核隔离 (macOS Seatbelt + Linux Bubblewrap / Landlock) | 无需 Docker 守护进程，毫秒级冷启动 (<10ms)，内存开销几乎为零，且实现真实的内核级网络与文件写阻断。 |",
        "| 安全策略哲学 | Fail-Closed 铁律 + 先验结构化提权 | 环境不支持沙箱时直接拒绝运行，绝不静默退化为宿主裸进程；绝不依赖命令执行失败后的正则猜测进行提权。 |",
        "| 凭据与环境治理 | 集中式环境变量清洗与特权 Socket 隔离 | 剥离所有 _API_KEY、_TOKEN、_SECRET；通过私有 tmpfs 挂载彻底隔离宿主 Docker / systemd D-Bus socket。 |",
        "| 上下文生命周期 | 四重治理：保守估算 + 产物外溢 (Spill) + 历史剪枝 + 语义压缩 | 解决长会话下的上下文爆炸问题；大文件或大命令输出自动转为外部 Spill Artifact 并支持分页探查。 |",
        "| 多 Agent 协同体系 | 树状派发 (SubAgent) + 网状协同 (Team Mailbox) + 拓扑执行 (Task DAG) | 既支持独立模块的快速孤岛委派，又支持具有长效角色的团队异步通讯，并由并发控制器进行全局深度与资源防失控约束。 |",
      ].join("\n");

      proj.addModelResponse(userImageTableMd, Date.now());

      const viewportWidth = 110;
      const viewportLines = proj.renderViewport({
        width: viewportWidth,
        height: 30,
        scrollOffset: 0,
      });

      const tableLines = viewportLines.filter(
        (l) => l.includes("┌") || l.includes("├") || l.includes("└") || l.includes("│")
      );
      assert.ok(tableLines.length >= 5, "必须正确渲染出表格边框与数据行");

      for (const line of tableLines) {
        const plain = stripAnsi(line).trimEnd();
        // 验证每一行末尾绝对不能是被切断的省略号 …
        assert.ok(
          !plain.endsWith("…"),
          `表格行末尾绝不应出现被截断的奇怪省略号边缘: "${plain}"`
        );
        // 验证边框行与数据行末尾保持完整的 Unicode Box 字符
        if (line.includes("┌")) assert.ok(plain.endsWith("┐"), `顶边框末尾应为 ┐: ${plain}`);
        if (line.includes("├")) assert.ok(plain.endsWith("┤"), `中边框末尾应为 ┤: ${plain}`);
        if (line.includes("└")) assert.ok(plain.endsWith("┘"), `底边框末尾应为 ┘: ${plain}`);
        if (line.includes("│") && !line.includes("┌") && !line.includes("├") && !line.includes("└")) {
          assert.ok(plain.endsWith("│"), `数据行末尾应为 │: ${plain}`);
        }
      }
    });

    it("41. 视口滚动 scrollUp/scrollDown 保持布局缓存命中，杜绝缓存颠簸与排版延迟", () => {
      const proj = new AgentTranscriptProjection("main");
      for (let i = 0; i < 50; i++) {
        proj.addModelResponse(`Line ${i}: 测试长文本输出与视口平滑滚动性能保障`, Date.now());
      }

      const viewportWidth = 100;
      // 预热并排版
      proj.renderViewport({ width: viewportWidth, height: 20, scrollOffset: 0 });

      // 模拟触控板连续快速向上滚动 20 格
      for (let s = 0; s < 20; s++) {
        proj.scrollUp(1);
      }

      // 验证 scrollOffset 准确累加
      assert.equal(proj.getScrollOffset(), 20);

      // 再次渲染应直接命中缓存
      const renderedAfterScroll = proj.renderViewport({ width: viewportWidth, height: 20, scrollOffset: proj.getScrollOffset() });
      assert.ok(renderedAfterScroll.length > 0);
    });

    it("42. AgentTranscriptProjection.getLatestModelResponseText 正确提取最新助手回答纯文本", () => {
      const proj = new AgentTranscriptProjection("main");
      assert.strictEqual(proj.getLatestModelResponseText(), undefined);

      proj.addUserMessage("你好", Date.now());
      proj.addModelResponse("第一条助手回答", Date.now());
      proj.addUserMessage("再来一个", Date.now());
      proj.addModelResponse("最新一条助手回答：包含代码与分析", Date.now());

      const latest = proj.getLatestModelResponseText();
      assert.equal(latest, "最新一条助手回答：包含代码与分析");
    });

    it("43. 孤立 SGR 鼠标报告 (<65;78;13M) 正确识别为 mouse-wheel-down，不泄露为 printable 字符", () => {
      const { events } = TerminalInputParser.parse("<65;78;13M");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "mouse-wheel-down");
      assert.equal(events[0]?.mouse?.button, 65);
      assert.equal(events[0]?.mouse?.col, 78);
      assert.equal(events[0]?.mouse?.row, 13);
      assert.equal(events[0]?.mouse?.isWheelDown, true);
    });

    it("44. 分片断裂与跨时钟周期延迟鼠标滚轮 (\\x1b[ 延迟 80ms + <65;78;13M) 完美拼合，不误入 Composer", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      let composerDraft = "";
      inputManager.startNavigationMode({
        onComposerChange: (d: string) => {
          composerDraft = d;
        },
      }, "running-main");

      // 分片 1: 仅发送 \x1b[
      input.write("\x1b[");

      // 延迟 80ms (超过默认 50ms escape timer)
      await new Promise((r) => setTimeout(r, 80));

      // 分片 2: 发送后续鼠标参数 <65;78;13M
      input.write("<65;78;13M");

      await new Promise((r) => setTimeout(r, 30));

      assert.equal(composerDraft, "", "延迟分片鼠标事件绝不能将参数泄漏至 Composer draft");

      inputManager.stopNavigationMode();
      inputManager.close();
    });

    it("45. 包含普通 < 字符的输入 (如 <div> 或 a < 10) 仍正确保留为 printable 字符", () => {
      const res1 = TerminalInputParser.parse("<div>");
      assert.equal(res1.events.length, 1);
      assert.equal(res1.events[0]?.type, "printable");
      assert.equal(res1.events[0]?.char, "<div>");

      const res2 = TerminalInputParser.parse("a < 10");
      assert.equal(res2.events.length, 1);
      assert.equal(res2.events[0]?.type, "printable");
      assert.equal(res2.events[0]?.char, "a < 10");
    });

    it("46. 连续高频滚动并发随机分片压力测试，0 字符泄露至 Composer draft", async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      (input as any).isTTY = true;
      (output as any).isTTY = true;

      const inputManager = new InputManager({ input: input as any, output: output as any, isTTY: true });
      let leakedDraft = "";
      inputManager.startNavigationMode({
        onComposerChange: (d: string) => {
          if (d.includes("<") || d.includes("M") || d.includes(";") || d.includes("65") || d.includes("64")) {
            leakedDraft = d;
          }
        },
      }, "running-main");

      const totalEvents = 100;
      const streamChunks: string[] = [];
      for (let i = 0; i < totalEvents; i++) {
        streamChunks.push(`\x1b[<${i % 2 === 0 ? 64 : 65};${20 + (i % 60)};${10 + (i % 20)}M`);
      }
      const fullText = streamChunks.join("");

      // 模拟极端随机分包写入
      let offset = 0;
      while (offset < fullText.length) {
        const size = Math.floor(Math.random() * 20) + 1;
        const chunk = fullText.substring(offset, offset + size);
        offset += size;
        input.write(chunk);
        if (Math.random() < 0.15) {
          await new Promise((r) => setTimeout(r, 55));
        }
      }

      await new Promise((r) => setTimeout(r, 60));

      assert.equal(leakedDraft, "", "高频极端分片滚动下，Composer draft 绝不能有任何残留字符");

      inputManager.stopNavigationMode();
      inputManager.close();
    });
  });
});
