import { createHash } from "node:crypto";
import type { ToolResult } from "../tools/executor.js";
import type { SpillStore } from "./spill/spill-store.js";
import type { SpillRef } from "./types.js";

export type ContentDeliveryMode =
  | "direct_inline"
  | "structured_extraction"
  | "bounded_preview"
  | "artifact_reference";

export interface AdaptiveDeliveryResult {
  content: string;
  mode: ContentDeliveryMode;
  originalChars: number;
  deliveredChars: number;
  spillRef?: SpillRef;
  extractedMetadata?: Record<string, unknown>;
}

export interface AdaptiveContextManagerOptions {
  spillStore: SpillStore;
  sessionId?: string;
  defaultInlineBudgetChars?: number;
  maxInlineChars?: number;
  previewEdgeChars?: number;
}

export class AdaptiveContextManager {
  private readonly spillStore: SpillStore;
  private sessionId: string;
  private readonly defaultInlineBudgetChars: number;
  private readonly maxInlineChars: number;
  private readonly previewEdgeChars: number;

  constructor(options: AdaptiveContextManagerOptions) {
    this.spillStore = options.spillStore;
    this.sessionId = options.sessionId ?? "default";
    this.defaultInlineBudgetChars = options.defaultInlineBudgetChars ?? 4000;
    this.maxInlineChars = options.maxInlineChars ?? 16000;
    this.previewEdgeChars = options.previewEdgeChars ?? 500;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * 自适应决策上下文传递策略：
   * 1. 紧凑内容（<= defaultInlineBudgetChars）：Direct Inline 完整无损直出
   * 2. 中等内容（<= maxInlineChars 且具备高语义价值）：Direct Inline
   * 3. 测试输出/编译诊断/Git 变更（> defaultInlineBudgetChars）：Structured Extraction 提取核心错误与失败栈
   * 4. 超长泛用输出（> maxInlineChars）：Bounded Preview + SpillStore 完整归档
   */
  async processResult(
    toolName: string,
    toolCallId: string,
    result: ToolResult,
    options?: { commandHint?: string; isError?: boolean }
  ): Promise<AdaptiveDeliveryResult> {
    const rawOutput = result.output ?? "";
    const originalChars = rawOutput.length;

    // 核心规避：read_tool_result 本身不递归二次 Spill
    if (toolName === "read_tool_result") {
      return {
        content: rawOutput,
        mode: "direct_inline",
        originalChars,
        deliveredChars: originalChars,
      };
    }

    // 1. 紧凑无溢出内容：Direct Inline
    if (originalChars <= Math.min(this.defaultInlineBudgetChars, this.maxInlineChars)) {
      return {
        content: rawOutput,
        mode: "direct_inline",
        originalChars,
        deliveredChars: originalChars,
      };
    }

    // 2. 检测结构化提取资格（测试日志、编译器输出、Git 状态/差异）
    const command = (options?.commandHint || "").toLowerCase();
    const isTest = /(?:npm\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|node\s+--test)/i.test(command);
    const isBuild = /(?:tsc|npm\s+run\s+build|vite\s+build|gcc|cargo\s+build)/i.test(command);
    const isGit = /(?:git\s+status|git\s+diff|git\s+log)/i.test(command);

    if (isTest) {
      const extracted = this.extractTestSummary(rawOutput);
      const spillRef = await this.spillStore.save(rawOutput, {
        sessionId: this.sessionId,
        toolName,
        toolCallId,
      });

      const formatted = [
        `[Structured Test Result Summary] Command: ${options?.commandHint || "test"} (Exit Code: ${result.exitCode ?? (result.success ? 0 : 1)})`,
        `Status: ${result.success ? "PASSED" : "FAILED"}`,
        extracted.summary ? `Summary: ${extracted.summary}` : "",
        extracted.failedTests.length > 0 ? `Failed Tests:\n${extracted.failedTests.map(t => `  - ${t}`).join("\n")}` : "",
        extracted.errorSnippets ? `Critical Errors & Stack:\n${extracted.errorSnippets}` : "",
        "",
        `Full test output (${originalChars} chars) archived to: ${spillRef.locator}`,
        `Use read_tool_result with locator '${spillRef.locator}' if full raw output is needed.`,
      ].filter(Boolean).join("\n");

      return {
        content: formatted,
        mode: "structured_extraction",
        originalChars,
        deliveredChars: formatted.length,
        spillRef,
        extractedMetadata: {
          testPassed: result.success,
          failedCount: extracted.failedTests.length,
        },
      };
    }

    if (isBuild) {
      const extracted = this.extractCompilerErrors(rawOutput);
      const spillRef = await this.spillStore.save(rawOutput, {
        sessionId: this.sessionId,
        toolName,
        toolCallId,
      });

      const formatted = [
        `[Structured Build Diagnostic Summary]`,
        `Status: ${result.success ? "SUCCESS" : "FAILED (Errors Found)"}`,
        extracted.errorCount > 0 ? `Error Count: ${extracted.errorCount}` : "",
        extracted.errorLines.length > 0 ? `Diagnostics:\n${extracted.errorLines.slice(0, 15).join("\n")}` : "",
        "",
        `Full build log (${originalChars} chars) archived to: ${spillRef.locator}`,
      ].filter(Boolean).join("\n");

      return {
        content: formatted,
        mode: "structured_extraction",
        originalChars,
        deliveredChars: formatted.length,
        spillRef,
      };
    }

    if (isGit && originalChars <= this.maxInlineChars) {
      // Git 状态与合理大小 Diff 完整保留
      return {
        content: rawOutput,
        mode: "direct_inline",
        originalChars,
        deliveredChars: originalChars,
      };
    }

    // 3. 通用超长内容：Bounded Preview + SpillStore 归档
    const spillRef = await this.spillStore.save(rawOutput, {
      sessionId: this.sessionId,
      toolName,
      toolCallId,
    });

    const lines = rawOutput.split(/\r?\n/);
    const errorLines = lines
      .map((line, index) => ({ line, index }))
      .filter(item => /(?:error|fail(?:ed|ure)?|exception|traceback|fatal|panic|not ok|错误|失败)/i.test(item.line))
      .slice(0, 10)
      .map(item => `L${item.index + 1}: ${item.line}`)
      .join("\n")
      .slice(0, 1500);

    const previewChars = Math.min(this.previewEdgeChars, Math.max(1, Math.floor(this.maxInlineChars / 2)));
    const head = rawOutput.slice(0, previewChars);
    const tail = rawOutput.slice(-previewChars);
    const sha256 = createHash("sha256").update(rawOutput).digest("hex");

    const formatted = [
      `[Tool Output Exceeded Budget] Original size: ${originalChars} chars (SHA-256: ${sha256.slice(0, 12)}...)`,
      "Tool output exceeded the inline context limit.",
      "Preview:",
      "",
      "--- Head Preview ---",
      head,
      "",
      errorLines ? `--- Diagnostic Error Highlights ---\n${errorLines}\n` : "",
      "--- Tail Preview ---",
      tail,
      "",
      `Full output archived as: ${spillRef.locator}`,
      `Use read_tool_result with an offset/limit to inspect additional content.`,
    ].filter(Boolean).join("\n");

    return {
      content: formatted,
      mode: "bounded_preview",
      originalChars,
      deliveredChars: formatted.length,
      spillRef,
    };
  }

  /**
   * 结构化提炼测试执行结果
   */
  private extractTestSummary(raw: string): {
    summary?: string;
    failedTests: string[];
    errorSnippets: string;
  } {
    const lines = raw.split(/\r?\n/);
    const failedTests: string[] = [];
    let summary: string | undefined;

    for (const line of lines) {
      // 捕获常见测试套件总结行
      if (/(?:tests?:|passed,|failed,|skipped,)/i.test(line) || /(?:# tests|# pass|# fail)/i.test(line)) {
        summary = line.trim();
      }
      // 捕获失败用例名称 (TAP, Jest, Vitest, Pytest)
      const failMatch = line.match(/(?:not ok \d+ -|FAIL\s+|✖\s+|FAILED\s+)(.+)/i);
      if (failMatch && failMatch[1]) {
        failedTests.push(failMatch[1].trim());
      }
    }

    // 提取关键错误栈
    const errorLines = lines
      .map((l, i) => ({ l, i }))
      .filter(item => /(?:AssertionError|Error:|Expected:|Received:|assert |fail|throw )/i.test(item.l))
      .slice(0, 12)
      .map(item => `  ${item.l.trim()}`)
      .join("\n")
      .slice(0, 1200);

    return {
      summary,
      failedTests: failedTests.slice(0, 20),
      errorSnippets: errorLines,
    };
  }

  /**
   * 结构化提炼编译器诊断信息
   */
  private extractCompilerErrors(raw: string): {
    errorCount: number;
    errorLines: string[];
  } {
    const lines = raw.split(/\r?\n/);
    const errorLines: string[] = [];

    for (const line of lines) {
      if (/(?:error TS\d+:|fatal error:|syntax error:|:\s+error:)/i.test(line)) {
        errorLines.push(line.trim());
      }
    }

    return {
      errorCount: errorLines.length,
      errorLines,
    };
  }
}
