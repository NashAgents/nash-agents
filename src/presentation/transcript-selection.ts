import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

export interface TextPosition {
  line: number;
  column: number;
}

export interface TextSelection {
  anchor: TextPosition;
  focus: TextPosition;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+|\x1b/g;

function ordered(selection: TextSelection): [TextPosition, TextPosition] {
  const { anchor, focus } = selection;
  return anchor.line < focus.line || (anchor.line === focus.line && anchor.column <= focus.column)
    ? [anchor, focus]
    : [focus, anchor];
}

function visibleSlice(text: string, start: number, end: number): string {
  let column = 0;
  let result = "";
  for (const { segment } of segmenter.segment(stripAnsi(text))) {
    const width = stringWidth(segment);
    if (column >= end) break;
    if (column + width > start && column < end) result += segment;
    column += width;
  }
  return result;
}

export function selectedText(lines: string[], selection: TextSelection): string {
  const [start, end] = ordered(selection);
  if (start.line === end.line && start.column === end.column) return "";
  const result: string[] = [];
  for (let line = start.line; line <= end.line && line < lines.length; line++) {
    const content = lines[line] ?? "";
    result.push(visibleSlice(content, line === start.line ? start.column : 0,
      line === end.line ? end.column : Number.POSITIVE_INFINITY));
  }
  return result.join("\n");
}

export function highlightSelectedLine(text: string, lineIndex: number, selection: TextSelection, width?: number): string {
  const [start, end] = ordered(selection);
  if (lineIndex < start.line || lineIndex > end.line) return text;
  const from = lineIndex === start.line ? start.column : 0;
  const to = lineIndex === end.line ? end.column : Number.POSITIVE_INFINITY;
  if (from >= to) return text;
  if (!stripAnsi(text) && width !== undefined) {
    text = " ".repeat(Math.max(0, Math.min(width, Number.isFinite(to) ? to : width)));
  }

  let column = 0;
  let result = "";
  let highlighted = false;
  for (const token of text.match(ansiPattern) ?? []) {
    if (token.startsWith("\x1b")) {
      result += token;
      if (highlighted && /^\x1b\[(?:0)?m$/.test(token)) result += "\x1b[7m";
      continue;
    }
    for (const { segment } of segmenter.segment(token)) {
      const width = stringWidth(segment);
      const selected = column + width > from && column < to && width > 0;
      if (selected !== highlighted) {
        result += selected ? "\x1b[7m" : "\x1b[27m";
        highlighted = selected;
      }
      result += segment;
      column += width;
    }
  }
  if (highlighted) result += "\x1b[27m";
  return result;
}
