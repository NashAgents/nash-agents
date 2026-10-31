import type { OutputWritable } from "../cli/types.js";

export interface TerminalScreenManagerOptions {
  stdout?: OutputWritable;
  isTTY?: boolean;
}

/**
 * TerminalScreenManager - 标准终端 Alternate Screen (备用屏幕) 管理器
 *
 * 核心特性：
 * 1. 使用标准 xterm 控制序列 ESC[?1049h (进入备用屏幕) 与 ESC[?1049l (退出备用屏幕恢复原主屏幕)；
 * 2. 在备用屏幕启用 SGR 鼠标捕获，将触控板/滚轮事件专门用于平滑滚动历史，严禁将滚轮转为方向键；
 * 3. 保证操作的完全幂等性 (Idempotent)，重复进入或退出不会产生副作用；
 * 4. 自动挂载 process.exit / SIGINT / SIGTERM 保护钩子，确保异常或强制退出时必定干净恢复主屏幕；
 * 5. 非 TTY 环境下自动降级为 No-op，绝不输出乱码控制序列。
 */
export class TerminalScreenManager {
  private readonly output: OutputWritable;
  private readonly isTTY: boolean;

  private inAlternateScreen = false;
  private isCleanedUp = false;

  private readonly boundCleanup = () => this.forceRestore();

  constructor(options?: TerminalScreenManagerOptions) {
    this.output = options?.stdout ?? (process.stdout as OutputWritable);
    this.isTTY = options?.isTTY ?? Boolean((this.output as any)?.isTTY ?? process.stdout.isTTY);

    if (this.isTTY) {
      process.once("exit", this.boundCleanup);
      process.once("SIGINT", this.boundCleanup);
      process.once("SIGTERM", this.boundCleanup);
    }
  }

  /**
   * 当前是否处于备用屏幕 (Alternate Screen)
   */
  isAlternateScreen(): boolean {
    return this.inAlternateScreen;
  }

  /**
   * 进入 Alternate Screen (切换至独立全屏视图)
   */
  enterAlternateScreen(): void {
    if (!this.isTTY || this.inAlternateScreen || this.isCleanedUp) {
      return;
    }

    try {
      // \x1b[?1049h: 开启 alternate screen 并保存光标
      // 1000/1002/1006: 捕获滚轮与拖动，锁定滚动视口并由应用处理正文选区。
      // \x1b[?25l: 隐藏光标
      // \x1b[2J\x1b[H: 清全屏并将光标移动至 (1,1)
      this.output.write("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[2J\x1b[H");
      this.inAlternateScreen = true;
    } catch {
      // 静默容错
    }
  }

  /**
   * 退出 Alternate Screen (自动无损恢复主屏幕内容)
   */
  leaveAlternateScreen(): void {
    if (!this.isTTY || !this.inAlternateScreen || this.isCleanedUp) {
      return;
    }

    try {
      // 禁用鼠标报告 + 恢复光标 + 退出 alternate screen 恢复主屏幕
      this.output.write("\x1b[?1007l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?25h\x1b[?1049l");
      this.inAlternateScreen = false;
    } catch {
      // 静默容错
    }
  }

  /**
   * 在 Alternate Screen 内清除并重绘整屏
   */
  clearAlternateScreen(): void {
    if (!this.isTTY || !this.inAlternateScreen || this.isCleanedUp) {
      return;
    }

    try {
      // \x1b[2J: 清全屏; \x1b[H: 光标移动至左上角
      this.output.write("\x1b[2J\x1b[H");
    } catch {
      // 静默容错
    }
  }

  /**
   * 强制安全清理与终端恢复
   */
  forceRestore(): void {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;

    if (this.isTTY) {
      try {
        if (this.inAlternateScreen) {
          this.output.write("\x1b[?1007l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?25h\x1b[?1049l");
          this.inAlternateScreen = false;
        } else {
          this.output.write("\x1b[?1007l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?25h\x1b[0m");
        }
      } catch {}

      process.removeListener("exit", this.boundCleanup);
      process.removeListener("SIGINT", this.boundCleanup);
      process.removeListener("SIGTERM", this.boundCleanup);
    }
  }
}
