import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

export interface TerminalRendererOptions {
  stdout?: NodeJS.WriteStream;
  isTTY?: boolean;
}

/**
 * 测量单行字符串在终端中的物理显示列宽 (ANSI 脱敏 + Unicode/CJK 真实列宽)
 */
export function getVisibleWidth(line: string): number {
  return stringWidth(stripAnsi(line));
}

/**
 * 计算单行在指定终端列宽下实际占用的“物理终端行数”
 * 考虑终端自动 Wrap 特性：
 * 空行或 <= columns 占 1 行；超过 columns 按 ceil(width / columns) 换行
 */
export function calculatePhysicalRowsForLine(line: string, columns: number): number {
  const safeColumns = Math.max(10, columns);
  const width = getVisibleWidth(line);
  if (width === 0) return 1;
  return Math.max(1, Math.ceil(width / safeColumns));
}

/**
 * 计算完整 Frame 在指定终端列宽下占用的总物理行数
 */
export function calculateTotalPhysicalRows(frame: string, columns: number): number {
  // 统一换行符
  const normalized = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // 若以 \n 结尾，剥离末尾换行以获得实际行列表
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (!trimmed) return 0;

  const lines = trimmed.split("\n");
  let total = 0;
  for (const line of lines) {
    total += calculatePhysicalRowsForLine(line, columns);
  }
  return total;
}

/**
 * 主动截断单行以确保其显示宽度不超过 maxWidth (保留 ANSI 样式，防止超宽自动 Wrap 破坏终端布局)
 */
export function truncateToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const currentWidth = getVisibleWidth(text);
  if (currentWidth <= maxWidth) {
    return text;
  }

  let accumulated = "";
  let accWidth = 0;
  const targetWidth = Math.max(1, maxWidth - 1); // 留 1 列给省略号 …

  // 保留已渲染部分的 SGR 样式，使超宽代码行的差异底色与语法颜色不会消失。
  const tokens = text.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+|\x1b/g) ?? [];
  let done = false;
  for (const token of tokens) {
    if (done) break;
    if (token === "\x1b") continue;
    if (/^\x1b\[[0-?]*[ -/]*[@-~]$/.test(token)) {
      accumulated += token;
      continue;
    }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(token)) {
      const charWidth = stringWidth(segment);
      if (accWidth + charWidth > targetWidth) {
        done = true;
        break;
      }
      accumulated += segment;
      accWidth += charWidth;
    }
  }

  return `${accumulated}…\x1b[0m`;
}

/** Keep the end of an editable line visible as it grows past the viewport. */
export function tailToDisplayWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (getVisibleWidth(text) <= maxWidth) return text;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment);
  let tail = "";
  let width = 1; // leading ellipsis
  for (let i = graphemes.length - 1; i >= 0; i--) {
    const next = stringWidth(graphemes[i]);
    if (width + next > maxWidth) break;
    tail = graphemes[i] + tail;
    width += next;
  }
  return `…${tail}`;
}

/**
 * TerminalRenderer - 轻量级 Live Region 原地刷新渲染引擎
 *
 * 核心设计：
 * 1. 维护 lastRenderedPhysicalRows，严格按物理高度（考虑 CJK 双宽与 Wrap）上移光标并清除旧帧；
 * 2. 保证整块清除 + 原地重绘，杜绝追加新帧与残影；
 * 3. 串行化渲染循环，防止并发 stdout.write 交叉竞争；
 * 4. Non-TTY 优雅降级（不发射 ANSI 控制序列）；
 * 5. 支持 Terminal Resize 自适应重绘。
 */
export class TerminalRenderer {
  private readonly stdout: NodeJS.WriteStream;
  private readonly isTTY: boolean;

  private lastRenderedPhysicalRows = 0;
  private lastRenderedFrame = "";
  private lastColumns = 80;

  private isRendering = false;
  private needsRender = false;
  private pendingFrame: string | null = null;
  private renderResolver: (() => void) | null = null;

  constructor(options?: TerminalRendererOptions) {
    this.stdout = options?.stdout ?? process.stdout;
    this.isTTY = options?.isTTY ?? Boolean(this.stdout.isTTY);
    this.lastColumns = this.getColumns();
  }

  /**
   * 获取当前终端列宽
   */
  getColumns(): number {
    if (this.isTTY && typeof this.stdout.columns === "number" && this.stdout.columns > 0) {
      return this.stdout.columns;
    }
    return 80;
  }

  /**
   * 获取当前终端行数
   */
  getRows(): number {
    if (this.isTTY && typeof this.stdout.rows === "number" && this.stdout.rows > 0) {
      return this.stdout.rows;
    }
    return 24;
  }

