import type { SessionRecord, UserSessionRecord, AssistantSessionRecord, ToolResultSessionRecord } from "../context/types.js";
import { formatToolCallSummary } from "./index.js";
import { truncateToDisplayWidth, getVisibleWidth } from "./terminal-renderer.js";
import { TerminalMarkdownRenderer } from "./terminal-markdown-renderer.js";
import path from "node:path";
import stripAnsi from "strip-ansi";
import { redactString } from "../observability/redaction.js";

/**
 * 强类型 Agent Transcript 条目分类
 */
export type TranscriptEntryKind =
  | "user_message"
  | "thought"
  | "thought_summary"
  | "tool_pair"
  | "model_response"
  | "run_summary"
  | "system_notice"
  | "approval"
  | "direct_shell";

export interface DirectShellEntryData {
  command: string;
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface ToolPairEntry {
  callId: string;
  toolName: string;
  argsSummary: string;
  rawArgs?: string | Record<string, unknown>;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  repeatCount?: number;
  beforeContent?: string;
}

export interface ThoughtSummaryData {
  durationMs?: number;
  tokens?: number;
  summaryText: string;
  fullReasoning?: string;
  recalledMemoriesCount?: number;
  recalledMemories?: Array<{ id: string; content: string; kind: string; scope: string }>;
}

export interface FormattedTranscriptEntry {
  id: string;
  agentId: string;
  timestamp: number;
  kind: TranscriptEntryKind;
  lines: string[];
  rawContent?: string;
  toolPair?: ToolPairEntry;
  thoughtData?: ThoughtSummaryData;
  systemNotice?: string;
  shellData?: DirectShellEntryData;
  lifecycleNotice?: {
    agentName: string;
    status: "started" | "waiting" | "completed" | "failed" | "interrupted";
    detail?: string;
  };
}

export interface ViewportRenderOptions {
  width: number;
  height: number;
  scrollOffset: number;
}

function safeToolText(value: string, width = 100): string {
  const plain = redactString(stripAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
  return truncateToDisplayWidth(plain, width);
}

function toolArgs(rawArgs?: string | Record<string, unknown>): Record<string, unknown> {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatBashLines(rawArgs?: string | Record<string, unknown>, preview?: string): string[] {
  const command = toolArgs(rawArgs).command;
  const lines: string[] = [];
  if (typeof command === "string" && command.trim()) {
    const commands = command.trim().split(/\r?\n/);
    lines.push(`    \x1b[90m└ $ ${safeToolText(commands[0])}\x1b[0m`);
    for (const line of commands.slice(1, 3)) lines.push(`      \x1b[90m$ ${safeToolText(line)}\x1b[0m`);
    if (commands.length > 3) lines.push(`      \x1b[90m… ${commands.length - 3} more command lines\x1b[0m`);
  }
  if (preview?.trim()) {
    const output = preview.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "").split(/\r?\n/);
    for (const line of output.slice(0, 3)) lines.push(`      \x1b[90m${safeToolText(line)}\x1b[0m`);
    if (output.length > 3) lines.push(`      \x1b[90m… ${output.length - 3} more output lines\x1b[0m`);
  }
  return lines;
}

/**
 * 将用户输入消息渲染为带有灰色背景的高对比度消息气泡块
 */
export function formatUserMessageLines(
  rawContent: string,
  mode: "normal" | "steer" | "queue" = "normal",
  maxWidth = 80,
  detailedView = false
): string[] {
  let displayContent = rawContent.trim();
  let actualMode = mode;
  if (displayContent.startsWith("[Steer]")) {
    actualMode = "steer";
    displayContent = displayContent.slice(7).trim();
  } else if (displayContent.startsWith("[Queued]")) {
    actualMode = "queue";
    displayContent = displayContent.slice(8).trim();
  }

  // 1. 灰色背景与文字颜色定义 (Charcoal Gray #303030 / ANSI 236)
  const BG = "\x1b[48;5;236m";
  const TEXT = "\x1b[38;5;255m\x1b[1m"; // 高亮纯白文字加粗
  const RESET = "\x1b[0m";

  // 2. 前缀定义 (日常输入直接一个极简箭头 >，去掉冗余生硬的 User 标签)
  let prefixStyled = ` \x1b[38;5;250m>\x1b[0m${BG}${TEXT} `;
  if (actualMode === "steer") {
    prefixStyled = ` \x1b[38;5;214m\x1b[1mUser (steer) >\x1b[0m${BG}${TEXT} `;
  } else if (actualMode === "queue") {
    prefixStyled = ` \x1b[38;5;177m\x1b[1mUser (queued) >\x1b[0m${BG}${TEXT} `;
  }

  const prefixVisibleWidth = getVisibleWidth(prefixStyled);
  const contPrefixStyled = ` ${" ".repeat(Math.max(1, prefixVisibleWidth - 2))} `;
  const contPrefixWidth = prefixVisibleWidth;

  // 3. 处理内嵌药丸 [Pasted text ...] 与 [Image: ...] 样式 (切换前景色，不破坏灰底)
  displayContent = displayContent.replace(
    /\[Pasted text \([^)]+\)\]/g,
    `\x1b[38;5;214m$&\x1b[39m${TEXT}`
  );
  displayContent = displayContent.replace(
    /\[Image: [^\]]+\]/g,
    `\x1b[38;5;39m$&\x1b[39m${TEXT}`
  );

  // 4. 计算内容区域的最大可用宽度 (保留 2 列外边距与内边距)
  const maxContentWidth = Math.max(10, maxWidth - 4 - prefixVisibleWidth);

  // 5. 分行与自适应软折行
  const rawLines = displayContent.split(/\r?\n/);
  interface WrappedLineItem {
    content: string;
    isFirst: boolean;
  }
  const allWrapped: WrappedLineItem[] = [];

  for (let idx = 0; idx < rawLines.length; idx++) {
    const rawLine = rawLines[idx]!;
    if (!rawLine.trim() && rawLines.length > 1) {
      allWrapped.push({ content: "", isFirst: idx === 0 && allWrapped.length === 0 });
      continue;
    }
    const wrapped = TerminalMarkdownRenderer.wrapStyledText(rawLine, maxContentWidth, "", "");
    for (const w of wrapped) {
      allWrapped.push({
        content: w,
        isFirst: allWrapped.length === 0,
      });
    }
  }

  if (allWrapped.length === 0) {
    allWrapped.push({ content: "", isFirst: true });
  }

  // 6. 统一平直通栏卡片宽度 (统一延伸至视口全宽，右边缘绝对平齐，彻底消除一长一短的参差感)
  const targetCardWidth = Math.max(20, maxWidth - 2);

