import DOMPurify from "dompurify";
import { marked } from "marked";

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function highlightCode(code: string): string {
  const tokens = /(?:\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|import|from|export|async|await|if|else|for|while|def|class|type|interface)\b|\b\d+(?:\.\d+)?\b)/g;
  let end = 0;
  let html = "";
  for (const match of code.matchAll(tokens)) {
    html += escapeHtml(code.slice(end, match.index));
    const token = match[0];
    const style = token.startsWith("//") || token.startsWith("#") ? "text-surface-500 italic"
      : /^["'`]/.test(token) ? "text-emerald-400" : /^\d/.test(token) ? "text-amber-400" : "text-nash-400 font-semibold";
    html += `<span class="${style}">${escapeHtml(token)}</span>`;
    end = match.index + token.length;
  }
  return html + escapeHtml(code.slice(end));
}

const renderer = new marked.Renderer();
renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
  const language = escapeHtml(lang || "text");
  const highlighted = highlightCode(text);
  return `<pre class="nash-code-block" data-lang="${language}"><div class="nash-code-header flex items-center justify-between text-[11px] text-surface-500 font-mono pb-1 border-b border-surface-800/80 mb-2 select-none"><span>${language}</span></div><code class="language-${language}">${highlighted}</code></pre>`;
};

export function renderMarkdown(content: string): string {
  const rawHtml = marked.parse(content, {
    gfm: true,
    breaks: true,
    async: false,
    renderer,
  }) as string;

  const html = DOMPurify.sanitize(rawHtml, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["class", "data-lang", "tabindex", "role", "aria-label"],
  });

  return html
    .replace(
      /<table(\s[^>]*)?>/g,
      '<div class="nash-table-scroll" role="region" aria-label="数据表格" tabindex="0"><table$1>'
    )
    .replace(/<\/table>/g, "</table></div>");
}
