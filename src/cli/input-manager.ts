import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import stringWidth from "string-width";
import {
  type InputManagerOptions,
  type InputReadable,
  type OutputWritable,
  type InteractionMode,
  type AskYesNoOptions,
  type NavigationHandler,
  InputBusyError,
} from "./types.js";
import { TerminalInputParser, type ParsedInputEvent } from "./terminal-input-parser.js";
import { SystemClipboard } from "./clipboard.js";
import { InputAttachmentManager } from "./input-attachments.js";
import { completeSlashCommand } from "./slash-commands-registry.js";

/**
 * 统一终端输入管理器（Terminal Input Manager）。
 * 整个应用程序唯一允许直接消费 `process.stdin` 的组件。
 *
 * 核心设计与所有权保证：
 * 1. 作为终端输入行与光标位置的唯一 Owner，杜绝外部 Presenter 越权操作输入行；
 * 2. 采用标准 Intl.Segmenter 实现字形簇 (Grapheme Cluster) 级精准行编辑；
 * 3. 严格使用 string-width 测量终端物理显示列宽，彻底根除 CJK 双宽中文字符与 Emoji 退格“幽灵残影”；
 * 4. 完美支持退格 (Backspace)、Delete、左右方向键、Home/End、单词跳转 (Ctrl+W) 与 Bracketed Paste 多行粘贴；
 * 5. 基于 TerminalInputParser 完整解析 SGR 鼠标滚轮与复杂 ANSI CSI 序列，滚轮绝不误触 Escape；
 * 6. 支持精确 InteractionMode 状态机分流：idle, running-main, agent-detail, structured-decision, plan-revision。
 */
export class InputManager {
  private readonly input: InputReadable;
  private readonly output: OutputWritable;
  private readonly isTTY: boolean;
  private readonly onInterrupt?: () => void;
  private readonly autoMouseReporting: boolean;

  private interactionMode: InteractionMode = "idle";
  private navigationHandler: NavigationHandler | null = null;
  private isPasting = false;
  private isClosed = false;
  private isRestored = false;
  private isMouseReportingEnabled = false;
  private escapeTimer: NodeJS.Timeout | null = null;
  // 鼠标 SGR 序列可能在高负载下跨多个事件循环到达；给单独 Esc 留出完整分片窗口。
  private readonly ESCAPE_TIMEOUT_MS = 75;
  private lastInterruptTimestamp = 0;
  private readonly DOUBLE_INTERRUPT_WINDOW_MS = 600;

  // 运行期间消息输入缓冲 (Composer)
  private composerGraphemes: string[] = [];
  private composerCursorPos = 0;
  private followupMode: "steer" | "queue" = "steer";
  private resumeQueryGraphemes: string[] = [];

  // 输入附件与剪贴板管理器 (长文本折叠与图片输入)
  readonly attachmentManager = new InputAttachmentManager();

  // 国际化字形分词器（标准 ECMAScript 支持，精确切分 emoji、ZWJ 序列与组合字符）
  private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  // 当前行逻辑字形簇列表与光标在字形数组中的逻辑索引位置 (0 <= cursorPos <= graphemes.length)
  private graphemes: string[] = [];
  private cursorPos = 0;
  private currentPrompt = "";

  // TTY 原始输入缓冲区
  private rawInputBuffer = "";

  // 当前挂起的 Reader 回调
  private pendingResolver: ((value: string) => void) | null = null;
  private pendingApprovalResolver: ((value: boolean) => void) | null = null;
  private pendingRejecter: ((err: Error) => void) | null = null;

  // 审批模式下的上下文状态
  private approvalDefaultValue = false;
  private approvalPromptText = "";

  // 非 TTY / Pipe 流状态
  private nonTtyBuffer = "";
  private nonTtyEnded = false;
  private nonTtyConsumed = false;

  // 事件监听器引用
  private readonly boundOnData = (chunk: string | Buffer) => this.handleData(chunk);
  private readonly boundOnEnd = () => this.handleStreamEnd();
  private readonly boundCleanup = () => this.restoreTerminal();

  constructor(options?: InputManagerOptions) {
    this.input = options?.input ?? defaultStdin;
    this.output = options?.output ?? defaultStdout;
    this.isTTY = options?.isTTY ?? Boolean(this.input.isTTY);
    this.onInterrupt = options?.onInterrupt;
    this.autoMouseReporting = options?.enableMouseReporting ?? false;

    if (this.isTTY) {
      if (typeof this.input.setEncoding === "function") {
        this.input.setEncoding("utf8");
      }
      if (typeof this.input.setRawMode === "function") {
        this.input.setRawMode(true);
      }
      // 向终端下发 Bracketed Paste 启用控制序列
      this.output.write("\x1b[?2004h");

      // 注册进程退出时的终端状态还原保护
      process.once("exit", this.boundCleanup);
      process.once("SIGINT", this.boundCleanup);
      process.once("SIGTERM", this.boundCleanup);
    }

    this.input.on("data", this.boundOnData);
    this.input.on("end", this.boundOnEnd);
    if (this.input.readableFlowing === false) this.input.resume?.();
  }

  /**
   * 将字符串分解为字形簇列表
   */
  private toGraphemes(text: string): string[] {
    return Array.from(this.segmenter.segment(text), (s) => s.segment);
  }

  private emitComposer(): void {
    this.navigationHandler?.onComposerChange?.(this.composerGraphemes.join(""), this.composerCursorPos);
  }

  private insertComposerText(text: string): void {
    const graphemes = this.toGraphemes(text);
    this.composerCursorPos = Math.min(this.composerCursorPos, this.composerGraphemes.length);
    this.composerGraphemes.splice(this.composerCursorPos, 0, ...graphemes);
    this.composerCursorPos += graphemes.length;
    this.emitComposer();
  }