  // 7. 生成带灰色背景的平整精致通栏卡片行
  const formattedLines: string[] = [];
  for (const item of allWrapped) {
    const prefix = item.isFirst ? prefixStyled : contPrefixStyled;
    const pWidth = item.isFirst ? prefixVisibleWidth : contPrefixWidth;
    const cWidth = getVisibleWidth(item.content);
    const paddingRightCount = Math.max(0, targetCardWidth - (pWidth + cWidth));
    const paddingRight = " ".repeat(paddingRightCount);

    // 严密保护：行内若有 ANSI 重置 (\x1b[0m)，替换为无缝恢复灰色背景与白色文字
    const safeContent = item.content.replace(/\x1b\[0m/g, `\x1b[0m${BG}${TEXT}`);

    // 用户消息 0 缩进直接贴左侧，通栏延伸至 targetCardWidth，右边缘绝对齐平
    const rawLine = `${BG}${prefix}${safeContent}${paddingRight}${RESET}`;
    formattedLines.push(truncateToDisplayWidth(rawLine, targetCardWidth));
  }

  // 8. 过长文本折叠机制 (非 detailedView 视图下超出 6 行折叠中间)
  if (!detailedView && formattedLines.length > 6) {
    const topLines = formattedLines.slice(0, 3);
    const bottomLines = formattedLines.slice(-2);
    const hiddenCount = formattedLines.length - 5;
    return [
      ...topLines,
      `\x1b[90m[... ${hiddenCount} lines hidden · Ctrl+O to expand]\x1b[0m`,
      ...bottomLines,
      "",
    ];
  }

  return [...formattedLines, ""];
}

function formatToolHeading(
  toolName: string,
  rawArgs: string | Record<string, unknown> | undefined,
  status: "running" | "completed" | "failed",
  duration?: string,
  argsSummary?: string
): string {
  const args = toolArgs(rawArgs);
  const filePath = typeof args.path === "string" ? args.path : "";
  const icon =
    status === "failed"
      ? "\x1b[31m✖\x1b[0m"
      : status === "running"
      ? "\x1b[36m●\x1b[0m"
      : "\x1b[32m✔\x1b[0m";
  const durationPart = duration ? ` \x1b[90m· ${duration}\x1b[0m` : "";
  const expandHint = " \x1b[90m(ctrl+o to expand)\x1b[0m";

  if (toolName === "edit_file") {
    const title = filePath ? `Update(${safeToolText(filePath, 70)})` : "Update file";
    return `  ${icon} \x1b[1m${title}\x1b[0m${durationPart}${expandHint}`;
  }

  if (toolName === "write_file") {
    const title = filePath ? `Write(${safeToolText(filePath, 70)})` : "Write file";
    return `  ${icon} \x1b[1m${title}\x1b[0m${durationPart}${expandHint}`;
  }

  let summary = argsSummary || formatToolCallSummary(toolName, args);
  if (summary && !summary.startsWith(" ")) {
    summary = ` ${summary}`;
  }
  const summaryPart = summary ? ` \x1b[90m${summary.trim()}\x1b[0m` : "";

  return `  ${icon} \x1b[1m\x1b[36m${toolName}\x1b[0m${summaryPart}${durationPart}${expandHint}`;
}

function formatReplacement(oldText: string, newText: string, maxLines: number): string[] {
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(oldLines.length, newLines.length) - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  )
    suffix++;

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const lines: string[] = [];
  if (prefix > 0) lines.push(`      \x1b[90m  \x1b[0m${highlightCode(oldLines[prefix - 1]!)}\x1b[0m`);
  const changed = [
    ...removed.map((line) => `\x1b[48;5;52m\x1b[91m      - \x1b[39m${highlightCode(line)}\x1b[0m`),
    ...added.map((line) => `\x1b[48;5;22m\x1b[92m      + \x1b[39m${highlightCode(line)}\x1b[0m`),
  ];
  lines.push(...changed.slice(0, maxLines));
  if (changed.length > maxLines) lines.push(`      \x1b[90m… ${changed.length - maxLines} more changed lines\x1b[0m`);
  if (suffix > 0) lines.push(`      \x1b[90m  \x1b[0m${highlightCode(oldLines[oldLines.length - suffix]!)}\x1b[0m`);
  return lines;
}

function highlightCode(value: string): string {
  const code = safeToolText(value, 110);
  return code.replace(
    /(<!--.*?-->|\/\/.*$|#[\w-]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|function|return|interface|type|export|import|from|class|async|await|new|if|else|number|string|boolean)\b|\b\d+(?:\.\d+)?\b|<\/?[A-Za-z][\w:-]*|\b[\w:-]+(?==))/g,
    (token) => {
      const color =
        token.startsWith("<!--") || token.startsWith("//")
          ? "90"
          : token.startsWith('"') || token.startsWith("'")
          ? "33"
          : token.startsWith("<")
          ? "36"
          : token.startsWith("#") || /^\d/.test(token)
          ? "35"
          : /^(?:const|let|function|return|interface|type|export|import|from|class|async|await|new|if|else)$/.test(
              token
            )
          ? "36"
          : "92";
      return `\x1b[${color}m${token}\x1b[39m`;
    }
  );
}

function numberedCodeLine(number: number, marker: " " | "-" | "+", code: string): string {
  const numberText = String(number).padStart(4);
  const prefix = `    ${numberText} ${marker}  `;
  if (marker === " ") return `\x1b[90m${prefix}\x1b[0m${highlightCode(code)}\x1b[0m`;
  const background = marker === "-" ? "48;5;52" : "48;5;22";
  const foreground = marker === "-" ? "91" : "92";
  return `\x1b[${background}m\x1b[${foreground}m${prefix}\x1b[39m${highlightCode(code)}\x1b[0m`;
}

function snapshotDiffLines(
  beforeContent: string,
  edits: Array<{ old_text: string; new_text: string }>
): string[] | undefined {
  let content = beforeContent;
  const hunks: string[][] = [];
  let addedCount = 0;
  let removedCount = 0;
  for (const edit of edits) {
    const position = content.indexOf(edit.old_text);
    if (position < 0 || content.indexOf(edit.old_text, position + edit.old_text.length) >= 0) return undefined;
    const after = content.slice(0, position) + edit.new_text + content.slice(position + edit.old_text.length);
    const oldLines = content.split(/\r?\n/);
    const newLines = after.split(/\r?\n/);
    let prefix = 0;
    while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < Math.min(oldLines.length, newLines.length) - prefix &&
      oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
    )
      suffix++;
    const oldEnd = oldLines.length - suffix;
    const newEnd = newLines.length - suffix;
    addedCount += newEnd - prefix;
    removedCount += oldEnd - prefix;
    const hunk: string[] = [];
    for (let i = Math.max(0, prefix - 2); i < prefix; i++) hunk.push(numberedCodeLine(i + 1, " ", oldLines[i]!));
    for (let i = prefix; i < oldEnd; i++) hunk.push(numberedCodeLine(i + 1, "-", oldLines[i]!));
    for (let i = prefix; i < newEnd; i++) hunk.push(numberedCodeLine(i + 1, "+", newLines[i]!));
    for (let i = newEnd; i < Math.min(newLines.length, newEnd + 2); i++)
      hunk.push(numberedCodeLine(i + 1, " ", newLines[i]!));
    hunks.push(hunk);
    content = after;
  }
  const lines = [`    \x1b[90m⎿  Added ${addedCount} lines, removed ${removedCount} lines\x1b[0m`];
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) lines.push("      \x1b[90m···\x1b[0m");
    lines.push(...hunk.slice(0, 14));
    if (hunk.length > 14) lines.push(`      \x1b[90m… ${hunk.length - 14} more lines\x1b[0m`);
  }
  return lines;
}

