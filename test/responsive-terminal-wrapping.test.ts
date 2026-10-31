import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TerminalMarkdownRenderer } from "../src/presentation/terminal-markdown-renderer.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import stripAnsi from "strip-ansi";

describe("Responsive Terminal Auto-Wrapping & Reflow Subsystem (Terminal Parity)", () => {
  describe("1. TerminalMarkdownRenderer Width Adaptation", () => {
    it("1.1 宽屏空间充足时不被 80 列限制强行折行", () => {
      const longText = "Nash harness is an ultra-fast, lightweight and secure AI agent runtime environment with native OS sandbox.";
      // longText 长度约 108 字符
      assert(longText.length > 80);

      // 当 maxWidth = 140 时，应该单行容纳，不折行
      const linesWide = TerminalMarkdownRenderer.render(longText, { maxWidth: 140 });
      assert.equal(linesWide.length, 1);
      assert.equal(stripAnsi(linesWide[0]!).trim(), longText);

      // 当 maxWidth = 60 时，应该自动分行折行
      const linesNarrow = TerminalMarkdownRenderer.render(longText, { maxWidth: 60 });
      assert(linesNarrow.length >= 2);
    });

    it("1.2 英文自然语言优先在词边界 (Word Boundary) 软折行，避免割裂单词", () => {
      const sentence = "The responsibility of the execution loop is ensuring state consistency and safety.";
      const lines = TerminalMarkdownRenderer.wrapStyledText(sentence, 40);

      assert(lines.length >= 2);
      for (const line of lines) {
        const plain = stripAnsi(line).trim();
        // 单词不应被中途拆开（如 responsibility 不应变成 respon- / sibility）
        assert.equal(plain.includes("responsibility") || !plain.includes("respon"), true);
      }
    });

    it("1.3 中文与 CJK 宽字符在任意字符边界自然折行并精准计算视觉列宽", () => {
      const chineseText = "这是一个高度自适应的终端渲染器，能够根据当前视口宽度动态重新排版与回填上一行。";
      // 当 maxWidth = 100 时，单行展示
      const wideLines = TerminalMarkdownRenderer.render(chineseText, { maxWidth: 100 });
      assert.equal(wideLines.length, 1);

      // 当 maxWidth = 30 时，折行为多行
      const narrowLines = TerminalMarkdownRenderer.render(chineseText, { maxWidth: 30 });
      assert(narrowLines.length >= 3);
      for (const line of narrowLines) {
        assert(stripAnsi(line).length <= 30);
      }
    });

    it("1.4 跨行折行时精准延续 ANSI 样式，防止行首样式丢失或终端污染", () => {
      const styledText = "\x1b[36m\x1b[1mNash Harness\x1b[0m is \x1b[32mextremely fast and safe for AI agents\x1b[0m across platforms.";
      const lines = TerminalMarkdownRenderer.wrapStyledText(styledText, 35);

      assert(lines.length >= 2);
      // 首行以 36m 开头
      assert(lines[0]!.includes("\x1b[36m"));
      // 换行后的行若包含 green 样式，能安全延续并在末尾 reset
      assert(lines[lines.length - 1]!.endsWith("\x1b[0m") || !lines[lines.length - 1]!.includes("\x1b["));
    });

    it("1.5 代码块 (Code Block) 与分割线 (Rule) 自适应视口列宽拉伸", () => {
      const markdown = "```typescript\nconst message = 'Hello Nash';\n```\n\n---";
      const wideLines = TerminalMarkdownRenderer.render(markdown, { maxWidth: 120 });

      const topBorder = wideLines.find((l) => l.includes("┌──"));
      assert(topBorder);
      // 顶部边框长度应随 120 列拉伸，远超旧版的 50 限制
      assert(stripAnsi(topBorder).length > 60);

      const hrLine = wideLines.find((l) => l.includes("─") && !l.includes("┌") && !l.includes("└"));
      assert(hrLine);
      assert(stripAnsi(hrLine).length > 60);
    });
  });

  describe("2. AgentTranscriptProjection Dynamic Reflow & Viewport Adaptation", () => {
    it("2.1 窄屏折行后，拉伸/全屏到更大空间时自动回填上一行 (Auto-reflow on width expansion)", () => {
      const proj = new AgentTranscriptProjection("main");
      const message = "Nash CLI now dynamically computes layouts on demand instead of baking static lines.";

      proj.addModelResponse(message);

      // 1. 模拟窄屏 (40 列) -> 文本应该折行为 3 行左右
      const narrowLines = proj.getDisplayLines(40).filter((l) => l.trim().length > 0);
      assert(narrowLines.length >= 3, `在 40 列下应折行为多行，实际行数: ${narrowLines.length}`);

      // 2. 模拟拉伸到全屏 (120 列) -> 文本应该自动回填上一行，合并为 1 行！
      const wideLines = proj.getDisplayLines(120).filter((l) => l.trim().length > 0);
      assert.equal(wideLines.length, 1, "拉伸变宽后，折行文字必须自动填充回上一行单行显示");
      assert(wideLines[0]!.includes(message));

      // 3. 再次缩小到 50 列 -> 文本再次自适应折行
      const reNarrowLines = proj.getDisplayLines(50).filter((l) => l.trim().length > 0);
      assert(reNarrowLines.length >= 2, "重新缩窄后应自动再次折行");
    });

    it("2.2 流式生成 (appendContentDelta) 产生的内容在拉伸后同样自适应重排", () => {
      const proj = new AgentTranscriptProjection("main");

      proj.appendContentDelta("First segment of the streaming response. ");
      proj.appendContentDelta("Second segment contains detailed explanations. ");
      proj.appendContentDelta("Third segment completes the full sentence nicely.");
      proj.finalizeContent();

      // 窄屏 45 列
      const narrowViewport = proj.renderViewport({ width: 45, height: 20, scrollOffset: 0 }).filter((l) => l.trim().length > 0);
      assert(narrowViewport.length >= 3);

      // 宽屏 150 列
      const wideViewport = proj.renderViewport({ width: 150, height: 20, scrollOffset: 0 }).filter((l) => l.trim().length > 0);
      assert.equal(wideViewport.length, 1);
      assert(wideViewport[0]!.includes("First segment") && wideViewport[0]!.includes("Third segment"));
    });

    it("2.3 User 消息长文本在不同视口下自适应折行与回填", () => {
      const proj = new AgentTranscriptProjection("main");
      const userPrompt = "Please refactor the approval module and verify all security policies under MacOsSeatbelt sandbox with fail-closed guarantees.";

      proj.addUserMessage(userPrompt);

      // 窄屏 50 列
      const narrow = proj.getDisplayLines(50).filter((l) => l.trim().length > 0);
      assert(narrow.length >= 3);

      // 宽屏 160 列
      const wide = proj.getDisplayLines(160).filter((l) => l.trim().length > 0);
      assert.equal(wide.length, 1);
      assert(wide[0]!.includes(userPrompt));
    });
  });
});