  /**
   * 插入粘贴板文本至 Composer (支持多行长文本自动折叠与图片拖拽/路径识别)
   */
  private insertComposerPastedText(rawText: string): void {
    if (!rawText) return;
    const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const trimmed = normalized.trim();

    // 1. 尝试识别本地图片路径
    const imagePlaceholder = this.attachmentManager.tryRegisterImage(trimmed);
    if (imagePlaceholder) {
      this.insertComposerText(imagePlaceholder);
      return;
    }

    // 2. 尝试长文本折叠 (>= 3 行或极长换行文本)
    if (this.attachmentManager.shouldCollapse(normalized)) {
      const pastePlaceholder = this.attachmentManager.registerPastedBlock(normalized);
      this.insertComposerText(pastePlaceholder);
      return;
    }

    // 3. 普通单行短文本正常插入
    this.insertComposerText(normalized);
  }

  private editComposer(ev: ParsedInputEvent): boolean {
    this.composerCursorPos = Math.min(this.composerCursorPos, this.composerGraphemes.length);
    const count = this.composerGraphemes.length;
    switch (ev.type) {
      case "arrow-left":
        if (count === 0) return false;
        this.composerCursorPos = Math.max(0, this.composerCursorPos - 1);
        break;
      case "arrow-right":
        if (count === 0) return false;
        this.composerCursorPos = Math.min(count, this.composerCursorPos + 1);
        break;
      case "home":
      case "ctrl-a":
        if (count === 0) return false;
        this.composerCursorPos = 0;
        break;
      case "end":
      case "ctrl-e":
        if (count === 0) return false;
        this.composerCursorPos = count;
        break;
      case "backspace":
        if (this.composerCursorPos > 0) {
          // 检查光标前是否完整匹配某个 attachment placeholder，若是则整块删除
          const textBeforeCursor = this.composerGraphemes.slice(0, this.composerCursorPos).join("");
          let matchedPlaceholder: string | null = null;
          for (const ph of this.attachmentManager.getAllPlaceholders()) {
            if (textBeforeCursor.endsWith(ph)) {
              matchedPlaceholder = ph;
              break;
            }
          }
          if (matchedPlaceholder) {
            const phCount = this.toGraphemes(matchedPlaceholder).length;
            this.composerGraphemes.splice(this.composerCursorPos - phCount, phCount);
            this.composerCursorPos -= phCount;
          } else {
            this.composerGraphemes.splice(--this.composerCursorPos, 1);
          }
        }
        break;
      case "delete":
        if (this.composerCursorPos < count) this.composerGraphemes.splice(this.composerCursorPos, 1);
        break;
      case "ctrl-u":
        this.composerGraphemes.splice(0, this.composerCursorPos);
        this.composerCursorPos = 0;
        break;
      case "ctrl-k":
        this.composerGraphemes.splice(this.composerCursorPos);
        break;
      case "ctrl-w": {
        let start = this.composerCursorPos;
        while (start > 0 && /\s/u.test(this.composerGraphemes[start - 1])) start--;
        while (start > 0 && !/\s/u.test(this.composerGraphemes[start - 1])) start--;
        this.composerGraphemes.splice(start, this.composerCursorPos - start);
        this.composerCursorPos = start;
        break;
      }
      default:
        return false;
    }
    this.emitComposer();
    return true;
  }

  /**
   * 启用 SGR 鼠标报告 (1000 点击、1002 拖动、1006 坐标格式)
   */
  enableMouseReporting(): void {
    if (!this.isTTY || this.isClosed) return;
    try {
      this.output.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
      this.isMouseReportingEnabled = true;
      this.isRestored = false;
    } catch {}
  }

  /**
   * 关闭全套终端鼠标报告模式 (1000, 1006, 1002, 1003, 1015)
   */
  disableMouseReporting(): void {
    if (!this.isTTY) return;
    try {
      this.output.write("\x1b[?1000l\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1015l");
      this.isMouseReportingEnabled = false;
    } catch {}
  }

  /**
   * 刷新当前活动终端行（零残影、精准光标对齐）
   */
  private refreshLine(): void {
    if (!this.isTTY) return;

    const promptLines = this.currentPrompt.split(/\r?\n/);
    const activePromptLine = promptLines[promptLines.length - 1] ?? "";
    const promptWidth = stringWidth(activePromptLine);

    const fullText = this.graphemes.join("");
    const textBeforeCursor = this.graphemes.slice(0, this.cursorPos).join("");
    const cursorCol = promptWidth + stringWidth(textBeforeCursor);

    const moveCursor = cursorCol > 0 ? `\x1b[${cursorCol}C` : "";
    this.output.write(`\r${activePromptLine}${fullText}\x1b[K\r${moveCursor}`);
  }

  /**
   * 读取用户主提示词消息（如 Nash > ）
   */
  async readUserMessage(prompt?: string): Promise<string> {
    if (this.isClosed) {
      throw new Error("InputManager is closed");
    }

    if (this.interactionMode !== "idle") {
      throw new InputBusyError(
        `InputManager is busy in mode: ${this.interactionMode}`
      );
    }

    if (!this.isTTY) {
      if (this.nonTtyConsumed) {
        return "exit";
      }
      if (this.nonTtyEnded) {
        this.nonTtyConsumed = true;
        return this.nonTtyBuffer;
      }
      this.interactionMode = "user-input";
      return new Promise<string>((resolve, reject) => {
        this.pendingResolver = (val) => {
          this.nonTtyConsumed = true;
          resolve(val);
        };
        this.pendingRejecter = reject;
      });
    }

    this.interactionMode = "user-input";
    this.graphemes = [];
    this.cursorPos = 0;
    this.currentPrompt = prompt ?? "";

    if (prompt) {
      this.output.write(prompt);
    }

    if (this.rawInputBuffer.length > 0) {
      this.processRawBuffer();
    }

    return new Promise<string>((resolve, reject) => {
      this.pendingResolver = resolve;
      this.pendingRejecter = reject;
    });
  }

  /**
   * 询问 Yes/No 决策（用于 Sandbox Approval 提权）
   */
  cancelApproval(): void {
    if (this.interactionMode !== "approval") return;
    const resolve = this.pendingApprovalResolver;
    this.pendingApprovalResolver = null;
    this.pendingRejecter = null;
    this.interactionMode = "idle";
    this.graphemes = []; this.cursorPos = 0;
    resolve?.(false);
  }