/** 格式化文件工具的分层差异预览。 */
export function formatToolDiffLines(
  toolName: string,
  rawArgs?: string | Record<string, unknown>,
  beforeContent?: string
): string[] {
  if (!rawArgs) return [];
  const args = toolArgs(rawArgs);

  const lines: string[] = [];

  if (toolName === "edit_file") {
    if (Array.isArray(args.edits)) {
      const edits = args.edits.filter(
        (edit): edit is { old_text: string; new_text: string } =>
          Boolean(edit && typeof edit.old_text === "string" && typeof edit.new_text === "string")
      );
      if (beforeContent !== undefined && edits.length > 0) {
        const snapshot = snapshotDiffLines(beforeContent, edits);
        if (snapshot) return snapshot;
      }
      lines.push(`    \x1b[90m└ ${edits.length} replacements\x1b[0m`);
      for (const [index, edit] of edits.slice(0, 4).entries()) {
        lines.push(`      \x1b[90m@@ ${index + 1}/${edits.length} @@\x1b[0m`);
        lines.push(...formatReplacement(edit.old_text, edit.new_text, 8));
      }
      if (edits.length > 4) lines.push(`      \x1b[90m… ${edits.length - 4} more replacements\x1b[0m`);
      return lines;
    }
    const oldText =
      typeof args.old_text === "string"
        ? args.old_text
        : typeof args.old_string === "string"
        ? args.old_string
        : typeof args.oldText === "string"
        ? args.oldText
        : typeof args.old_str === "string"
        ? args.old_str
        : "";

    const newText =
      typeof args.new_text === "string"
        ? args.new_text
        : typeof args.new_string === "string"
        ? args.new_string
        : typeof args.newText === "string"
        ? args.newText
        : typeof args.new_str === "string"
        ? args.new_str
        : "";

    if (oldText || newText) {
      if (beforeContent !== undefined && oldText) {
        const snapshot = snapshotDiffLines(beforeContent, [{ old_text: oldText, new_text: newText }]);
        if (snapshot) return snapshot;
      }
      const oldCount = oldText ? oldText.split(/\r?\n/).length : 0;
      const newCount = newText ? newText.split(/\r?\n/).length : 0;
      lines.push(`    \x1b[90m└ Added ${newCount} lines, removed ${oldCount} lines\x1b[0m`);
      lines.push(...formatReplacement(oldText, newText, 16));
    }
  } else if (toolName === "write_file") {
    const content =
      typeof args.content === "string"
        ? args.content
        : typeof args.file_content === "string"
        ? args.file_content
        : typeof args.text === "string"
        ? args.text
        : "";

    if (content) {
      const contentLines = content.split(/\r?\n/);
      lines.push(`    \x1b[90m└ Written ${contentLines.length} lines (${content.length} chars)\x1b[0m`);

      const maxShowContent = 10;
      for (let i = 0; i < Math.min(contentLines.length, maxShowContent); i++) {
        lines.push(numberedCodeLine(i + 1, "+", contentLines[i]));
      }
      if (contentLines.length > maxShowContent) {
        lines.push(`    \x1b[90m... +${contentLines.length - maxShowContent} more lines\x1b[0m`);
      }
    }
  }

  return lines;
}

/**
 * AgentTranscriptProjection - 负责将 Agent 历史 Session Records 或实时事件投影为终端可视条目
 *
 * 核心设计准则：
 * 1. 数据驱动 (Truth)：保留原始消息、结构化工具调用与 Markdown 文本；
 * 2. 动态自适应折行 (Responsive Soft Wrap)：根据当前视口宽度动态重排，窗口变宽自动回填上一行，变窄自动折行；
 * 3. 严格按 toolCallId 配对 tool_call 与 tool_result；
 * 4. 杜绝展示 raw JSON、traceId 或敏感信息；
 * 5. 维护独立的滚动视口与 Auto-follow 状态机。
 */
export class AgentTranscriptProjection {
  private detailedView = false;
  private readonly agentId: string;
  private entries: FormattedTranscriptEntry[] = [];
  private readonly pendingToolCalls = new Map<string, ToolPairEntry>();
  private pendingThoughtId?: string;
  private revision = 0;

  // 布局缓存
  private layoutCacheKey = "";
  private cachedDisplayLines: string[] = [];

  // 实时流式缓冲
  private streamingThought: {
    id: string;
    rawText: string;
    startTime: number;
  } | null = null;

  private streamingResponse: {
    id: string;
    rawText: string;
    startTime: number;
  } | null = null;

  // 滚动与 Follow 状态
  private autoFollow = true;
  private scrollOffset = 0;

  // 待关联的本轮召回记忆
  private pendingRecalledMemories: Array<{ id: string; content: string; kind: string; scope: string }> = [];

  constructor(agentId: string, private readonly readFile?: (filePath: string) => string | undefined) {
    this.agentId = agentId;
  }

  recordRecalledMemories(memories: Array<{ id: string; content: string; kind: string; scope: string }>): void {
    this.pendingRecalledMemories = [...memories];
  }

  getAgentId(): string {
    return this.agentId;
  }

  toggleDetailedView(): boolean {
    this.detailedView = !this.detailedView;
    this.revision++;
    this.scrollToBottom();
    return this.detailedView;
  }

  isDetailedView(): boolean {
    return this.detailedView;
  }

  isAutoFollow(): boolean {
    return this.autoFollow;
  }