  /**
   * 全屏绝对坐标渲染：从 (1,1) 逐行绘制至 rows，绝对不追加尾部 newline，精准定位光标
   */
  renderFullScreen(
    lines: string[],
    cursorPosition?: { row: number; col: number } | null
  ): void {
    if (!this.isTTY) return;

    const columns = this.getColumns();
    const rows = this.getRows();

    let buffer = "\x1b[?25l"; // 先隐藏光标

    for (let r = 1; r <= rows; r++) {
      const lineContent = lines[r - 1] ?? "";
      const truncated = truncateToDisplayWidth(lineContent, columns);
      buffer += `\x1b[${r};1H\x1b[2K${truncated}\x1b[K`;
    }

    if (cursorPosition) {
      const safeRow = Math.max(1, Math.min(cursorPosition.row, rows));
      const safeCol = Math.max(1, Math.min(cursorPosition.col, columns));
      buffer += `\x1b[${safeRow};${safeCol}H\x1b[?25h`;
    } else {
      buffer += "\x1b[?25l";
    }

    this.stdout.write(buffer);
  }

  /**
   * 获取上一帧渲染占用的物理行数
   */
  getLastRenderedPhysicalRows(): number {
    return this.lastRenderedPhysicalRows;
  }

  /**
   * 获取上一帧内容
   */
  getLastRenderedFrame(): string {
    return this.lastRenderedFrame;
  }

  /**
   * 提交新 Frame 请求进行渲染 (串行化调度，避免交叉写入)
   */
  async renderFrame(frame: string): Promise<void> {
    if (!this.isTTY) {
      // Non-TTY 模式不维护 Live Region，由上层直接处理
      return;
    }

    this.pendingFrame = frame;
    this.needsRender = true;

    if (this.isRendering) {
      // 当前已有渲染在执行，等待其消费 needsRender
      return new Promise<void>((resolve) => {
        const prevResolver = this.renderResolver;
        this.renderResolver = () => {
          if (prevResolver) prevResolver();
          resolve();
        };
      });
    }

    this.isRendering = true;
    try {
      while (this.needsRender && this.pendingFrame !== null) {
        this.needsRender = false;
        const currentFrame = this.pendingFrame;
        this.pendingFrame = null;
        this.doRender(currentFrame);
      }
    } finally {
      this.isRendering = false;
      if (this.renderResolver) {
        const resolve = this.renderResolver;
        this.renderResolver = null;
        resolve();
      }
    }
  }

  /**
   * 真正的同步写入逻辑（单点收口）
   */
  private doRender(frame: string): void {
    const columns = this.getColumns();

    // 优化：若内容与尺寸均完全一致，跳过重复写入
    if (frame === this.lastRenderedFrame && columns === this.lastColumns) {
      return;
    }

    // 1. 如果之前渲染过 frame，先清除旧区域
    this.clearOldRegion(columns);

    // 2. 规范化并输出最新 frame
    let normalized = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.endsWith("\n")) {
      normalized += "\n";
    }

    this.stdout.write(normalized);

    // 3. 计算并记录物理终端高度
    this.lastRenderedPhysicalRows = calculateTotalPhysicalRows(normalized, columns);
    this.lastRenderedFrame = frame;
    this.lastColumns = columns;
  }

  /**
   * 清除旧的 Live Region (将光标移动回旧 Live Region 起点并清除到底部)
   */
  private clearOldRegion(currentColumns: number): void {
    if (this.lastRenderedPhysicalRows > 0 && this.isTTY) {
      // 检查列宽是否发生变化
      // 若列宽变化，按旧列宽所记录的物理高度上移，确保完全覆盖
      const rowsToMoveUp = this.lastRenderedPhysicalRows;
      // \x1b[<N>A: 光标向上移动 N 行
      // \r: 光标回到行首
      // \x1b[J: 从当前光标位置清除至屏幕底部 (clearScreenDown)
      const clearSequence = `\x1b[${rowsToMoveUp}A\r\x1b[J`;
      this.stdout.write(clearSequence);
      this.lastRenderedPhysicalRows = 0;
      this.lastRenderedFrame = "";
    }
  }

  /**
   * 显式清除当前 Live Region 并重置状态（用于 Run 完成、中断或退出）
   */
  clear(): void {
    if (!this.isTTY) return;
    this.clearOldRegion(this.getColumns());
    this.pendingFrame = null;
    this.needsRender = false;
  }

  /**
   * 终端 Resize 响应：根据新尺寸重绘最新 Frame
   */
  handleResize(): void {
    if (!this.isTTY || !this.lastRenderedFrame) return;
    const newColumns = this.getColumns();
    // 使用旧行数清除旧位置，再用新列宽重画
    const frame = this.lastRenderedFrame;
    this.clear();
    this.lastColumns = newColumns;
    this.renderFrame(frame);
  }
}
