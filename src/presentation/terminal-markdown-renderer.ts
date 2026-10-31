import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { truncateToDisplayWidth } from "./terminal-renderer.js";

export interface MarkdownRenderOptions {
  maxWidth?: number;
  indent?: string;
}

/**
 * TerminalMarkdownRenderer
 *
 * 统一负责将 Markdown 源码转译为带 ANSI 终端样式的富文本行序列，并根据视口宽度进行 CJK/ANSI-aware wrapping。
 *
 * 核心设计准则：
 * 1. 语义隔离：只渲染 Assistant 自然语言与 Plan/Report 文档内容，不介入 Tool stdout 与状态事件；
 * 2. 视觉层级：支持 Heading (#, ##, ###), Bold (** / __), Italic (* / _), Inline Code (`...`),
 *    Fenced Code Block (```...```), Blockquote (> ...), List (- / * / 1.), Horizontal Rule (---);
 * 3. 宽度自适应：基于 string-width / strip-ansi 精确计算中英文字符与 Emoji 视觉列宽，绝不断裂 ANSI 控制序列；
 * 4. Code Block 隔离：代码块内部内容按原文保留，代码块内部字符不被二次解析为 Markdown。
 */
export class TerminalMarkdownRenderer {
  /**
   * 将 Markdown 文本渲染为 ANSI 格式化终端行数组
   */
  static render(markdown: string, options?: MarkdownRenderOptions): string[] {
    if (!markdown || typeof markdown !== "string") {
      return [];
    }

    const maxWidth = Math.max(20, options?.maxWidth ?? 80);
    const baseIndent = options?.indent ?? "";
    const rawLines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

    const resultLines: string[] = [];
    let inCodeBlock = false;
    let codeBlockLang = "";
    let codeBlockLines: string[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;

      // 1. Fenced Code Block (```lang ... ```)
      const codeFenceMatch = line.match(/^```(\w*)/);
      if (codeFenceMatch) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = codeFenceMatch[1] || "";
          codeBlockLines = [];
        } else {
          inCodeBlock = false;
          // 渲染完成的代码块
          const headerTitle = codeBlockLang ? ` [${codeBlockLang}] ` : " ";
          const maxBorderLen = Math.max(10, maxWidth - 4 - baseIndent.length);
          const topBorder = `\x1b[90m┌──${headerTitle}${"─".repeat(Math.max(2, maxBorderLen - headerTitle.length - 2))}\x1b[0m`;
          const bottomBorder = `\x1b[90m└──${"─".repeat(Math.max(2, maxBorderLen - 2))}\x1b[0m`;

          resultLines.push(`${baseIndent}${topBorder}`);
          for (const codeLine of codeBlockLines) {
            // 代码块内容完全按原文保留，不进行 Markdown 转译
            resultLines.push(`${baseIndent}  \x1b[37m${codeLine}\x1b[0m`);
          }
          resultLines.push(`${baseIndent}${bottomBorder}`);
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockLines.push(line);
        continue;
      }

      // 2. 空行
      if (line.trim().length === 0) {
        resultLines.push("");
        continue;
      }

      // 3. Horizontal Rule (---, ***, ___)
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
        const ruleLen = Math.max(10, maxWidth - baseIndent.length - 2);
        resultLines.push(`${baseIndent}\x1b[90m${"─".repeat(ruleLen)}\x1b[0m`);
        continue;
      }

      // 3.5. Markdown Table (| Header | ... |)
      if (
        i + 1 < rawLines.length &&
        TerminalMarkdownRenderer.looksLikeTableRow(line) &&
        TerminalMarkdownRenderer.isTableDelimiterRow(rawLines[i + 1]!)
      ) {
        const rawHeader = line;
        const rawDelimiters = rawLines[i + 1]!;
        const rawRows: string[] = [];
        let j = i + 2;
        while (
          j < rawLines.length &&
          rawLines[j]!.trim().length > 0 &&
          TerminalMarkdownRenderer.looksLikeTableRow(rawLines[j]!)
        ) {
          rawRows.push(rawLines[j]!);
          j++;
        }
        const tableLines = TerminalMarkdownRenderer.renderTable(
          rawHeader,
          rawDelimiters,
          rawRows,
          maxWidth,
          baseIndent
        );
        resultLines.push(...tableLines);
        i = j - 1;
        continue;
      }

      // 4. Headings (#, ##, ###, ####+)
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const headingText = headingMatch[2]!.trim();
        const styledTitle = this.parseInlineMarkdown(headingText);
        const titleWidth = stringWidth(stripAnsi(styledTitle));
        const ruleLen = Math.max(10, Math.min(maxWidth - baseIndent.length - 2, Math.max(titleWidth, 24)));

        if (level === 1) {
          resultLines.push(`${baseIndent}\x1b[1m\x1b[36m${styledTitle}\x1b[0m`);
          resultLines.push(`${baseIndent}\x1b[90m${"═".repeat(ruleLen)}\x1b[0m`);
        } else if (level === 2) {
          resultLines.push(`${baseIndent}\x1b[1m\x1b[36m${styledTitle}\x1b[0m`);
          resultLines.push(`${baseIndent}\x1b[90m${"─".repeat(ruleLen)}\x1b[0m`);
        } else if (level === 3) {
          resultLines.push(`${baseIndent}\x1b[1m\x1b[37m${styledTitle}\x1b[0m`);
          resultLines.push(`${baseIndent}\x1b[90m${"─".repeat(Math.max(8, ruleLen))}\x1b[0m`);
        } else {
          resultLines.push(`${baseIndent}\x1b[1m\x1b[90m${styledTitle}\x1b[0m`);
        }
        continue;
      }

      // 5. Blockquote (> text)
      const blockquoteMatch = line.match(/^>\s?(.*)$/);
      if (blockquoteMatch) {
        const quoteContent = blockquoteMatch[1] ?? "";
        const styledContent = this.parseInlineMarkdown(quoteContent);
        const quotePrefix = `${baseIndent}  \x1b[90m│\x1b[0m `;
        const wrappedQuoteLines = this.wrapStyledText(
          styledContent,
          maxWidth - baseIndent.length - 4,
          quotePrefix,
          quotePrefix
        );
        resultLines.push(...wrappedQuoteLines);
        continue;
      }

      // 6. Unordered List items (- item, * item, + item)
      const unorderedMatch = line.match(/^(\s*)([-*+])\s+(.*)$/);
      if (unorderedMatch) {
        const leadingSpaces = unorderedMatch[1]!.length;
        const nestLevel = Math.floor(leadingSpaces / 2);
        const itemContent = unorderedMatch[3]!;
        const styledContent = this.parseInlineMarkdown(itemContent);
        const prefix = `${baseIndent}${"  ".repeat(nestLevel)}• `;
        const contIndent = `${baseIndent}${"  ".repeat(nestLevel)}  `;

        const wrappedListLines = this.wrapStyledText(
          styledContent,
          maxWidth - prefix.length,
          contIndent,
          prefix
        );
        resultLines.push(...wrappedListLines);
        continue;
      }

      // 7. Ordered List items (1. item, 2. item)
      const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (orderedMatch) {
        const leadingSpaces = orderedMatch[1]!.length;
        const nestLevel = Math.floor(leadingSpaces / 2);
        const num = orderedMatch[2]!;
        const itemContent = orderedMatch[3]!;
        const styledContent = this.parseInlineMarkdown(itemContent);
        const prefix = `${baseIndent}${"  ".repeat(nestLevel)}${num}. `;
        const contIndent = `${baseIndent}${"  ".repeat(nestLevel)}${" ".repeat(num.length + 2)}`;

        const wrappedListLines = this.wrapStyledText(
          styledContent,
          maxWidth - prefix.length,
          contIndent,
          prefix
        );
        resultLines.push(...wrappedListLines);
        continue;
      }

      // 8. 普通段落行 (Paragraph Text)
      const styledParagraph = this.parseInlineMarkdown(line);
      const wrappedParagraphLines = this.wrapStyledText(
        styledParagraph,
        maxWidth - baseIndent.length,
        baseIndent,
        baseIndent
      );
      resultLines.push(...wrappedParagraphLines);
    }

    // 若代码块未闭合，安全收尾
    if (inCodeBlock) {
      for (const codeLine of codeBlockLines) {
        resultLines.push(`${baseIndent}  \x1b[37m${codeLine}\x1b[0m`);
      }
      resultLines.push(`${baseIndent}\x1b[90m└──────────────────────────────\x1b[0m`);
    }

    return resultLines;
  }

  /**
   * 解析行内 Markdown 语法元素 (Bold, Italic, Inline Code, Links, Strikethrough)
   */
  static parseInlineMarkdown(text: string): string {
    if (!text) return "";

    // 1. 保护行内代码块 (`` `code` ``)，使用不可见控制字符作为绝对安全的占位符
    const codeTokens: string[] = [];
    let processed = text.replace(/`([^`]+)`/g, (_match, code) => {
      const token = `\x00CODE${codeTokens.length}\x00`;
      codeTokens.push(`\x1b[36m${code}\x1b[39m`);
      return token;
    });

    // 2. 链接解析 [link text](url)
    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
      if (linkText === url) {
        return `\x1b[4m\x1b[34m${url}\x1b[0m`;
      }
      return `${linkText} (\x1b[90m${url}\x1b[0m)`;
    });

    // 3. 粗体 + 斜体 (***text*** 或 ___text___)
    processed = processed.replace(/(\*\*\*|___)(.+?)\1/g, "\x1b[1;3m$2\x1b[0m");

    // 4. 粗体 (**text** 或 __text__)
    processed = processed.replace(/(\*\*|__)(.+?)\1/g, "\x1b[1m$2\x1b[22m");

    // 5. 斜体 (*text* 或 _text_)，使用词边界保护防止破坏 snake_case 变量名
    processed = processed.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, "\x1b[3m$1\x1b[23m");
    processed = processed.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, "\x1b[3m$1\x1b[23m");

    // 6. 删除线 (~~text~~)
    processed = processed.replace(/~~(.+?)~~/g, "\x1b[9m$1\x1b[29m");

    // 7. 还原行内代码块
    processed = processed.replace(/\x00CODE(\d+)\x00/g, (_match, idxStr) => {
      const idx = parseInt(idxStr, 10);
      return codeTokens[idx] ?? "";
    });

    return processed;
  }

  /**
   * 针对包含 ANSI 样式序列、英文单词与 CJK 字符的单行进行自适应精准 Soft Wrap
   */
  static wrapStyledText(
    text: string,
    maxWidth: number,
    continuationIndent = "",
    firstLinePrefix = ""
  ): string[] {
    const targetWidth = Math.max(1, maxWidth);
    const visibleLen = stringWidth(stripAnsi(text));
    const prefixWidth = stringWidth(stripAnsi(firstLinePrefix));

    if (visibleLen + prefixWidth <= targetWidth) {
      return [`${firstLinePrefix}${text}`];
    }

    const lines: string[] = [];
    let currentLine = firstLinePrefix;
    let currentVisibleWidth = prefixWidth;
    const baseContinuationWidth = stringWidth(stripAnsi(continuationIndent));

    // 分词为 ANSI 控制序列与文本 Token
    const tokens = this.tokenizeAnsi(text);
    let activeAnsiStyles = "";

    // CJK 字符正则 (包含常用汉字、日韩文字、全角标点与 Emoji)
    const isCJKOrEmoji = (ch: string) => {
      const code = ch.codePointAt(0) ?? 0;
      return (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x20000 && code <= 0x2a6df) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef) ||
        (code >= 0x1f300 && code <= 0x1faff) ||
        (code >= 0x2600 && code <= 0x27bf) ||
        stringWidth(ch) > 1
      );
    };

    const flushLine = () => {
      if (activeAnsiStyles) {
        lines.push(`${currentLine}\x1b[0m`);
      } else {
        lines.push(currentLine);
      }
      currentLine = `${continuationIndent}${activeAnsiStyles}`;
      currentVisibleWidth = baseContinuationWidth;
    };

    for (const token of tokens) {
      if (token.isAnsi) {
        currentLine += token.raw;
        if (token.raw === "\x1b[0m" || token.raw === "\x1b[m") {
          activeAnsiStyles = "";
        } else {
          activeAnsiStyles += token.raw;
        }
        continue;
      }

      // 将文本细分为 Word / Space / CJK 最小排版原子 (Atoms)
      const rawText = token.raw;
      let idx = 0;

      while (idx < rawText.length) {
        const char = rawText[idx]!;

        // 1. 空格连续段
        if (char === " " || char === "\t") {
          let spaceEnd = idx;
          while (spaceEnd < rawText.length && (rawText[spaceEnd] === " " || rawText[spaceEnd] === "\t")) {
            spaceEnd++;
          }
          const spaces = rawText.substring(idx, spaceEnd);
          const spaceWidth = stringWidth(spaces);

          if (currentVisibleWidth + spaceWidth <= targetWidth) {
            currentLine += spaces;
            currentVisibleWidth += spaceWidth;
          } else if (currentVisibleWidth > baseContinuationWidth) {
            // 行尾多余空格在换行时自然消耗
            flushLine();
          }
          idx = spaceEnd;
          continue;
        }

        // 2. CJK 字符 / Emoji 单字推进
        if (isCJKOrEmoji(char)) {
          // 处理 UTF-16 surrogate pairs
          let cjkChar = char;
          const code = char.charCodeAt(0);
          if (code >= 0xd800 && code <= 0xdbff && idx + 1 < rawText.length) {
            cjkChar = rawText.substring(idx, idx + 2);
            idx += 2;
          } else {
            idx++;
          }

          const cjkWidth = stringWidth(cjkChar);
          if (currentVisibleWidth + cjkWidth > targetWidth && currentVisibleWidth > baseContinuationWidth) {
            flushLine();
          }
          currentLine += cjkChar;
          currentVisibleWidth += cjkWidth;
          continue;
        }

        // 3. 连续的英文/数字/ASCII 单词 (Word Chunk)
        let wordEnd = idx;
        while (
          wordEnd < rawText.length &&
          rawText[wordEnd] !== " " &&
          rawText[wordEnd] !== "\t" &&
          !isCJKOrEmoji(rawText[wordEnd]!)
        ) {
          wordEnd++;
        }

        const word = rawText.substring(idx, wordEnd);
        const wordWidth = stringWidth(word);

        if (currentVisibleWidth + wordWidth <= targetWidth) {
          // 当前行有充足空间，完整放入该词
          currentLine += word;
          currentVisibleWidth += wordWidth;
        } else if (currentVisibleWidth > baseContinuationWidth) {
          // 当前行空间不足且已有内容，在词边界换行
          flushLine();
          if (currentVisibleWidth + wordWidth <= targetWidth) {
            currentLine += word;
            currentVisibleWidth += wordWidth;
          } else {
            // 超长单词超过整行宽度，逐字符强制断开
            for (const ch of word) {
              const chWidth = stringWidth(ch);
              if (currentVisibleWidth + chWidth > targetWidth && currentVisibleWidth > baseContinuationWidth) {
                flushLine();
              }
              currentLine += ch;
              currentVisibleWidth += chWidth;
            }
          }
        } else {
          // 当前行为空行（只有缩进）且单词超宽，逐字符强制断开
          for (const ch of word) {
            const chWidth = stringWidth(ch);
            if (currentVisibleWidth + chWidth > targetWidth && currentVisibleWidth > baseContinuationWidth) {
              flushLine();
            }
            currentLine += ch;
            currentVisibleWidth += chWidth;
          }
        }

        idx = wordEnd;
      }
    }

    if (currentLine.length > baseContinuationWidth || (lines.length === 0 && currentLine.length > 0)) {
      lines.push(currentLine);
    }

    return lines;
  }

  /**
   * 将字符串分解为 ANSI 控制序列与普通文本 Token 数组
   */
  private static tokenizeAnsi(text: string): Array<{ isAnsi: boolean; raw: string }> {
    const tokens: Array<{ isAnsi: boolean; raw: string }> = [];
    const regex = /\x1b\[[0-9;]*[a-zA-Z]/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({
          isAnsi: false,
          raw: text.substring(lastIndex, match.index),
        });
      }
      tokens.push({
        isAnsi: true,
        raw: match[0],
      });
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      tokens.push({
        isAnsi: false,
        raw: text.substring(lastIndex),
      });
    }

    return tokens;
  }

  /**
   * 判定某行是否为合法的 Markdown 表格分隔对齐行 (如 | :--- | :---: | ---: |)
   */
  static isTableDelimiterRow(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.includes("-") || !trimmed.includes("|")) return false;
    const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
    const parts = inner.split("|");
    if (parts.length === 0) return false;
    return parts.every((part) => /^[\s]*:?-{1,}:?[\s]*$/.test(part));
  }

  /**
   * 判定某行是否形如 Markdown 表格行
   */
  static looksLikeTableRow(line: string): boolean {
    const trimmed = line.trim();
    return (
      trimmed.includes("|") &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("```") &&
      !trimmed.startsWith(">")
    );
  }

  /**
   * 将 Markdown 表格行按 | 切分为 Cell 单元格数组，支持转义 \| 与反引号 `code` 内管道符保护
   */
  static splitTableRow(row: string): string[] {
    let trimmed = row.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);

    const cells: string[] = [];
    let current = "";
    let inCode = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i]!;
      if (char === "\\") {
        if (i + 1 < trimmed.length && trimmed[i + 1] === "|") {
          current += "|";
          i++;
          continue;
        }
        current += "\\";
        continue;
      }
      if (char === "`") {
        inCode = !inCode;
        current += "`";
        continue;
      }
      if (char === "|" && !inCode) {
        cells.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    cells.push(current.trim());
    return cells;
  }

  /**
   * 将 Markdown 表格渲染为整齐优美、带 Unicode 边框与自适应换行的终端 ANSI 表格
   */
  static renderTable(
    rawHeader: string,
    rawDelimiters: string,
    rawRows: string[],
    maxWidth: number,
    baseIndent = ""
  ): string[] {
    const headerCells = this.splitTableRow(rawHeader);
    const delimiterCells = this.splitTableRow(rawDelimiters);
    const colCount = Math.max(headerCells.length, delimiterCells.length);
    if (colCount === 0) return [];

    while (headerCells.length < colCount) headerCells.push("");

    const alignments: Array<"left" | "center" | "right"> = delimiterCells.map((d) => {
      const trimmed = d.trim();
      const leftColon = trimmed.startsWith(":");
      const rightColon = trimmed.endsWith(":");
      if (leftColon && rightColon) return "center";
      if (rightColon) return "right";
      return "left";
    });
    while (alignments.length < colCount) alignments.push("left");

    const rows = rawRows.map((r) => {
      const cells = this.splitTableRow(r);
      while (cells.length < colCount) cells.push("");
      return cells.slice(0, colCount);
    });

    // 1. 处理每个 Cell：替换 <br> 为换行，行内 Markdown 转译为 ANSI
    const processCell = (rawCell: string): string[] => {
      const normalized = rawCell.replace(/<br\s*\/?>/gi, "\n");
      const lines = normalized
        .split("\n")
        .map((l) => l.trim())
        .filter((l, idx, arr) => l.length > 0 || arr.length === 1);
      return lines.map((l) => this.parseInlineMarkdown(l));
    };

    const processedHeader = headerCells.map(processCell);
    const processedRows = rows.map((r) => r.map(processCell));

    // 2. 计算各列自然宽度 (Natural Width)
    const naturalWidths = new Array<number>(colCount).fill(0);
    for (let c = 0; c < colCount; c++) {
      let maxLen = 0;
      for (const line of processedHeader[c]!) {
        maxLen = Math.max(maxLen, stringWidth(stripAnsi(line)));
      }
      for (const row of processedRows) {
        for (const line of row[c]!) {
          maxLen = Math.max(maxLen, stringWidth(stripAnsi(line)));
        }
      }
      naturalWidths[c] = Math.max(4, maxLen);
    }

    // 3. 根据终端视口 maxWidth 计算列宽
    // 边框字符与 Padding 开销: "│ " + (colCount - 1) * " │ " + " │" = 3 * colCount + 1
    const borderOverhead = 3 * colCount + 1;
    // 预留 1 列安全容错边距，杜绝任何宽字符/ANSI 溢出破坏终端右边框
    const maxUsableBudget = Math.max(colCount * 2, maxWidth - baseIndent.length - borderOverhead - 1);
    const availableContentWidth = maxUsableBudget;
    const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);

    let colWidths = [...naturalWidths];
    if (totalNatural > availableContentWidth) {
      // 视口空间不足，按自然宽度比例收缩各列，并保障每列最小宽度 >= 2 (极端狭窄视口)
      const minCol = Math.max(2, Math.floor(availableContentWidth / colCount));
      colWidths = naturalWidths.map((nw) =>
        Math.max(minCol, Math.floor(nw * (availableContentWidth / totalNatural)))
      );
      let allocated = colWidths.reduce((a, b) => a + b, 0);
      let diff = availableContentWidth - allocated;
      while (diff > 0) {
        for (let c = 0; diff > 0 && c < colCount; c++) {
          colWidths[c]++;
          diff--;
        }
      }
      while (diff < 0) {
        for (let c = colCount - 1; diff < 0 && c >= 0; c--) {
          if (colWidths[c]! > 2) {
            colWidths[c]--;
            diff++;
          }
        }
      }
    }

    // 4. 将各 Cell 内容按所在列宽进行 Soft Wrap
    const formatCellLines = (lines: string[], width: number): string[] => {
      const out: string[] = [];
      for (const line of lines) {
        const wrapped = this.wrapStyledText(line, width);
        for (const wl of wrapped) {
          const trimmed = wl.trimEnd();
          if (stringWidth(stripAnsi(trimmed)) > width) {
            out.push(truncateToDisplayWidth(trimmed, width));
          } else {
            out.push(trimmed);
          }
        }
      }
      return out.length ? out : [""];
    };

    const wrappedHeader = processedHeader.map((lines, c) => formatCellLines(lines, colWidths[c]!));
    const wrappedRows = processedRows.map((row) =>
      row.map((lines, c) => formatCellLines(lines, colWidths[c]!))
    );

    // 5. 对齐填充辅助函数
    const padCell = (text: string, width: number, align: "left" | "center" | "right"): string => {
      const visLen = stringWidth(stripAnsi(text));
      // 若单元格文本因富文本或宽字符偶然超出列宽，进行安全截断防溢出
      const safeText = visLen > width ? truncateToDisplayWidth(text, width) : text;
      const safeVisLen = stringWidth(stripAnsi(safeText));
      const pad = Math.max(0, width - safeVisLen);
      if (align === "right") {
        return " ".repeat(pad) + safeText + "\x1b[0m";
      }
      if (align === "center") {
        const left = Math.floor(pad / 2);
        const right = pad - left;
        return " ".repeat(left) + safeText + "\x1b[0m" + " ".repeat(right);
      }
      return safeText + "\x1b[0m" + " ".repeat(pad);
    };

    // 6. 构造表格边框 (Unicode Box-Drawing Characters)
    const topBorder = `${baseIndent}\x1b[90m┌─${colWidths.map((w) => "─".repeat(w)).join("─┬─")}─┐\x1b[0m`;
    const headerSep = `${baseIndent}\x1b[90m├─${colWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤\x1b[0m`;
    const rowSep = `${baseIndent}\x1b[90m├─${colWidths.map((w) => "─".repeat(w)).join("─┼─")}─┤\x1b[0m`;
    const bottomBorder = `${baseIndent}\x1b[90m└─${colWidths.map((w) => "─".repeat(w)).join("─┴─")}─┘\x1b[0m`;

    const result: string[] = [topBorder];

    // 7. 渲染表头 (Header)
    const headerHeight = Math.max(...wrappedHeader.map((c) => c.length));
    for (let h = 0; h < headerHeight; h++) {
      const rowParts = wrappedHeader.map((colLines, c) => {
        const text = colLines[h] || "";
        const styled = text ? `\x1b[1m\x1b[36m${text}\x1b[0m` : "";
        return padCell(styled, colWidths[c]!, alignments[c]!);
      });
      result.push(`${baseIndent}\x1b[90m│\x1b[0m ${rowParts.join(" \x1b[90m│\x1b[0m ")} \x1b[90m│\x1b[0m`);
    }
    result.push(headerSep);

    // 8. 渲染数据行 (Body Rows)
    const hasAnyMultiLineRow = wrappedRows.some((row) => row.some((c) => c.length > 1));
    for (let r = 0; r < wrappedRows.length; r++) {
      const row = wrappedRows[r]!;
      const rHeight = Math.max(...row.map((c) => c.length));
      for (let h = 0; h < rHeight; h++) {
        const rowParts = row.map((colLines, c) => {
          const text = colLines[h] || "";
          return padCell(text, colWidths[c]!, alignments[c]!);
        });
        result.push(`${baseIndent}\x1b[90m│\x1b[0m ${rowParts.join(" \x1b[90m│\x1b[0m ")} \x1b[90m│\x1b[0m`);
      }
      // 如果数据行包含多行单元格，在各行之间绘制分隔线提升阅读可读性
      if (hasAnyMultiLineRow && r < wrappedRows.length - 1) {
        result.push(rowSep);
      }
    }
    result.push(bottomBorder);

    // 9. 最终全行物理视口硬边界闭合防御：保证每一行物理宽度不超过 maxWidth，彻底消除终端 Hard Auto-wrap 错位
    return result.map((line) => truncateToDisplayWidth(line, maxWidth));
  }
}
