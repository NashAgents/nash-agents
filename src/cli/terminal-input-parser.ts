/**
 * TerminalInputParser - 健壮的 ANSI CSI / SS3 / SGR 鼠标序列解析器
 *
 * 核心设计：
 * 1. 严格区分单个 Escape 键与复杂转义序列（方向键、翻页、Home/End、SGR 鼠标等）；
 * 2. 完整支持 SGR 鼠标报告 (1006 模式) 与标准 X10 鼠标报告：
 *    - Mouse Press (Btn 0/1/2 M)
 *    - Mouse Release (Btn 0/1/2 m)
 *    - Mouse Motion / Drag (Btn 32+ M/m)
 *    - Mouse Wheel Up / Down (Btn 64/65 M)
 * 3. 任何合法或未知的鼠标/CSI序列均判定为专用事件或 unknown-sequence，绝不 fallback 触发 Escape；
 * 4. 支持流式数据分片 (Fragmented Input Buffering)：未完成的转义序列保留在 unparsedRemaining 中；
 * 5. 独立 Escape 键仅在明确为 standalone Esc 时触发。
 */

export type ParsedKeyType =
  | "escape"
  | "arrow-up"
  | "arrow-down"
  | "ctrl-arrow-up"
  | "ctrl-arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "page-up"
  | "page-down"
  | "home"
  | "end"
  | "mouse-wheel-up"
  | "mouse-wheel-down"
  | "mouse-button"
  | "ctrl-c"
  | "ctrl-n"
  | "ctrl-p"
  | "ctrl-d"
  | "ctrl-q"
  | "ctrl-t"
  | "ctrl-o"
  | "ctrl-x"
  | "ctrl-v"
  | "tab"
  | "ctrl-w"
  | "ctrl-u"
  | "ctrl-k"
  | "ctrl-a"
  | "ctrl-e"
  | "enter"
  | "backspace"
  | "delete"
  | "printable"
  | "unknown-sequence";

export interface ParsedInputEvent {
  type: ParsedKeyType;
  raw: string;
  char?: string;
  mouse?: {
    button: number;
    col: number;
    row: number;
    isRelease?: boolean;
    isWheelUp?: boolean;
    isWheelDown?: boolean;
    isMotion?: boolean;
    isDrag?: boolean;
  };
}

export interface ParseOptions {
  allowIncomplete?: boolean;
}