  setAutoFollow(follow: boolean): void {
    this.autoFollow = follow;
    if (follow) {
      this.scrollOffset = 0;
    }
  }

  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /**
   * 清理瞬态 thinking 指示条目
   */
  clearPendingThought(): void {
    if (this.pendingThoughtId) {
      const idx = this.entries.findIndex((e) => e.id === this.pendingThoughtId);
      if (idx !== -1) {
        const entry = this.entries[idx];
        if (entry && entry.kind === "thought") {
          this.entries.splice(idx, 1);
          this.revision++;
        }
      }
      this.pendingThoughtId = undefined;
    } else if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      if (
        last &&
        last.kind === "thought" &&
        (!last.lines || last.lines.every((l) => l.includes("thinking...") && !l.includes("↳")))
      ) {
        this.entries.pop();
        this.revision++;
      }
    }
  }

  /**
   * 追加流式思考文本增量
   */
  appendThoughtDelta(delta: string, timestamp = Date.now()): void {
    if (!delta) return;

    if (!this.streamingThought) {
      this.clearPendingThought();
      const thoughtId = crypto.randomUUID();
      this.pendingThoughtId = thoughtId;
      this.streamingThought = {
        id: thoughtId,
        rawText: "",
        startTime: timestamp,
      };
      this.entries.push({
        id: thoughtId,
        agentId: this.agentId,
        timestamp,
        kind: "thought",
        lines: [`  \x1b[90m💭 thinking...\x1b[0m`],
      });
      this.revision++;
    }

    this.streamingThought.rawText += delta;

    const rawLines = this.streamingThought.rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const lastLine = rawLines[rawLines.length - 1] ?? "";
    const preview = lastLine.length > 70 ? lastLine.slice(0, 67) + "..." : lastLine;

    const entry = this.entries.find((e) => e.id === this.streamingThought?.id);
    if (entry) {
      entry.lines = [`  \x1b[90m💭 thinking... \x1b[2m${preview}\x1b[0m`];
      this.revision++;
    }
  }

  /**
   * 思考过程完成，将实时流式思考收敛为结构化思考摘要块
   */
  finalizeThought(
    durationMs?: number,
    tokens?: number,
    summary?: string,
    timestamp = Date.now()
  ): void {
    const raw = this.streamingThought?.rawText ?? "";
    const thoughtId = this.streamingThought?.id ?? this.pendingThoughtId;
    this.streamingThought = null;
    this.pendingThoughtId = undefined;

    const effectiveDurationMs = durationMs ?? 0;
    const durationStr =
      effectiveDurationMs >= 1000
        ? `${(effectiveDurationMs / 1000).toFixed(1)}s`
        : effectiveDurationMs > 0
        ? `${effectiveDurationMs}ms`
        : "";

    const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
    const thoughtSummaryText =
      summary ?? (firstLine.length > 75 ? firstLine.slice(0, 72) + "..." : firstLine);

    const recalledCount = this.pendingRecalledMemories.length;
    const recalledMemoriesList = recalledCount > 0 ? [...this.pendingRecalledMemories] : undefined;
    this.pendingRecalledMemories = [];

    const memSuffix = recalledCount > 0
      ? `, recalled ${recalledCount} memor${recalledCount === 1 ? "y" : "ies"}`
      : "";
    const expandHint = recalledCount > 0 ? " \x1b[90m(ctrl+o to expand)\x1b[0m" : "";

    if (!thoughtId && !raw.trim() && !summary) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const entry = this.entries[i];
        if (entry && entry.kind === "thought_summary") {
          if (effectiveDurationMs > 0 || tokens || recalledCount > 0) {
            entry.thoughtData = {
              ...entry.thoughtData,
              durationMs: effectiveDurationMs || entry.thoughtData?.durationMs,
              tokens: tokens || entry.thoughtData?.tokens,
              summaryText: entry.thoughtData?.summaryText ?? thoughtSummaryText,
              recalledMemoriesCount: recalledCount || entry.thoughtData?.recalledMemoriesCount,
              recalledMemories: recalledMemoriesList || entry.thoughtData?.recalledMemories,
            };
            const updatedDuration = entry.thoughtData.durationMs
              ? entry.thoughtData.durationMs >= 1000
                ? `${(entry.thoughtData.durationMs / 1000).toFixed(1)}s`
                : `${entry.thoughtData.durationMs}ms`
              : durationStr;
            const durDisplay = updatedDuration ? ` for ${updatedDuration}` : "";
            const currentRecalledCount = entry.thoughtData.recalledMemoriesCount ?? 0;
            const currentMemSuffix = currentRecalledCount > 0
              ? `, recalled ${currentRecalledCount} memor${currentRecalledCount === 1 ? "y" : "ies"}`
              : "";
            const currentExpandHint = currentRecalledCount > 0 ? " \x1b[90m(ctrl+o to expand)\x1b[0m" : "";
            const updatedLines: string[] = [`  \x1b[90mThought${durDisplay}${currentMemSuffix}\x1b[0m${currentExpandHint}`];
            if (entry.thoughtData.summaryText) {
              updatedLines.push(`    \x1b[90m↳ ${entry.thoughtData.summaryText}\x1b[0m`);
            }
            updatedLines.push("");
            entry.lines = updatedLines;
            this.revision++;
          }
          return;
        }
      }

      if (effectiveDurationMs > 0 || recalledCount > 0) {
        const durDisplay = durationStr ? ` for ${durationStr}` : "";
        const lines = [`  \x1b[90mThought${durDisplay}${memSuffix}\x1b[0m${expandHint}`, ""];
        this.entries.push({
          id: crypto.randomUUID(),
          agentId: this.agentId,
          timestamp,
          kind: "thought_summary",
          lines,
          thoughtData: {
            durationMs: effectiveDurationMs,
            tokens,
            summaryText: "",
            recalledMemoriesCount: recalledCount || undefined,
            recalledMemories: recalledMemoriesList,
          },
        });
        this.revision++;
      }
      return;
    }

    if (!raw.trim() && !summary && effectiveDurationMs === 0 && recalledCount === 0) {
      this.clearPendingThought();
      return;
    }

    const durDisplay = durationStr ? ` for ${durationStr}` : "";
    const lines: string[] = [`  \x1b[90mThought${durDisplay}${memSuffix}\x1b[0m${expandHint}`];
    if (thoughtSummaryText) {
      lines.push(`    \x1b[90m↳ ${thoughtSummaryText}\x1b[0m`);
    }
    lines.push("");

    const existingIdx = thoughtId ? this.entries.findIndex((e) => e.id === thoughtId) : -1;
    const summaryEntry: FormattedTranscriptEntry = {
      id: thoughtId ?? crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "thought_summary",
      lines,
      thoughtData: {
        durationMs: effectiveDurationMs,
        tokens,
        summaryText: thoughtSummaryText,
        fullReasoning: raw,
        recalledMemoriesCount: recalledCount || undefined,
        recalledMemories: recalledMemoriesList,
      },
    };

    if (existingIdx !== -1) {
      this.entries[existingIdx] = summaryEntry;
    } else {
      this.entries.push(summaryEntry);
    }
    this.revision++;
  }

  /**
   * 追加流式正文增量（保留原始 rawContent 以便自适应以任意列宽动态重排）
   */
  appendContentDelta(delta: string, timestamp = Date.now()): void {
    if (!delta) return;

    if (this.streamingThought || this.pendingThoughtId) {
      this.finalizeThought(undefined, undefined, undefined, timestamp);
    }

    if (!this.streamingResponse) {
      const responseId = crypto.randomUUID();
      this.streamingResponse = {
        id: responseId,
        rawText: "",
        startTime: timestamp,
      };
      this.entries.push({
        id: responseId,
        agentId: this.agentId,
        timestamp,
        kind: "model_response",
        lines: [],
        rawContent: "",
      });
      this.revision++;
    }

    this.streamingResponse.rawText += delta;

    const entry = this.entries.find((e) => e.id === this.streamingResponse?.id);
    if (entry) {
      entry.rawContent = this.streamingResponse.rawText;
      const formattedLines = TerminalMarkdownRenderer.render(this.streamingResponse.rawText, {
        maxWidth: 80,
        indent: "  ",
      });
      entry.lines = this.applyModelResponseBullet(formattedLines);
      this.revision++;
    }
  }

  /**
   * 保持纯净左对齐与标准 Markdown 排版，绝不在首行插入悬空圆点破坏排版与缩进
   */
  private applyModelResponseBullet(lines: string[]): string[] {
    return lines;
  }

  /**
   * 结束当前流式正文渲染
   */
  finalizeContent(): void {
    if (this.streamingResponse) {
      const entry = this.entries.find((e) => e.id === this.streamingResponse?.id);
      if (entry && entry.lines.length > 0 && entry.lines[entry.lines.length - 1] !== "") {
        entry.lines.push("");
      }
      this.streamingResponse = null;
      this.revision++;
    }
  }

  /**
   * 从 Session Records 批量重构完整历史 Transcript
   */
  projectFromSessionRecords(records: SessionRecord[]): void {
    this.entries = [];
    this.pendingToolCalls.clear();
    this.pendingThoughtId = undefined;
    this.streamingThought = null;
    this.streamingResponse = null;
    this.revision++;

    const toolResultMap = new Map<string, ToolResultSessionRecord>();
    for (const r of records) {
      if (r.type === "tool_result") {
        toolResultMap.set(r.toolCallId, r);
      }
    }

    for (const record of records) {
      if (record.type === "user") {
        const userRec = record as UserSessionRecord;
        if (userRec.metadata?.isShellCommand && typeof userRec.metadata?.command === "string") {
          this.addDirectShellCommand(
            userRec.metadata.command as string,
            typeof userRec.metadata.output === "string"
              ? userRec.metadata.output
              : userRec.content.replace(/^! [^\n]+\n\n(?:\[Command Output\]\n)?/, ""),
            typeof userRec.metadata.exitCode === "number" ? userRec.metadata.exitCode : 0,
            typeof userRec.metadata.durationMs === "number" ? userRec.metadata.durationMs : 0,
            userRec.createdAt
          );
        } else {
          this.addUserMessage(userRec.content, userRec.createdAt);
        }
      } else if (record.type === "assistant") {
        const asstRec = record as AssistantSessionRecord;

        const reasoning = (asstRec as any).reasoning_content ?? (asstRec.metadata as any)?.reasoning_content;
        const reasoningMs = (asstRec as any).reasoningDurationMs ?? (asstRec.metadata as any)?.reasoningDurationMs;
        const recalledMemories = (asstRec.metadata as any)?.recalledMemories as Array<{ id: string; content: string; kind: string; scope: string }> | undefined;
        const recalledCount = (asstRec.metadata as any)?.recalledMemoriesCount ?? recalledMemories?.length ?? 0;

        if (reasoning || reasoningMs || recalledCount > 0) {
          const firstLine = reasoning
            ? String(reasoning).split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ""
            : "";
          const preview = firstLine.length > 75 ? firstLine.slice(0, 72) + "..." : firstLine;
          const durationStr = reasoningMs ? `${(reasoningMs / 1000).toFixed(1)}s` : "";
          const durDisplay = durationStr ? ` for ${durationStr}` : "";
          const memSuffix = recalledCount > 0
            ? `, recalled ${recalledCount} memor${recalledCount === 1 ? "y" : "ies"}`
            : "";
          const expandHint = recalledCount > 0 ? " \x1b[90m(ctrl+o to expand)\x1b[0m" : "";
          const lines: string[] = [`  \x1b[38;5;244m* Thought${durDisplay}${memSuffix}\x1b[0m${expandHint}`];
          if (preview) {
            lines.push(`    \x1b[90m↳ ${preview}\x1b[0m`);
          }
          lines.push("");

          this.entries.push({
            id: crypto.randomUUID(),
            agentId: this.agentId,
            timestamp: asstRec.createdAt,
            kind: "thought_summary",
            lines,
            thoughtData: {
              durationMs: reasoningMs,
              summaryText: preview,
              fullReasoning: reasoning ? String(reasoning) : undefined,
              recalledMemoriesCount: recalledCount || undefined,
              recalledMemories,
            },
          });
        }

        if (asstRec.content) {
          this.addModelResponse(asstRec.content, asstRec.createdAt);
        }

        if (asstRec.toolCalls && asstRec.toolCalls.length > 0) {
          for (const tc of asstRec.toolCalls) {
            const toolName = tc.function.name;
            let argsObj: any = {};
            try {
              argsObj =
                typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
            } catch {
              argsObj = tc.function.arguments;
            }
            const summary = formatToolCallSummary(toolName, argsObj);
            const matchedResult = toolResultMap.get(tc.id);

            if (matchedResult) {
              this.addCompletedToolPair(
                {
                  callId: tc.id,
                  toolName,
                  argsSummary: summary,
                  rawArgs: argsObj,
                  status: matchedResult.success ? "completed" : "failed",
                  durationMs: matchedResult.executionTimeMs,
                  resultPreview:
                    matchedResult.preview || (matchedResult.content ? matchedResult.content.slice(0, 120) : ""),
                },
                matchedResult.createdAt
              );
            } else {
              this.addToolCallStart(tc.id, toolName, summary, argsObj, asstRec.createdAt);
            }
          }
        }
      }
    }
  }

  addUserMessage(
    content: string,
    timestamp = Date.now(),
    mode: "normal" | "steer" | "queue" = "normal"
  ): void {
    this.clearPendingThought();
    const formatted = content.trim();

    const last = this.entries[this.entries.length - 1];
    if (
      last &&
      last.kind === "user_message" &&
      (last.rawContent === formatted || last.rawContent === `[Queued] ${formatted}` || `[Queued] ${last.rawContent}` === formatted)
    ) {
      return;
    }

    let storedContent = formatted;
    if (mode === "steer" && !storedContent.startsWith("[Steer]")) {
      storedContent = `[Steer] ${storedContent}`;
    } else if (mode === "queue" && !storedContent.startsWith("[Queued]")) {
      storedContent = `[Queued] ${storedContent}`;
    }

    const lines = formatUserMessageLines(storedContent, mode, 80, this.detailedView);
    this.entries.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "user_message",
      lines,
      rawContent: storedContent,
    });
    this.revision++;
  }

  addThought(timestamp = Date.now()): void {
    this.clearPendingThought();
    const thoughtId = crypto.randomUUID();
    this.pendingThoughtId = thoughtId;
    const lines = [`  \x1b[90mthinking...\x1b[0m`];
    this.entries.push({
      id: thoughtId,
      agentId: this.agentId,
      timestamp,
      kind: "thought",
      lines,
    });
    this.revision++;
  }

  addModelResponse(content: string, timestamp = Date.now()): void {
    this.clearPendingThought();
    const formatted = content.trim();
    if (!formatted) return;

    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === "model_response" && last.rawContent === formatted) {
      return;
    }

    const lines = TerminalMarkdownRenderer.render(formatted, {
      maxWidth: 80,
      indent: "  ",
    });
    const styledLines = this.applyModelResponseBullet(lines);
    styledLines.push("");

    this.entries.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "model_response",
      lines: styledLines,
      rawContent: formatted,
    });
    this.revision++;
  }

  addRunSummary(summaryText: string, timestamp = Date.now()): void {
    this.clearPendingThought();
    const formatted = summaryText.trim();
    if (!formatted) return;

    const rawLines = formatted.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const hasHeader = rawLines.length > 0 && stripAnsi(rawLines[0]).trim().toLowerCase().startsWith("run summary");
    const detailLines = (hasHeader ? rawLines.slice(1) : rawLines).map((line) => `  \x1b[90m${stripAnsi(line).trim()}\x1b[0m`);
    const lines = [`  \x1b[90mRun summary\x1b[0m`, ...detailLines, ""];
    this.entries.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "run_summary",
      lines,
      rawContent: formatted,
    });
    this.revision++;
  }

  addToolCallStart(
    callId: string,
    toolName: string,
    argsSummary: string,
    rawArgs?: string | Record<string, unknown>,
    timestamp = Date.now()
  ): void {
    this.clearPendingThought();

    const lastEntry = this.entries[this.entries.length - 1];
    if (
      lastEntry &&
      lastEntry.kind === "tool_pair" &&
      lastEntry.toolPair &&
      lastEntry.toolPair.toolName === toolName &&
      lastEntry.toolPair.argsSummary === argsSummary &&
      (toolName.startsWith("read_") || toolName.startsWith("list_"))
    ) {
      const count = (lastEntry.toolPair.repeatCount || 1) + 1;
      lastEntry.toolPair.repeatCount = count;
      const statusIcon =
        lastEntry.toolPair.status === "running"
          ? "\x1b[36m●\x1b[0m"
          : lastEntry.toolPair.status === "completed"
          ? "\x1b[32m✔\x1b[0m"
          : "\x1b[31m✖\x1b[0m";
      const durationStr = lastEntry.toolPair.durationMs
        ? lastEntry.toolPair.durationMs >= 1000
          ? `${(lastEntry.toolPair.durationMs / 1000).toFixed(1)}s`
          : `${lastEntry.toolPair.durationMs}ms`
        : "";
      const timingPart = durationStr ? ` \x1b[90m· ${durationStr}\x1b[0m` : "";
      const summaryText = argsSummary ? ` \x1b[90m${argsSummary}\x1b[0m` : "";
      const repeatSuffix = ` \x1b[33m(x${count})\x1b[0m`;
      const mainLine = `  ${statusIcon} \x1b[1m\x1b[36m${toolName}\x1b[0m${summaryText}${timingPart}${repeatSuffix} \x1b[90m(ctrl+o to expand)\x1b[0m`;

      const p = toolArgs(rawArgs).path;
      const lines = [mainLine];
      if (typeof p === "string" && p && toolName !== "read_file" && toolName !== "edit_file" && toolName !== "write_file") {
        lines.push(`    \x1b[90m└ ${p}\x1b[0m`);
      }
      lines.push("");
      lastEntry.lines = lines;
      this.pendingToolCalls.set(callId, lastEntry.toolPair);
      this.revision++;
      return;
    }

    const pair: ToolPairEntry = {
      callId,
      toolName,
      argsSummary,
      rawArgs,
      status: "running",
      repeatCount: 1,
    };
    const filePath = toolArgs(rawArgs).path;
    if (toolName === "edit_file" && typeof filePath === "string") {
      pair.beforeContent = this.readFile?.(filePath);
    }
    this.pendingToolCalls.set(callId, pair);

    const mainLine = formatToolHeading(toolName, rawArgs, "running", undefined, argsSummary);
    const lines = [mainLine];

    const p = toolArgs(rawArgs).path;
    if (typeof p === "string" && p && toolName !== "edit_file" && toolName !== "write_file" && toolName !== "read_file") {
      lines.push(`    \x1b[90m└ ${p}\x1b[0m`);
    } else if (toolName === "bash") {
      lines.push(...formatBashLines(rawArgs));
    }
    lines.push("");

    this.entries.push({
      id: callId,
      agentId: this.agentId,
      timestamp,
      kind: "tool_pair",
      lines,
      toolPair: pair,
    });
    this.revision++;
  }

  completeToolCall(
    callId: string,
    toolName: string,
    success: boolean,
    durationMs: number,
    resultPreview?: string,
    rawArgs?: string | Record<string, unknown>,
    timestamp = Date.now()
  ): void {
    this.clearPendingThought();

    let existing = this.entries.find((e) => e.id === callId);
    if (!existing) {
      for (let i = this.entries.length - 1; i >= 0; i--) {
        const entry = this.entries[i];
        if (
          entry &&
          entry.kind === "tool_pair" &&
          entry.toolPair &&
          entry.toolPair.status === "running" &&
          (entry.toolPair.toolName === toolName || !toolName)
        ) {
          existing = entry;
          break;
        }
      }
    }

    const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
    let cleanPreview = resultPreview?.replace(/\r?\n/g, " ").trim() ?? "";
    if (cleanPreview.length > 80) {
      cleanPreview = cleanPreview.slice(0, 77) + "...";
    }

    const effectiveArgs = rawArgs ?? existing?.toolPair?.rawArgs;

    if (existing && existing.toolPair) {
      existing.toolPair.status = success ? "completed" : "failed";
      existing.toolPair.durationMs = durationMs;
      existing.toolPair.resultPreview = cleanPreview;
      if (rawArgs) {
        existing.toolPair.rawArgs = rawArgs;
      }

      const repeatCount = existing.toolPair.repeatCount || 1;
      const repeatSuffix = repeatCount > 1 ? ` \x1b[33m(x${repeatCount})\x1b[0m` : "";
      const mainLine =
        formatToolHeading(
          toolName,
          effectiveArgs,
          success ? "completed" : "failed",
          durationStr,
          existing.toolPair.argsSummary
        ) + repeatSuffix;

      const lines = [mainLine];
      const p = toolArgs(effectiveArgs).path;
      if (typeof p === "string" && p && toolName !== "edit_file" && toolName !== "write_file" && toolName !== "read_file") {
        lines.push(`    \x1b[90m└ ${p}\x1b[0m`);
      }
      if (success && (toolName === "edit_file" || toolName === "write_file")) {
        const diffLines = formatToolDiffLines(toolName, effectiveArgs, existing.toolPair.beforeContent);
        if (diffLines.length > 0) {
          lines.push(...diffLines);
        } else if (cleanPreview && !p) {
          lines.push(`    \x1b[90m└ ${cleanPreview}\x1b[0m`);
        }
      } else if (toolName === "bash") {
        lines.push(...formatBashLines(effectiveArgs, resultPreview));
      } else if (cleanPreview && !p) {
        lines.push(`    \x1b[90m└ ${cleanPreview}\x1b[0m`);
      }
      lines.push("");
      existing.lines = lines;
      existing.toolPair.beforeContent = undefined;
      this.pendingToolCalls.delete(callId);
    } else {
      const mainLine = formatToolHeading(
        toolName,
        effectiveArgs,
        success ? "completed" : "failed",
        durationStr
      );
      const lines = [mainLine];
      const p = toolArgs(effectiveArgs).path;
      if (typeof p === "string" && p && toolName !== "edit_file" && toolName !== "write_file" && toolName !== "read_file") {
        lines.push(`    \x1b[90m└ ${p}\x1b[0m`);
      }
      if (success && (toolName === "edit_file" || toolName === "write_file")) {
        const diffLines = formatToolDiffLines(toolName, effectiveArgs);
        if (diffLines.length > 0) {
          lines.push(...diffLines);
        } else if (cleanPreview && !p) {
          lines.push(`    \x1b[90m└ ${cleanPreview}\x1b[0m`);
        }
      } else if (toolName === "bash") {
        lines.push(...formatBashLines(effectiveArgs, resultPreview));
      } else if (cleanPreview && !p) {
        lines.push(`    \x1b[90m└ ${cleanPreview}\x1b[0m`);
      }
      lines.push("");

      this.entries.push({
        id: callId || crypto.randomUUID(),
        agentId: this.agentId,
        timestamp,
        kind: "tool_pair",
        lines,
        toolPair: {
          callId: callId || crypto.randomUUID(),
          toolName,
          argsSummary: "",
          rawArgs,
          status: success ? "completed" : "failed",
          durationMs,
          resultPreview: cleanPreview,
        },
      });
    }
    this.revision++;
  }

  private addCompletedToolPair(pair: ToolPairEntry, timestamp: number): void {
    const durationMs = pair.durationMs ?? 0;
    const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
    const repeatCount = pair.repeatCount || 1;
    const repeatSuffix = repeatCount > 1 ? ` \x1b[33m(x${repeatCount})\x1b[0m` : "";
    const mainLine =
      formatToolHeading(pair.toolName, pair.rawArgs, pair.status, durationStr, pair.argsSummary) +
      repeatSuffix;

    const lines = [mainLine];
    const p = toolArgs(pair.rawArgs).path;
    if (typeof p === "string" && p && pair.toolName !== "edit_file" && pair.toolName !== "write_file" && pair.toolName !== "read_file") {
      lines.push(`    \x1b[90m└ ${p}\x1b[0m`);
    }
    if (pair.status === "completed" && (pair.toolName === "edit_file" || pair.toolName === "write_file")) {
      const diffLines = formatToolDiffLines(pair.toolName, pair.rawArgs, pair.beforeContent);
      if (diffLines.length > 0) {
        lines.push(...diffLines);
      } else if (pair.resultPreview && !p) {
        lines.push(`    \x1b[90m${pair.resultPreview}\x1b[0m`);
      }
    } else if (pair.toolName === "bash") {
      lines.push(...formatBashLines(pair.rawArgs, pair.resultPreview));
    } else if (pair.resultPreview && !p) {
      lines.push(`    \x1b[90m${pair.resultPreview}\x1b[0m`);
    }
    lines.push("");

    this.entries.push({
      id: pair.callId,
      agentId: this.agentId,
      timestamp,
      kind: "tool_pair",
      lines,
      toolPair: pair,
    });
    this.revision++;
  }

  addChildLifecycleNotice(
    agentName: string,
    status: "started" | "waiting" | "completed" | "failed" | "interrupted",
    detail?: string,
    timestamp = Date.now()
  ): void {
    let icon = "•";
    let statusText: string = status;
    if (status === "started") {
      icon = "\x1b[36m▸\x1b[0m";
      statusText = `\x1b[36m${agentName} started\x1b[0m`;
    } else if (status === "waiting") {
      icon = "\x1b[33m⏳\x1b[0m";
      statusText = `\x1b[33m${agentName} waiting approval\x1b[0m`;
    } else if (status === "completed") {
      icon = "\x1b[32m✓\x1b[0m";
      statusText = `\x1b[32m${agentName} completed ✓\x1b[0m`;
    } else if (status === "failed") {
      icon = "\x1b[31m✗\x1b[0m";
      statusText = `\x1b[31m${agentName} failed ✗\x1b[0m${detail ? `: \x1b[90m${detail}\x1b[0m` : ""}`;
    } else if (status === "interrupted") {
      icon = "\x1b[33m⊘\x1b[0m";
      statusText = `\x1b[33m${agentName} interrupted\x1b[0m`;
    }

    const lines = [`  ${icon} ${statusText}`, ""];
    this.entries.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "system_notice",
      lines,
      lifecycleNotice: { agentName, status, detail },
    });
    this.revision++;
  }

  addDirectShellCommand(
    command: string,
    output: string,
    exitCode: number,
    durationMs: number,
    timestamp = Date.now()
  ): void {
    this.clearPendingThought();
    const entry: FormattedTranscriptEntry = {
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "direct_shell",
      lines: [],
      rawContent: `! ${command}\n\n${output}`,
      shellData: {
        command,
        output,
        exitCode,
        durationMs,
      },
    };
    this.entries.push(entry);
    this.revision++;
  }

  addSystemNotice(text: string, timestamp = Date.now()): void {
    const rawLines = text.split(/\r?\n/);
    const isStyled = text.startsWith("\x1b") || text.startsWith("✓");
    const lines: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      if (isStyled) {
        lines.push(`  ${line}`);
      } else {
        lines.push(`  \x1b[90m${i === 0 ? "[system] " : "  "}${line}\x1b[0m`);
      }
    }
    lines.push("");
    this.entries.push({
      id: crypto.randomUUID(),
      agentId: this.agentId,
      timestamp,
      kind: "system_notice",
      lines,
      systemNotice: text,
    });
    this.revision++;
  }

  /**
   * 动态根据当前视口宽度将单个 Entry 渲染为带样式与 Soft Wrap 的终端行
   */
  private renderEntryLines(entry: FormattedTranscriptEntry, width: number): string[] {
    const effectiveWidth = Math.max(20, width);

    if (entry.kind === "model_response") {
      if (entry.rawContent) {
        const rendered = TerminalMarkdownRenderer.render(entry.rawContent, {
          maxWidth: effectiveWidth,
          indent: "  ",
        });
        const styled = this.applyModelResponseBullet(rendered);
        return [...styled, ""];
      }
      return entry.lines;
    }

    if (entry.kind === "user_message") {
      if (entry.rawContent) {
        return formatUserMessageLines(entry.rawContent, "normal", effectiveWidth, this.detailedView);
      }
      return entry.lines;
    }

    if (entry.kind === "thought_summary") {
      if (entry.thoughtData) {
        const rawDur = entry.thoughtData.durationMs;
        const duration = typeof rawDur === "number" && !Number.isNaN(rawDur) ? rawDur : undefined;
        const durStr = duration !== undefined
          ? ` for ${duration >= 1000 ? (duration / 1000).toFixed(1) + "s" : duration + "ms"}`
          : "";
        const recalledCount = entry.thoughtData.recalledMemoriesCount ?? entry.thoughtData.recalledMemories?.length ?? 0;
        const memoryPart = recalledCount > 0
          ? `, recalled ${recalledCount} memor${recalledCount === 1 ? "y" : "ies"}`
          : "";
        const expandHint = recalledCount > 0
          ? ` \x1b[90m(ctrl+o to ${this.detailedView ? "collapse" : "expand"})\x1b[0m`
          : "";
        const lines = [`  \x1b[38;5;244m* Thought${durStr}${memoryPart}\x1b[0m${expandHint}`];

        if (this.detailedView && entry.thoughtData.recalledMemories && entry.thoughtData.recalledMemories.length > 0) {
          for (const m of entry.thoughtData.recalledMemories) {
            lines.push(`    \x1b[90m↳ [${m.kind}|${m.scope}] ${m.content}\x1b[0m`);
          }
        }

        if (entry.thoughtData.summaryText) {
          const wrappedSummary = TerminalMarkdownRenderer.wrapStyledText(
            `↳ ${entry.thoughtData.summaryText}`,
            effectiveWidth - 4,
            "      ",
            "    \x1b[90m"
          );
          lines.push(...wrappedSummary.map((l) => (l.endsWith("\x1b[0m") ? l : `${l}\x1b[0m`)));
        }
        lines.push("");
        return lines;
      }
      return entry.lines;
    }

    if (entry.kind === "direct_shell" && entry.shellData) {
      const { command, output, exitCode, durationMs } = entry.shellData;
      const durationStr = durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
      const icon = exitCode === 0 ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
      const expandHint = !this.detailedView ? " \x1b[90m(ctrl+o to expand)\x1b[0m" : "";
      const mainLine = `  ${icon} \x1b[1m\x1b[33m!\x1b[0m \x1b[1m${command}\x1b[0m \x1b[90m· ${durationStr} (exit ${exitCode})\x1b[0m${expandHint}`;

      const lines: string[] = [mainLine];
      const rawLines = output.trim().split(/\r?\n/).filter((l) => l.length > 0);
      if (rawLines.length === 0) {
        lines.push(`    \x1b[90m(no output)\x1b[0m`, "");
        return lines;
      }

      const formattedOutputLines = rawLines.map((l) => `    \x1b[90m${safeToolText(l)}\x1b[0m`);

      if (!this.detailedView && formattedOutputLines.length > 8) {
        const top = formattedOutputLines.slice(0, 4);
        const bottom = formattedOutputLines.slice(-2);
        const hiddenCount = formattedOutputLines.length - 6;
        lines.push(...top);
        lines.push(`    \x1b[90m… ${hiddenCount} lines hidden (ctrl+o to expand)\x1b[0m`);
        lines.push(...bottom);
      } else {
        lines.push(...formattedOutputLines);
      }
      lines.push("");
      return lines;
    }

    return entry.lines;
  }

  getAllRenderedLines(width = 80): string[] {
    const all: string[] = [];
    for (const entry of this.entries) {
      all.push(...this.renderEntryLines(entry, width));
    }
    return all;
  }

  /**
   * 自适应渲染紧凑或详细 Timeline 视图
   */
  getDisplayLines(width = 80): string[] {
    const effectiveWidth = Math.max(20, width);
    const cacheKey = `${effectiveWidth}:${this.detailedView}:${this.revision}`;
    if (cacheKey === this.layoutCacheKey) {
      return this.cachedDisplayLines;
    }

    if (this.detailedView) {
      const all = this.getAllRenderedLines(effectiveWidth);
      this.layoutCacheKey = cacheKey;
      this.cachedDisplayLines = all;
      return all;
    }

    const lines: string[] = [];
    const filePath = (entry: FormattedTranscriptEntry): string | undefined => {
      const pair = entry.toolPair;
      if (!pair || !["read_file", "edit_file", "write_file"].includes(pair.toolName)) return undefined;
      if (typeof pair.rawArgs === "object" && pair.rawArgs && typeof pair.rawArgs.path === "string")
        return pair.rawArgs.path;
      if (typeof pair.rawArgs === "string") {
        try {
          const args = JSON.parse(pair.rawArgs);
          if (typeof args.path === "string") return args.path;
        } catch {}
      }
      return undefined;
    };

    for (let i = 0; i < this.entries.length; ) {
      const entry = this.entries[i]!;
      const target = filePath(entry);
      if (target && entry.toolPair?.status !== "failed") {
        const group: FormattedTranscriptEntry[] = [];
        let next = i;
        while (next < this.entries.length) {
          const candidate = this.entries[next]!;
          if (filePath(candidate) === target && candidate.toolPair?.status !== "failed") {
            group.push(candidate);
            next++;
          } else if (
            (candidate.kind === "thought" || candidate.kind === "thought_summary") &&
            next + 1 < this.entries.length &&
            filePath(this.entries[next + 1]!) === target &&
            this.entries[next + 1]!.toolPair?.status !== "failed"
          ) {
            next++;
          } else break;
        }
        if (group.length >= 2) {
          const reads = group.filter((item) => item.toolPair?.toolName === "read_file").length;
          const edits = group.filter(
            (item) => item.toolPair?.toolName === "edit_file" || item.toolPair?.toolName === "write_file"
          ).length;
          const active = group.some((item) => item.toolPair?.status === "running");
          const counts = [
            edits ? `${edits} edit${edits === 1 ? "" : "s"}` : "",
            reads ? `${reads} read${reads === 1 ? "" : "s"}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
          lines.push(
            `  ${active ? "\x1b[36m●" : "\x1b[32m✔"}\x1b[0m \x1b[1m${path.basename(
              target
            )}\x1b[0m \x1b[90m· ${counts} · Ctrl+O details\x1b[0m`
          );
          i = next;
          continue;
        }
      }

      if (entry.kind === "tool_pair") {
        if (entry.toolPair?.toolName === "write_file" && entry.toolPair.status === "completed") {
          const rendered = this.renderEntryLines(entry, effectiveWidth);
          lines.push(...rendered.slice(0, 2), "");
        } else {
          lines.push(...this.renderEntryLines(entry, effectiveWidth));
        }
      } else if (entry.kind === "thought_summary") {
        const rawDur = entry.thoughtData?.durationMs;
        const duration = typeof rawDur === "number" && !Number.isNaN(rawDur) ? rawDur : undefined;
        const durStr = duration !== undefined
          ? ` for ${duration >= 1000 ? (duration / 1000).toFixed(1) + "s" : duration + "ms"}`
          : "";
        const recalledCount = entry.thoughtData?.recalledMemoriesCount ?? entry.thoughtData?.recalledMemories?.length ?? 0;
        const memoryPart = recalledCount > 0
          ? `, recalled ${recalledCount} memor${recalledCount === 1 ? "y" : "ies"}`
          : "";
        const expandHint = recalledCount > 0
          ? ` \x1b[90m(ctrl+o to ${this.detailedView ? "collapse" : "expand"})\x1b[0m`
          : "";
        lines.push(`  \x1b[38;5;244m* Thought${durStr}${memoryPart}\x1b[0m${expandHint}`);

        if (this.detailedView && entry.thoughtData?.recalledMemories && entry.thoughtData.recalledMemories.length > 0) {
          for (const m of entry.thoughtData.recalledMemories) {
            lines.push(`    \x1b[90m↳ [${m.kind}|${m.scope}] ${m.content}\x1b[0m`);
          }
        }
      } else if (entry.kind === "thought") {
        lines.push(entry.lines[0] ?? "");
      } else {
        lines.push(...this.renderEntryLines(entry, effectiveWidth));
      }
      i++;
    }

    this.layoutCacheKey = cacheKey;
    this.cachedDisplayLines = lines;
    return lines;
  }

  /**
   * 视口滚动操作
   */
  scrollUp(lines = 1, totalLines?: number, viewportHeight?: number): void {
    this.autoFollow = false;
    const all = totalLines ?? (this.cachedDisplayLines && this.cachedDisplayLines.length > 0 ? this.cachedDisplayLines.length : undefined);
    if (all !== undefined) {
      const maxOffset = viewportHeight ? Math.max(0, all - viewportHeight) : Math.max(0, all - 1);
      this.scrollOffset = Math.min(maxOffset, this.scrollOffset + lines);
    } else {
      this.scrollOffset += lines;
    }
  }

  scrollDown(lines = 1): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
    if (this.scrollOffset === 0) {
      this.autoFollow = true;
    }
  }

  pageUp(pageSize = 10): void {
    this.scrollUp(pageSize);
  }

  pageDown(pageSize = 10): void {
    this.scrollDown(pageSize);
  }

  scrollToTop(totalLines?: number, viewportHeight?: number): void {
    this.autoFollow = false;
    const all = totalLines ?? (this.cachedDisplayLines && this.cachedDisplayLines.length > 0 ? this.cachedDisplayLines.length : 100);
    const height = viewportHeight ?? 10;
    this.scrollOffset = Math.max(0, all - height);
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
    this.autoFollow = true;
  }

  /**
   * 渲染指定高度与宽度的视口内容 (支持自适应列宽动态重排与平滑滚动)
   */
  renderViewport(options: ViewportRenderOptions): string[] {
    const { width, height } = options;
    const allLines = this.getDisplayLines(width);
    const totalLines = allLines.length;

    if (totalLines === 0) {
      return ["  \x1b[90m(暂无执行历史)\x1b[0m"];
    }

    const maxOffset = Math.max(0, totalLines - height);
    if (this.scrollOffset > maxOffset) {
      this.scrollOffset = maxOffset;
    }

    let startIdx = 0;
    if (this.autoFollow || this.scrollOffset === 0) {
      startIdx = Math.max(0, totalLines - height);
    } else {
      const bottomIdx = Math.max(0, totalLines - this.scrollOffset);
      startIdx = Math.max(0, bottomIdx - height);
    }

    const endIdx = Math.min(totalLines, startIdx + height);
    const visibleLines = allLines.slice(startIdx, endIdx);

    return visibleLines.map((line) => truncateToDisplayWidth(line, Math.max(20, width)));
  }

  getViewportStartIndex(width: number, height: number): number {
    const totalLines = this.getDisplayLines(width).length;
    const offset = Math.min(this.scrollOffset, Math.max(0, totalLines - height));
    return Math.max(0, totalLines - offset - height);
  }

  clear(): void {
    this.entries = [];
    this.pendingToolCalls.clear();
    this.scrollOffset = 0;
    this.autoFollow = true;
    this.detailedView = false;
    this.revision++;
    this.layoutCacheKey = "";
    this.cachedDisplayLines = [];
  }

  hasEntries(): boolean {
    return this.entries.length > 0;
  }

  popLastUserMessageIfMatch(content?: string): void {
    if (this.entries.length > 0) {
      const last = this.entries[this.entries.length - 1];
      if (last && last.kind === "user_message") {
        this.entries.pop();
        this.revision++;
      }
    }
  }

  /**
   * 获取当前最新一条助手回答纯文本 (用于 /copy 命令)
   */
  getLatestModelResponseText(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.kind === "model_response") {
        if (e.rawContent) return e.rawContent;
        if (e.lines.length > 0) {
          return e.lines
            .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
            .join("\n")
            .trim();
        }
      }
    }
    return undefined;
  }

  /**
   * 检查是否已经存在匹配的 Model Response
   */
  hasModelResponseMatching(answer?: string): boolean {
    if (!answer || !answer.trim() || this.entries.length === 0) return false;
    const norm = answer.trim();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.kind === "model_response") {
        if (e.rawContent && (e.rawContent === norm || e.rawContent.includes(norm) || norm.includes(e.rawContent))) {
          return true;
        }
        if (e.lines.length > 0) {
          const text = e.lines
            .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
            .join("\n")
            .trim();
          if (text && (text === norm || text.includes(norm.slice(0, 20)) || norm.includes(text.slice(0, 20)))) {
            return true;
          }
        }
      }
    }
    return false;
  }

  getEntryCount(): number {
    return this.entries.length;
  }
}