  async askYesNo(
    prompt: string,
    options?: AskYesNoOptions
  ): Promise<boolean> {
    if (this.isClosed) {
      throw new Error("InputManager is closed");
    }

    if (this.interactionMode !== "idle") {
      throw new InputBusyError(
        `InputManager is busy in mode: ${this.interactionMode}`
      );
    }

    this.approvalDefaultValue = options?.defaultValue ?? false;
    this.approvalPromptText = prompt;
    this.currentPrompt = prompt;

    if (!this.isTTY) {
      return this.approvalDefaultValue;
    }

    this.interactionMode = "approval";
    this.graphemes = [];
    this.cursorPos = 0;
    this.output.write(prompt);

    if (this.rawInputBuffer.length > 0) {
      this.processRawBuffer();
    }

    return new Promise<boolean>((resolve, reject) => {
      this.pendingApprovalResolver = resolve;
      this.pendingRejecter = reject;
    });
  }

  /**
   * 启动运行期间导航模式 (启用全屏 SGR 鼠标报告)
   */
  startNavigationMode(handler: NavigationHandler, mode: InteractionMode = "navigation"): void {
    if (this.isClosed) return;
    this.isRestored = false;
    if (this.isTTY && typeof this.input.setRawMode === "function") {
      try {
        this.input.setRawMode(true);
      } catch {}
    }
    this.interactionMode = mode;
    this.navigationHandler = handler;
    this.graphemes = [];
    this.composerGraphemes = [];
    this.composerCursorPos = 0;
    this.followupMode = "steer";
    this.cursorPos = 0;
    this.rawInputBuffer = "";

    if (this.autoMouseReporting) {
      this.enableMouseReporting();
    }
  }

  /**
   * 动态设置交互模式 (在所有交互全屏模式下维持光标与原始模式)
   */
  setInteractionMode(mode: InteractionMode): void {
    if (this.isClosed) return;
    if (mode === "session-picker" && this.interactionMode !== "session-picker") {
      this.resumeQueryGraphemes = [];
    }
    this.interactionMode = mode;
    if (mode !== "idle" && mode !== "user-input" && mode !== "approval") {
      this.isRestored = false;
      if (this.isTTY && typeof this.input.setRawMode === "function") {
        try {
          this.input.setRawMode(true);
        } catch {}
      }
      if (this.autoMouseReporting) {
        this.enableMouseReporting();
      }
    } else {
      this.disableMouseReporting();
    }
  }

  /**
   * 停止导航模式，恢复至 idle 状态
   */
  stopNavigationMode(): void {
    if (this.isClosed) return;
    this.clearEscapeTimer();
    this.disableMouseReporting();
    this.interactionMode = "idle";
    this.navigationHandler = null;
    this.graphemes = [];
    this.composerGraphemes = [];
    this.composerCursorPos = 0;
    this.cursorPos = 0;
    this.rawInputBuffer = "";
  }

  /**
   * 获取当前输入管理器所处的交互模式
   */
  getInteractionMode(): InteractionMode {
    return this.interactionMode;
  }

  isPastingMode(): boolean {
    return this.isPasting;
  }

  isTerminated(): boolean {
    return this.isClosed;
  }

  close(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.clearEscapeTimer();
    this.restoreTerminal();

    // 兜底：无条件向 output 发送一次完整重置序列
    if (this.isTTY) {
      try {
        this.output.write("\x1b[?1007l\x1b[?1000l\x1b[?1006l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?2004l\x1b[?25h\x1b[0m");
      } catch {}
    }

    this.input.removeListener("data", this.boundOnData);
    this.input.removeListener("end", this.boundOnEnd);
    // process.stdin 在移除 data 监听后仍可能保持 flowing，令 CLI 离开全屏却无法结束进程。
    this.input.pause?.();

    if (this.isTTY) {
      process.removeListener("exit", this.boundCleanup);
      process.removeListener("SIGINT", this.boundCleanup);
      process.removeListener("SIGTERM", this.boundCleanup);
    }

    if (this.pendingRejecter) {
      this.pendingRejecter(new Error("InputManager closed"));
      this.pendingResolver = null;
      this.pendingApprovalResolver = null;
      this.pendingRejecter = null;
    }

    this.interactionMode = "idle";
  }

  private restoreTerminal(): void {
    this.clearEscapeTimer();
    if (this.isTTY && !this.isRestored) {
      this.isRestored = true;
      this.disableMouseReporting();
      try {
        this.output.write("\x1b[?1007l\x1b[?2004l\x1b[?25h\x1b[0m");
      } catch {}
      try {
        if (typeof this.input.setRawMode === "function") {
          this.input.setRawMode(false);
        }
      } catch {}
    }
  }

  private handleData(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    if (!this.isTTY) {
      this.nonTtyBuffer += text;
      return;
    }

    this.rawInputBuffer += text;
    this.processRawBuffer();
  }

