import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

/** Scan once with bounded memory, including continuation within enormous lines. */
export async function readTextPage(file: string, offset: number, limit: number, maxChars: number, charOffset = 0): Promise<{ totalLines: number; lines: string[]; sha256: string; truncated: boolean; endLine: number; nextOffset: number; nextCharOffset: number }> {
  const hash = createHash("sha256"), decoder = new StringDecoder("utf8");
  let line = 1, position = 0, seen = false, endsWithNewline = false, used = 0;
  let continuation: { line: number; char: number } | undefined;
  let pendingCR = "";
  const selected = new Map<number, string>();
  const consume = (text: string, final = false) => {
    text = pendingCR + text; pendingCR = "";
    if (!final && text.endsWith("\r")) { pendingCR = "\r"; text = text.slice(0, -1); }
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const end = newline === -1 ? text.length : newline;
      const skip = line === offset ? Math.max(0, charOffset - position) : 0;
      if (!continuation && line >= offset && line < offset + limit && skip <= end - start) {
        const old = selected.get(line);
        const prefix = old === undefined ? `${line}: ` : "";
        const separator = old === undefined && selected.size > 0 ? 1 : 0;
        const rawFragment = text.slice(start + skip, end);
        const fragment = newline !== -1 && rawFragment.endsWith("\r") ? rawFragment.slice(0, -1) : rawFragment;
        const available = Math.max(0, maxChars - used - prefix.length - separator);
        const take = Math.min(fragment.length, available);
        if (used + prefix.length + separator <= maxChars) {
          selected.set(line, (old ?? prefix) + fragment.slice(0, take));
          used += prefix.length + separator + take;
        }
        if (take < fragment.length || !selected.has(line)) continuation = { line, char: position + skip + take };
        if (newline !== -1 && !continuation && selected.get(line)?.endsWith("\r")) {
          selected.set(line, selected.get(line)!.slice(0, -1)); used--;
        }
      }
      seen = true;
      endsWithNewline = newline !== -1;
      position += end - start;
      if (newline === -1) break;
      line++; position = 0;
      start = newline + 1;
    }
  };
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const buffer = chunk as Buffer;
    hash.update(buffer); consume(decoder.write(buffer));
  }
  consume(decoder.end(), true);
  const totalLines = seen ? line - (endsWithNewline ? 1 : 0) : 0;
  const entries = [...selected.entries()].filter(([n]) => n <= totalLines);
  const endLine = entries.at(-1)?.[0] ?? offset - 1;
  return { totalLines, lines: entries.map(([,v]) => v), sha256: hash.digest("hex"), truncated: !!continuation,
    endLine, nextOffset: continuation?.line ?? endLine + 1, nextCharOffset: continuation?.char ?? 0 };
}