export class TerminalInputParser {
  /**
   * 解析缓冲区中的输入数据，返回解析到的事件列表与未解析完的前缀剩余
   */
  static parse(
    text: string,
    options?: ParseOptions
  ): { events: ParsedInputEvent[]; unparsedRemaining: string } {
    const events: ParsedInputEvent[] = [];
    let i = 0;
    const allowIncomplete = options?.allowIncomplete ?? false;

    while (i < text.length) {
      const char = text[i];

      // 1. Ctrl+C (ETX \x03)
      if (char === "\x03") {
        events.push({ type: "ctrl-c", raw: "\x03" });
        i++;
        continue;
      }

      if (char === "\x0e" || char === "\x10") {
        events.push({ type: char === "\x0e" ? "ctrl-n" : "ctrl-p", raw: char });
        i++;
        continue;
      }

      // 2. Ctrl+D (EOT \x04)
      if (char === "\x04") {
        events.push({ type: "ctrl-d", raw: "\x04" });
        i++;
        continue;
      }

      // 3. Ctrl+Q (DC1 \x11)
      if (char === "\x11") {
        events.push({ type: "ctrl-q", raw: "\x11" });
        i++;
        continue;
      }

      // 4. Ctrl+T (DC4 \x14)
      if (char === "\x14") {
        events.push({ type: "ctrl-t", raw: "\x14" });
        i++;
        continue;
      }

      if (char === "\x0f") {
        events.push({ type: "ctrl-o", raw: "\x0f" });
        i++;
        continue;
      }

      if (char === "\x18") {
        events.push({ type: "ctrl-x", raw: "\x18" });
        i++;
        continue;
      }

      if (char === "\x16") {
        events.push({ type: "ctrl-v", raw: "\x16" });
        i++;
        continue;
      }

      if (char === "\t") {
        events.push({ type: "tab", raw: "\t" });
        i++;
        continue;
      }

      // 5. Ctrl+A (SOH \x01)
      if (char === "\x01") {
        events.push({ type: "ctrl-a", raw: "\x01" });
        i++;
        continue;
      }

      // 6. Ctrl+E (ENQ \x05)
      if (char === "\x05") {
        events.push({ type: "ctrl-e", raw: "\x05" });
        i++;
        continue;
      }

      // 7. Ctrl+U (NAK \x15)
      if (char === "\x15") {
        events.push({ type: "ctrl-u", raw: "\x15" });
        i++;
        continue;
      }

      // 8. Ctrl+K (VT \x0b)
      if (char === "\x0b") {
        events.push({ type: "ctrl-k", raw: "\x0b" });
        i++;
        continue;
      }

      // 9. Ctrl+W (ETB \x17)
      if (char === "\x17") {
        events.push({ type: "ctrl-w", raw: "\x17" });
        i++;
        continue;
      }

      // 10. Enter (\r 或 \n 或 \r\n)
      if (char === "\r" || char === "\n") {
        let raw = char;
        if (char === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
          raw = "\r\n";
          i++;
        }
        events.push({ type: "enter", raw });
        i++;
        continue;
      }

      // 11. Backspace (\x7f 或 \x08)
      if (char === "\x7f" || char === "\x08") {
        events.push({ type: "backspace", raw: char });
        i++;
        continue;
      }

      // 12. ANSI / CSI / SS3 / SGR 转义序列 (\x1b 开头)
      if (char === "\x1b") {
        const remaining = text.substring(i);

        // 12.1 SGR 鼠标完整报告: \x1b[<Btn;Col;RowM 或 \x1b[<Btn;Col;Rowm
        const sgrMouseMatch = remaining.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (sgrMouseMatch) {
          const raw = sgrMouseMatch[0];
          const btn = parseInt(sgrMouseMatch[1]!, 10);
          const col = parseInt(sgrMouseMatch[2]!, 10);
          const row = parseInt(sgrMouseMatch[3]!, 10);
          const isRelease = sgrMouseMatch[4] === "m";
          const isMotion = (btn & 32) !== 0;
          const isDrag = isMotion && (btn & 3) !== 3;

          i += raw.length;

          // SGR 滚轮按钮：64 (Wheel Up), 65 (Wheel Down)
          const isWheel = btn >= 64 && btn <= 79;
          if (isWheel && (btn & 1) === 0) {
            events.push({
              type: "mouse-wheel-up",
              raw,
              mouse: { button: btn, col, row, isWheelUp: true },
            });
          } else if (isWheel && (btn & 1) === 1) {
            events.push({
              type: "mouse-wheel-down",
              raw,
              mouse: { button: btn, col, row, isWheelDown: true },
            });
          } else {
            events.push({
              type: "mouse-button",
              raw,
              mouse: { button: btn, col, row, isRelease, isMotion, isDrag },
            });
          }
          continue;
        }

        // 12.1.1 破损或分包中的 SGR 鼠标报告 (\x1b[< 开头)
        if (remaining.startsWith("\x1b[<")) {
          const partialMatch = remaining.match(/^\x1b\[<[\d;]*[A-Za-z]?/);
          if (partialMatch) {
            if (allowIncomplete && !/[A-Za-z]$/.test(partialMatch[0])) {
              return { events, unparsedRemaining: remaining };
            }
            events.push({ type: "unknown-sequence", raw: partialMatch[0] });
            i += partialMatch[0].length;
            continue;
          }
        }

        // 12.2 X10 传统鼠标报告: \x1b[M cb cx cy (6 字节)
        if (remaining.startsWith("\x1b[M")) {
          if (remaining.length >= 6) {
            const raw = remaining.substring(0, 6);
            const cb = raw.charCodeAt(3) - 32;
            const cx = raw.charCodeAt(4) - 32;
            const cy = raw.charCodeAt(5) - 32;
            i += 6;

            if (cb === 64) {
              events.push({
                type: "mouse-wheel-up",
                raw,
                mouse: { button: cb, col: cx, row: cy, isWheelUp: true },
              });
            } else if (cb === 65) {
              events.push({
                type: "mouse-wheel-down",
                raw,
                mouse: { button: cb, col: cx, row: cy, isWheelDown: true },
              });
            } else {
              events.push({
                type: "mouse-button",
                raw,
                mouse: { button: cb, col: cx, row: cy },
              });
            }
            continue;
          } else if (allowIncomplete) {
            return { events, unparsedRemaining: remaining };
          }
        }

        // 12.3 Alt+快捷键 (Alt+b / Alt+f 等)
        if (
          remaining.startsWith("\x1bb") ||
          remaining.startsWith("\x1bB") ||
          remaining.startsWith("\x1bf") ||
          remaining.startsWith("\x1bF")
        ) {
          events.push({ type: "unknown-sequence", raw: remaining.substring(0, 2) });
          i += 2;
          continue;
        }

        // 12.4 标准完整 CSI 序列 (以 \x1b[ 开头) 或 SS3 序列 (以 \x1bO 开头)
        // 符合 ECMA-48 标准: CSI [参数字节 0x30-0x3F]* [中间字节 0x20-0x2F]* [终结字节 0x40-0x7E]
        const csiMatch = remaining.match(
          /^\x1b(\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O[\x40-\x7e])/
        );

        if (csiMatch) {
          const seq = csiMatch[0];
          i += seq.length;

          if (seq === "\x1b[A" || seq === "\x1bOA") {
            events.push({ type: "arrow-up", raw: seq });
          } else if (seq === "\x1b[B" || seq === "\x1bOB") {
            events.push({ type: "arrow-down", raw: seq });
          } else if (seq === "\x1b[1;5A" || seq === "\x1b[5A") {
            events.push({ type: "ctrl-arrow-up", raw: seq });
          } else if (seq === "\x1b[1;5B" || seq === "\x1b[5B") {
            events.push({ type: "ctrl-arrow-down", raw: seq });
          } else if (seq === "\x1b[D" || seq === "\x1bOD") {
            events.push({ type: "arrow-left", raw: seq });
          } else if (seq === "\x1b[C" || seq === "\x1bOC") {
            events.push({ type: "arrow-right", raw: seq });
          } else if (seq === "\x1b[5~") {
            events.push({ type: "page-up", raw: seq });
          } else if (seq === "\x1b[6~") {
            events.push({ type: "page-down", raw: seq });
          } else if (seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1bOH") {
            events.push({ type: "home", raw: seq });
          } else if (seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1bOF") {
            events.push({ type: "end", raw: seq });
          } else if (seq === "\x1b[3~") {
            events.push({ type: "delete", raw: seq });
          } else {
            // 未知 CSI 序列安全吞掉，绝对不当做 Escape
            events.push({ type: "unknown-sequence", raw: seq });
          }
          continue;
        }

        // 12.5 检查是否属于未接收完整的转义序列前缀 (Fragmented Escape Prefix)
        // 仅当以 \x1b[ 或 \x1bO 或 \x1b] 开头时属于 CSI/SS3/OSC 前缀
        if (remaining.startsWith("\x1b[") || remaining.startsWith("\x1bO") || remaining.startsWith("\x1b]")) {
          if (allowIncomplete) {
            return { events, unparsedRemaining: remaining };
          }
          // allowIncomplete === false 且无法匹配完整 CSI: 吞掉破损 CSI，绝不当做 Escape
          let brokenLen = 2;
          while (brokenLen < remaining.length && !/[\x40-\x7e\n\r]/.test(remaining[brokenLen]!)) {
            brokenLen++;
          }
          if (brokenLen < remaining.length && /[\x40-\x7e]/.test(remaining[brokenLen]!)) {
            brokenLen++;
          }
          const brokenSeq = remaining.substring(0, brokenLen);
          events.push({ type: "unknown-sequence", raw: brokenSeq });
          i += brokenSeq.length;
          continue;
        }

        // 12.6 单独的一个 \x1b 字符
        if (remaining.length === 1) {
          if (allowIncomplete) {
            return { events, unparsedRemaining: "\x1b" };
          }
          events.push({ type: "escape", raw: "\x1b" });
          i++;
          continue;
        }

        // 12.7 \x1b 后跟随普通字符（例如 \x1b 后面跟 y，但并非控制序列）
        // 判定前面的 \x1b 为独立 Escape，剩余字符留给后续迭代继续解析
        events.push({ type: "escape", raw: "\x1b" });
        i++;
        continue;
      }

      // 12.8 孤立/脱节的 SGR 鼠标报告 ([?<Btn;Col;RowM 或 <Btn;Col;Rowm，由于前缀 \x1b 丢失或分片解包导致的残余)
      if ((char === "<" || char === "[") && /^\[?<\d+;/.test(text.substring(i))) {
        const remaining = text.substring(i);
        const orphanedMatch = remaining.match(/^\[?<(\d+);(\d+);(\d+)([Mm])/);
        if (orphanedMatch) {
          const raw = orphanedMatch[0];
          const btn = parseInt(orphanedMatch[1]!, 10);
          const col = parseInt(orphanedMatch[2]!, 10);
          const row = parseInt(orphanedMatch[3]!, 10);
          const isRelease = orphanedMatch[4] === "m";
          const isMotion = (btn & 32) !== 0;
          const isDrag = isMotion && (btn & 3) !== 3;

          i += raw.length;

          // SGR 滚轮按钮：64 (Wheel Up), 65 (Wheel Down)
          const isWheel = btn >= 64 && btn <= 79;
          if (isWheel && (btn & 1) === 0) {
            events.push({
              type: "mouse-wheel-up",
              raw,
              mouse: { button: btn, col, row, isWheelUp: true },
            });
          } else if (isWheel && (btn & 1) === 1) {
            events.push({
              type: "mouse-wheel-down",
              raw,
              mouse: { button: btn, col, row, isWheelDown: true },
            });
          } else {
            events.push({
              type: "mouse-button",
              raw,
              mouse: { button: btn, col, row, isRelease, isMotion, isDrag },
            });
          }
          continue;
        }

        // 检查是否为尚未接收完整的孤立 SGR 前缀 (< 开头紧跟数字与分号，如 <65;10;)
        const partialMatch = remaining.match(/^\[?<\d+;[\d;]*[A-Za-z]?/);
        if (partialMatch) {
          const partial = partialMatch[0];
          if (allowIncomplete && !/[A-Za-z]$/.test(partial)) {
            return { events, unparsedRemaining: remaining };
          }
          events.push({ type: "unknown-sequence", raw: partial });
          i += partial.length;
          continue;
        }
      }

      // 13. 普通文本/字符 (连续的可打印字符与 UTF-8 / CJK / ZWJ Emoji 序列)
      let endTextIdx = i;
      while (
        endTextIdx < text.length &&
        text[endTextIdx] !== "\x03" &&
        text[endTextIdx] !== "\x0e" &&
        text[endTextIdx] !== "\x10" &&
        text[endTextIdx] !== "\x04" &&
        text[endTextIdx] !== "\x11" &&
        text[endTextIdx] !== "\x14" &&
        text[endTextIdx] !== "\x18" &&
        text[endTextIdx] !== "\t" &&
        text[endTextIdx] !== "\x01" &&
        text[endTextIdx] !== "\x05" &&
        text[endTextIdx] !== "\x15" &&
        text[endTextIdx] !== "\x0b" &&
        text[endTextIdx] !== "\x17" &&
        text[endTextIdx] !== "\r" &&
        text[endTextIdx] !== "\n" &&
        text[endTextIdx] !== "\x7f" &&
        text[endTextIdx] !== "\x08" &&
        text[endTextIdx] !== "\x1b" &&
        !(text[endTextIdx] === "<" && /^<\d+;/.test(text.substring(endTextIdx)))
      ) {
        endTextIdx++;
      }

      const segmentStr = text.substring(i, endTextIdx);
      events.push({
        type: "printable",
        raw: segmentStr,
        char: segmentStr,
      });
      i = endTextIdx;
    }

    return { events, unparsedRemaining: "" };
  }
}