  private handleStreamEnd(): void {
    this.nonTtyEnded = true;

    if (!this.isTTY && this.interactionMode === "user-input") {
      this.interactionMode = "idle";
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve(this.nonTtyBuffer);
      }
    } else if (this.graphemes.length > 0) {
      this.handleEnter();
    } else {
      this.handleEof();
    }
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }
  }

  private flushPendingEscape(): void {
    this.clearEscapeTimer();
    if (!this.rawInputBuffer || this.isPasting) return;

    if (this.rawInputBuffer === "\x1b") {
      this.rawInputBuffer = "";
      this.dispatchEvent({ type: "escape", raw: "\x1b" });
      return;
    }

    // 若缓冲区以完整的 ANSI / CSI / SS3 / SGR 前缀开头 (如 \x1b[ 或 \x1bO 或 \x1b])
    // 绝对严禁在 50ms 超时后粗暴切掉前缀并将剩余字符当做可打印字符录入！
    // 仅在明确为独立前缀或已包含终结字符时尝试解析；未完成的转义序列保留在缓冲区中等待后续数据
    if (
      this.rawInputBuffer.startsWith("\x1b[") ||
      this.rawInputBuffer.startsWith("\x1bO") ||
      this.rawInputBuffer.startsWith("\x1b]")
    ) {
      const { events, unparsedRemaining } = TerminalInputParser.parse(
        this.rawInputBuffer,
        { allowIncomplete: true }
      );
      this.rawInputBuffer = unparsedRemaining;
      for (const ev of events) {
        this.dispatchEvent(ev);
      }
      return;
    }

    const { events } = TerminalInputParser.parse(this.rawInputBuffer, {
      allowIncomplete: false,
    });
    this.rawInputBuffer = "";
    for (const ev of events) {
      this.dispatchEvent(ev);
    }
  }

  private processRawBuffer(): void {
    this.clearEscapeTimer();

    while (this.rawInputBuffer.length > 0) {
      if (this.isPasting) {
        const endIdx = this.rawInputBuffer.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          const pasted = this.rawInputBuffer.substring(0, endIdx);
          const normalized = pasted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          if (!normalized || normalized.trim().length === 0) {
            // 当收到空 Bracketed Paste 序列时 (macOS 用户按 Cmd+V 粘贴纯剪贴板图片位图)，
            // 终端无法向 stdin 发送二进制，此时主动探测系统剪贴板并载入图片
            const imgTemp = SystemClipboard.readImageToTempFile();
            if (imgTemp) {
              this.insertTextAtCursor(imgTemp);
            }
          } else {
            this.insertTextAtCursor(normalized);
          }
          this.isPasting = false;
          this.rawInputBuffer = this.rawInputBuffer.substring(endIdx + 6);
          continue;
        } else {
          const prefixLen = this.getPrefixMatchLength(
            this.rawInputBuffer,
            "\x1b[201~"
          );
          if (prefixLen > 0) {
            const safeText = this.rawInputBuffer.substring(
              0,
              this.rawInputBuffer.length - prefixLen
            );
            const normalized = safeText
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            this.insertTextAtCursor(normalized);
            this.rawInputBuffer = this.rawInputBuffer.slice(-prefixLen);
            this.escapeTimer = setTimeout(() => this.flushPendingEscape(), this.ESCAPE_TIMEOUT_MS);
            break;
          } else {
            const normalized = this.rawInputBuffer
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            this.insertTextAtCursor(normalized);
            this.rawInputBuffer = "";
            break;
          }
        }
      } else {
        const startIdx = this.rawInputBuffer.indexOf("\x1b[200~");
        if (startIdx !== -1) {
          const beforePaste = this.rawInputBuffer.substring(0, startIdx);
          const { events } = TerminalInputParser.parse(beforePaste, {
            allowIncomplete: false,
          });
          for (const ev of events) {
            this.dispatchEvent(ev);
          }
          this.isPasting = true;
          this.rawInputBuffer = this.rawInputBuffer.substring(startIdx + 6);
          continue;
        } else {
          // 仅当 prefixLen >= 3 (即至少匹配至 \x1b[2 时) 才视为可能的 Bracketed Paste 开始标记
          // 严禁将普通的 \x1b 或 \x1b[ 误判为 Bracketed Paste 前缀而将后续序列强行切断！
          const prefixLen = this.getPrefixMatchLength(
            this.rawInputBuffer,
            "\x1b[200~"
          );
          if (prefixLen >= 3) {
            const safeText = this.rawInputBuffer.substring(
              0,
              this.rawInputBuffer.length - prefixLen
            );
            const { events } = TerminalInputParser.parse(safeText, {
              allowIncomplete: false,
            });
            for (const ev of events) {
              this.dispatchEvent(ev);
            }
            this.rawInputBuffer = this.rawInputBuffer.slice(-prefixLen);
            this.escapeTimer = setTimeout(() => this.flushPendingEscape(), this.ESCAPE_TIMEOUT_MS);
            break;
          } else {
            const { events, unparsedRemaining } = TerminalInputParser.parse(
              this.rawInputBuffer,
              { allowIncomplete: true }
            );
            this.rawInputBuffer = unparsedRemaining;
            for (const ev of events) {
              this.dispatchEvent(ev);
            }

            // 仅当缓冲区仅剩单独一个 \x1b 字符时，才需启动 50ms 计时器以区分独立 Escape 键还是转义序列
            // 对于以 \x1b[ 或 \x1bO 等开头的 CSI 序列前缀，静候后续数据包，绝不在 50ms 内超时丢弃前缀
            if (this.rawInputBuffer === "\x1b") {
              this.escapeTimer = setTimeout(
                () => this.flushPendingEscape(),
                this.ESCAPE_TIMEOUT_MS
              );
            }
            break;
          }
        }
      }
    }
  }

  private insertTextAtCursor(text: string): void {
    if (!text) return;
    const mode = this.resolveCurrentMode();
    if (mode === "session-picker") {
      this.resumeQueryGraphemes.push(...this.toGraphemes(text.replace(/\s+/g, " ")));
      this.navigationHandler?.onResumeQueryChange?.(this.resumeQueryGraphemes.join(""));
      return;
    }

    if (
      mode === "running-main" ||
      mode === "navigation" ||
      mode === "session-ready" ||
      mode === "empty-session" ||
      mode === "agent-detail" ||
      mode === "plan-revision"
    ) {
      this.insertComposerPastedText(text);
      return;
    }

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const newGraphemes = this.toGraphemes(normalized);
    this.graphemes.splice(this.cursorPos, 0, ...newGraphemes);
    this.cursorPos += newGraphemes.length;
    this.refreshLine();
  }

  /**
   * 基于 TerminalInputParser 产出的强类型事件执行精准分发
   */
  private processParsedKeystrokes(text: string): void {
    const { events } = TerminalInputParser.parse(text, { allowIncomplete: false });
    for (const ev of events) {
      this.dispatchEvent(ev);
    }
  }

  getAttachmentManager(): InputAttachmentManager {
    return this.attachmentManager;
  }

  private handlePasteFromClipboard(): void {
    const imgTemp = SystemClipboard.readImageToTempFile();
    if (imgTemp) {
      this.insertTextAtCursor(imgTemp);
      return;
    }
    const text = SystemClipboard.readText();
    if (text) {
      this.insertTextAtCursor(text);
    }
  }

  private dispatchEvent(ev: ParsedInputEvent): void {
    // 1. 全局优先级最高：Ctrl+C
    if (ev.type === "ctrl-c") {
      if (this.resolveCurrentMode() === "session-picker") {
        if (this.navigationHandler?.isRunActive?.() !== true) {
          this.requestExit();
          return;
        }
        this.navigationHandler?.onResumeCancel?.();
      }
      this.handleInterrupt();
      return;
    }

    // 2. 剪贴板快捷键：Ctrl+V
    if (ev.type === "ctrl-v") {
      this.handlePasteFromClipboard();
      return;
    }

    // 鼠标事件交给展示层处理；其它控制序列仍然安全丢弃。
    if (ev.type === "mouse-button") {
      if (ev.mouse && this.navigationHandler) this.navigationHandler.onMouseButton?.(ev.mouse);
      return;
    }
    if (ev.type === "unknown-sequence") {
      return;
    }

    const mode = this.resolveCurrentMode();

    // 支持快捷键 Ctrl+P / Ctrl+N 辅助选择 Agent
    if (["running-main", "navigation", "agent-detail", "session-ready", "empty-session"].includes(mode)) {
      if (ev.type === "ctrl-arrow-up" || ev.type === "ctrl-p") {
        this.navigationHandler?.onKeyUp?.();
        return;
      }
      if (ev.type === "ctrl-arrow-down" || ev.type === "ctrl-n") {
        this.navigationHandler?.onKeyDown?.();
        return;
      }
    }

    if (ev.type === "ctrl-o" && ["running-main", "navigation", "agent-detail", "session-ready", "empty-session"].includes(mode)) {
      this.navigationHandler?.onKeyCtrlO?.();
      return;
    }

    if (mode === "session-picker") {
      if (ev.type === "escape") this.navigationHandler?.onResumeCancel?.();
      else if (ev.type === "enter") this.navigationHandler?.onResumeConfirm?.();
      else if (ev.type === "arrow-up") this.navigationHandler?.onResumeMove?.(-1);
      else if (ev.type === "arrow-down") this.navigationHandler?.onResumeMove?.(1);
      else if (ev.type === "page-up") this.navigationHandler?.onResumeMove?.(-10);
      else if (ev.type === "page-down") this.navigationHandler?.onResumeMove?.(10);
      else if (ev.type === "backspace") {
        this.resumeQueryGraphemes.pop();
        this.navigationHandler?.onResumeQueryChange?.(this.resumeQueryGraphemes.join(""));
      } else if (ev.type === "ctrl-u") {
        this.resumeQueryGraphemes = [];
        this.navigationHandler?.onResumeQueryChange?.("");
      } else if (ev.type === "ctrl-w") {
        while (this.resumeQueryGraphemes.length && /\s/u.test(this.resumeQueryGraphemes.at(-1)!)) this.resumeQueryGraphemes.pop();
        while (this.resumeQueryGraphemes.length && !/\s/u.test(this.resumeQueryGraphemes.at(-1)!)) this.resumeQueryGraphemes.pop();
        this.navigationHandler?.onResumeQueryChange?.(this.resumeQueryGraphemes.join(""));
      } else if (ev.type === "printable" && ev.char) {
        this.resumeQueryGraphemes.push(...this.toGraphemes(ev.char));
        this.navigationHandler?.onResumeQueryChange?.(this.resumeQueryGraphemes.join(""));
      }
      return;
    }

    if (mode === "skills-picker") {
      if (ev.type === "escape") this.navigationHandler?.onSkillsClose?.();
      else if (ev.type === "enter" || (ev.type === "printable" && ev.char === " ")) this.navigationHandler?.onSkillsCycle?.();
      else if (ev.type === "arrow-up") this.navigationHandler?.onSkillsMove?.(-1);
      else if (ev.type === "arrow-down") this.navigationHandler?.onSkillsMove?.(1);
      else if (ev.type === "page-up") this.navigationHandler?.onSkillsMove?.(-10);
      else if (ev.type === "page-down") this.navigationHandler?.onSkillsMove?.(10);
      else if (ev.type === "backspace") {
        this.resumeQueryGraphemes.pop();
        this.navigationHandler?.onSkillsQueryChange?.(this.resumeQueryGraphemes.join(""));
      } else if (ev.type === "ctrl-u") {
        this.resumeQueryGraphemes = [];
        this.navigationHandler?.onSkillsQueryChange?.("");
      } else if (ev.type === "printable" && ev.char && ev.char !== " ") {
        this.resumeQueryGraphemes.push(...this.toGraphemes(ev.char));
        this.navigationHandler?.onSkillsQueryChange?.(this.resumeQueryGraphemes.join(""));
      }
      return;
    }

    if (
      mode === "plan-revision" || mode === "agent-detail" ||
      mode === "session-ready" || mode === "empty-session" ||
      mode === "running-main" || mode === "navigation"
    ) {
      if (this.editComposer(ev)) return;
    }

    // =======================================================================
    // 模式 A: structured-decision (结构化决策独占焦点)
    // =======================================================================
    if (mode === "structured-decision") {
      if (ev.type === "page-up") {
        this.navigationHandler?.onPlanPageUp?.();
        return;
      }
      if (ev.type === "page-down") {
        this.navigationHandler?.onPlanPageDown?.();
        return;
      }
      if (ev.type === "arrow-up") {
        this.navigationHandler?.onDecisionKeyUp?.();
        return;
      }
      if (ev.type === "arrow-down") {
        this.navigationHandler?.onDecisionKeyDown?.();
        return;
      }
      if (ev.type === "enter") {
        this.navigationHandler?.onDecisionConfirm?.();
        return;
      }
      if (ev.type === "escape") {
        this.navigationHandler?.onDecisionCancel?.();
        return;
      }
      if (ev.type === "printable" && ev.char) {
        if (ev.char.toLowerCase() === "d" && this.navigationHandler?.onPlanToggleDetails?.()) return;
        const handled = this.navigationHandler?.onDecisionShortcut?.(ev.char);
        if (handled) return;
      }
      // 决策模式下忽略其它按键，不录入 composer
      return;
    }

    // =======================================================================
    // 模式 B: plan-revision (修改方案文本录入)
    // =======================================================================
    if (mode === "plan-revision") {
      if (ev.type === "escape") {
        this.composerGraphemes = [];
        this.navigationHandler?.onComposerChange?.("");
        this.navigationHandler?.onDecisionCancel?.();
        return;
      }
      if (ev.type === "enter") {
        const draft = this.composerGraphemes.join("");
        this.composerGraphemes = [];
        this.navigationHandler?.onComposerSubmit?.(draft, "steer");
        this.navigationHandler?.onComposerChange?.("");
        return;
      }
      if (ev.type === "backspace") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes.pop();
          this.navigationHandler?.onComposerChange?.(this.composerGraphemes.join(""));
        }
        return;
      }
      if (ev.type === "printable" && ev.char) {
        this.insertComposerText(ev.char);
        return;
      }
      return;
    }

    // =======================================================================
    // 模式 C: agent-detail (单个 Agent 详情与 Transcript 浏览)
    // =======================================================================
    if (mode === "agent-detail") {
      if (ev.type === "ctrl-t") {
        this.navigationHandler?.onKeyCtrlT?.();
        return;
      }
      if (ev.type === "arrow-up") {
        this.navigationHandler?.onKeyUp?.();
        return;
      }
      if (ev.type === "arrow-down") {
        this.navigationHandler?.onKeyDown?.();
        return;
      }
      if (ev.type === "page-up") {
        this.navigationHandler?.onPageUp?.();
        return;
      }
      if (ev.type === "page-down") {
        this.navigationHandler?.onPageDown?.();
        return;
      }
      if (ev.type === "home") {
        this.navigationHandler?.onHome?.();
        return;
      }
      if (ev.type === "end") {
        this.navigationHandler?.onEnd?.();
        return;
      }
      if (ev.type === "mouse-wheel-up") {
        if (this.navigationHandler?.onMouseWheelUp) {
          this.navigationHandler.onMouseWheelUp();
        } else {
          this.navigationHandler?.onPageUp?.();
        }
        return;
      }
      if (ev.type === "mouse-wheel-down") {
        if (this.navigationHandler?.onMouseWheelDown) {
          this.navigationHandler.onMouseWheelDown();
        } else {
          this.navigationHandler?.onPageDown?.();
        }
        return;
      }
      if (ev.type === "escape" || ev.type === "arrow-left") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEscape?.();
        }
        return;
      }
      if (ev.type === "ctrl-x") {
        this.navigationHandler?.onAgentInterrupt?.();
        return;
      }
      if (ev.type === "tab") {
        const draft = this.composerGraphemes.join("");
        if (draft.startsWith("/")) {
          const completed = completeSlashCommand(draft);
          if (completed !== draft) {
            this.composerGraphemes = this.toGraphemes(completed);
            this.composerCursorPos = this.composerGraphemes.length;
            this.emitComposer();
            return;
          }
        }
        return;
      }
      if (ev.type === "enter") {
        if (this.composerGraphemes.length > 0) {
          const draft = this.composerGraphemes.join("");
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerSubmit?.(draft, "steer");
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEnter?.();
        }
        return;
      }
      if (ev.type === "backspace") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes.pop();
          this.navigationHandler?.onComposerChange?.(this.composerGraphemes.join(""));
        }
        return;
      }
      if (ev.type === "printable" && ev.char) {
        this.insertComposerText(ev.char);
        return;
      }
      return;
    }

    // =======================================================================
    // 模式 D1: session-ready / empty-session (准备就绪状态下的 Bottom Composer 与导航)
    // =======================================================================
    if (mode === "session-ready" || mode === "empty-session") {
      if (ev.type === "arrow-up") {
        this.navigationHandler?.onKeyUp?.();
        return;
      }
      if (ev.type === "arrow-down") {
        this.navigationHandler?.onKeyDown?.();
        return;
      }
      if (ev.type === "ctrl-d") {
        if (this.composerGraphemes.length === 0) {
          this.navigationHandler?.onComposerSubmit?.("exit", "start-run");
        }
        return;
      }
      if (ev.type === "page-up") {
        this.navigationHandler?.onPageUp?.();
        return;
      }
      if (ev.type === "page-down") {
        this.navigationHandler?.onPageDown?.();
        return;
      }
      if (ev.type === "home") {
        this.navigationHandler?.onHome?.();
        return;
      }
      if (ev.type === "end") {
        this.navigationHandler?.onEnd?.();
        return;
      }
      if (ev.type === "mouse-wheel-up") {
        if (this.navigationHandler?.onMouseWheelUp) {
          this.navigationHandler.onMouseWheelUp();
        } else {
          this.navigationHandler?.onPageUp?.();
        }
        return;
      }
      if (ev.type === "mouse-wheel-down") {
        if (this.navigationHandler?.onMouseWheelDown) {
          this.navigationHandler.onMouseWheelDown();
        } else {
          this.navigationHandler?.onPageDown?.();
        }
        return;
      }
      if (ev.type === "ctrl-t") {
        this.navigationHandler?.onKeyCtrlT?.();
        return;
      }
      if (ev.type === "tab") {
        const draft = this.composerGraphemes.join("");
        if (draft.startsWith("/")) {
          const completed = completeSlashCommand(draft);
          if (completed !== draft) {
            this.composerGraphemes = this.toGraphemes(completed);
            this.composerCursorPos = this.composerGraphemes.length;
            this.emitComposer();
            return;
          }
        }
        return;
      }
      if (ev.type === "enter") {
        if (this.composerGraphemes.length > 0) {
          const draft = this.composerGraphemes.join("");
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerSubmit?.(draft, "start-run");
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEnter?.();
        }
        return;
      }
      if (ev.type === "escape") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEscape?.();
        }
        return;
      }
      if (ev.type === "backspace") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes.pop();
          this.navigationHandler?.onComposerChange?.(this.composerGraphemes.join(""));
        }
        return;
      }
      if (ev.type === "printable" && ev.char) {
        this.insertComposerText(ev.char);
        return;
      }
      return;
    }

    // =======================================================================
    // 模式 D: running-main / navigation (Main 界面导航与 Composer)
    // =======================================================================
    if (mode === "running-main" || mode === "navigation") {
      if (ev.type === "arrow-up") {
        this.navigationHandler?.onKeyUp?.();
        return;
      }
      if (ev.type === "arrow-down") {
        this.navigationHandler?.onKeyDown?.();
        return;
      }
      if (ev.type === "tab") {
        const draft = this.composerGraphemes.join("");
        if (draft.startsWith("/")) {
          const completed = completeSlashCommand(draft);
          if (completed !== draft) {
            this.composerGraphemes = this.toGraphemes(completed);
            this.composerCursorPos = this.composerGraphemes.length;
            this.emitComposer();
            return;
          }
        }
        this.followupMode = this.followupMode === "steer" ? "queue" : "steer";
        this.navigationHandler?.onFollowupModeChange?.(this.followupMode);
        return;
      }
      if (ev.type === "page-up") {
        this.navigationHandler?.onPageUp?.();
        return;
      }
      if (ev.type === "page-down") {
        this.navigationHandler?.onPageDown?.();
        return;
      }
      if (ev.type === "home") {
        this.navigationHandler?.onHome?.();
        return;
      }
      if (ev.type === "end") {
        this.navigationHandler?.onEnd?.();
        return;
      }
      if (ev.type === "mouse-wheel-up") {
        if (this.navigationHandler?.onMouseWheelUp) {
          this.navigationHandler.onMouseWheelUp();
        } else {
          this.navigationHandler?.onPageUp?.();
        }
        return;
      }
      if (ev.type === "mouse-wheel-down") {
        if (this.navigationHandler?.onMouseWheelDown) {
          this.navigationHandler.onMouseWheelDown();
        } else {
          this.navigationHandler?.onPageDown?.();
        }
        return;
      }
      if (ev.type === "ctrl-q") {
        if (this.composerGraphemes.length > 0) {
          const draft = this.composerGraphemes.join("");
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerSubmit?.(draft, "queue");
          this.navigationHandler?.onComposerChange?.("");
        }
        return;
      }
      if (ev.type === "ctrl-t") {
        this.navigationHandler?.onKeyCtrlT?.();
        return;
      }
      if (ev.type === "arrow-left") {
        this.navigationHandler?.onKeyLeft?.();
        return;
      }
      if (ev.type === "enter") {
        if (this.composerGraphemes.length > 0) {
          const draft = this.composerGraphemes.join("");
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerSubmit?.(draft, this.followupMode);
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEnter?.();
        }
        return;
      }
      if (ev.type === "escape") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes = [];
          this.navigationHandler?.onComposerChange?.("");
        } else {
          this.navigationHandler?.onKeyEscape?.();
        }
        return;
      }
      if (ev.type === "backspace") {
        if (this.composerGraphemes.length > 0) {
          this.composerGraphemes.pop();
          this.navigationHandler?.onComposerChange?.(this.composerGraphemes.join(""));
        }
        return;
      }
      if (this.composerGraphemes.length === 0 && ev.type === "printable" && ev.char) {
        const lower = ev.char.toLowerCase();
        if (lower === "y" || lower === "n") {
          const approvalKey = this.navigationHandler?.onApprovalKey;
          if (approvalKey && approvalKey(lower as "y" | "n") !== false) return;
        }
      }
      if (ev.type === "printable" && ev.char) {
        this.insertComposerText(ev.char);
        return;
      }
      return;
    }

    // =======================================================================
    // 模式 E: idle / user-input / approval (常规行编辑模式)
    // =======================================================================
    if (ev.type === "tab") {
      const line = this.graphemes.join("");
      if (line.startsWith("/")) {
        const completed = completeSlashCommand(line);
        if (completed !== line) {
          this.graphemes = this.toGraphemes(completed);
          this.cursorPos = this.graphemes.length;
          this.refreshLine();
          return;
        }
      }
      return;
    }

    if (ev.type === "ctrl-d") {
      if (this.graphemes.length === 0) {
        this.handleEof();
      } else {
        this.handleEnter();
      }
      return;
    }

    if (ev.type === "enter") {
      this.handleEnter();
      return;
    }

    if (ev.type === "backspace") {
      if (this.cursorPos > 0) {
        this.graphemes.splice(this.cursorPos - 1, 1);
        this.cursorPos--;
        this.refreshLine();
      }
      return;
    }

    if (ev.type === "delete") {
      if (this.cursorPos < this.graphemes.length) {
        this.graphemes.splice(this.cursorPos, 1);
        this.refreshLine();
      }
      return;
    }

    if (ev.type === "arrow-left") {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.refreshLine();
      }
      return;
    }

    if (ev.type === "arrow-right") {
      if (this.cursorPos < this.graphemes.length) {
        this.cursorPos++;
        this.refreshLine();
      }
      return;
    }

    if (ev.type === "ctrl-a" || ev.type === "home") {
      this.cursorPos = 0;
      this.refreshLine();
      return;
    }

    if (ev.type === "ctrl-e" || ev.type === "end") {
      this.cursorPos = this.graphemes.length;
      this.refreshLine();
      return;
    }

    if (ev.type === "ctrl-u") {
      this.graphemes.splice(0, this.cursorPos);
      this.cursorPos = 0;
      this.refreshLine();
      return;
    }

    if (ev.type === "ctrl-k") {
      this.graphemes.splice(this.cursorPos);
      this.refreshLine();
      return;
    }

    if (ev.type === "ctrl-w") {
      if (this.cursorPos > 0) {
        let newPos = this.cursorPos;
        while (newPos > 0 && /\s/.test(this.graphemes[newPos - 1]!)) {
          newPos--;
        }
        while (newPos > 0 && !/\s/.test(this.graphemes[newPos - 1]!)) {
          newPos--;
        }
        this.graphemes.splice(newPos, this.cursorPos - newPos);
        this.cursorPos = newPos;
        this.refreshLine();
      }
      return;
    }

    if (ev.type === "printable" && ev.char) {
      const inserted = this.toGraphemes(ev.char);
      this.graphemes.splice(this.cursorPos, 0, ...inserted);
      this.cursorPos += inserted.length;
      this.refreshLine();
      return;
    }
  }

  private resolveCurrentMode(): InteractionMode {
    if (this.navigationHandler?.hasActiveDecision?.() === true) {
      if (this.navigationHandler?.isPlanRevisionInput?.() === true) {
        return "plan-revision";
      }
      return "structured-decision";
    }
    return this.interactionMode;
  }

  private handleEnter(): void {
    if (this.isTTY) {
      this.output.write("\r\n");
    }

    if (this.interactionMode === "user-input") {
      const submitted = this.graphemes.join("");
      this.graphemes = [];
      this.cursorPos = 0;
      this.interactionMode = "idle";
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve(submitted);
      }
    } else if (this.interactionMode === "approval") {
      const answer = this.graphemes.join("").trim();
      this.graphemes = [];
      this.cursorPos = 0;
      const lower = answer.toLowerCase();

      if (lower === "y" || lower === "yes") {
        this.interactionMode = "idle";
        const resolve = this.pendingApprovalResolver;
        this.pendingApprovalResolver = null;
        this.pendingRejecter = null;
        if (resolve) {
          resolve(true);
        }
      } else if (lower === "n" || lower === "no") {
        this.interactionMode = "idle";
        const resolve = this.pendingApprovalResolver;
        this.pendingApprovalResolver = null;
        this.pendingRejecter = null;
        if (resolve) {
          resolve(false);
        }
      } else if (lower === "") {
        this.interactionMode = "idle";
        const resolve = this.pendingApprovalResolver;
        this.pendingApprovalResolver = null;
        this.pendingRejecter = null;
        if (resolve) {
          resolve(this.approvalDefaultValue);
        }
      } else {
        this.output.write("\x1b[33mPlease enter y or n.\x1b[0m\n");
        this.output.write(this.approvalPromptText);
      }
    }
  }

  private handleEof(): void {
    if (this.interactionMode === "user-input") {
      this.interactionMode = "idle";
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve("exit");
      }
    } else if (this.interactionMode === "approval") {
      this.interactionMode = "idle";
      const resolve = this.pendingApprovalResolver;
      this.pendingApprovalResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve(this.approvalDefaultValue);
      }
    }
  }

  private handleInterrupt(): void {
    const now = Date.now();
    const isDoubleInterrupt =
      this.lastInterruptTimestamp > 0 &&
      now - this.lastInterruptTimestamp <= this.DOUBLE_INTERRUPT_WINDOW_MS;
    this.lastInterruptTimestamp = now;

    if (
      this.interactionMode === "session-ready" ||
      this.interactionMode === "empty-session" ||
      this.interactionMode === "idle" ||
      (this.interactionMode === "agent-detail" && this.navigationHandler?.isRunActive?.() === false)
    ) {
      this.requestExit();
      return;
    }

    if (this.isTTY) {
      this.output.write("^C\r\n");
    }

    this.restoreTerminal();

    if (this.onInterrupt) {
      try {
        this.onInterrupt();
      } catch {}
    }

    this.graphemes = [];
    this.cursorPos = 0;

    // 1. 若 600ms 内快速双击 Ctrl+C，无论处于何种模式或草稿状态，均直接强制触发退出
    if (isDoubleInterrupt) {
      this.composerGraphemes = [];
      const handler = this.navigationHandler;
      this.interactionMode = "idle";

      if (handler?.onComposerSubmit) {
        handler.onComposerSubmit("exit", "start-run");
        return;
      }
      if (this.pendingResolver) {
        const resolve = this.pendingResolver;
        this.pendingResolver = null;
        this.pendingRejecter = null;
        resolve("exit");
        return;
      }
      return;
    }

    if (this.interactionMode === "user-input") {
      this.interactionMode = "idle";
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve("");
      }
    } else if (this.interactionMode === "approval") {
      this.interactionMode = "idle";
      const resolve = this.pendingApprovalResolver;
      this.pendingApprovalResolver = null;
      this.pendingRejecter = null;
      if (resolve) {
        resolve(false);
      }
    } else if (
      this.interactionMode === "running-main" ||
      this.interactionMode === "agent-detail" ||
      this.interactionMode === "structured-decision" ||
      this.interactionMode === "plan-revision" ||
      this.interactionMode === "navigation"
    ) {
      this.interactionMode = "idle";
      if (this.navigationHandler?.onInterrupt) {
        try {
          this.navigationHandler.onInterrupt();
        } catch {}
      }
    }
  }

  private requestExit(): void {
    this.composerGraphemes = [];
    this.composerCursorPos = 0;
    if (this.navigationHandler?.onComposerSubmit) {
      this.navigationHandler.onComposerSubmit("exit", "start-run");
      return;
    }
    if (this.pendingResolver) {
      const resolve = this.pendingResolver;
      this.pendingResolver = null;
      this.pendingRejecter = null;
      resolve("exit");
    }
  }

  private getPrefixMatchLength(target: string, pattern: string): number {
    const maxLen = Math.min(target.length, pattern.length - 1);
    for (let len = maxLen; len > 0; len--) {
      if (target.endsWith(pattern.substring(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
