import type { MemoryEntry, MemoryKind, MemoryScope } from "./types.js";

const KIND_HEADERS: Record<MemoryKind, string> = {
  architecture: "Architecture & System Design",
  environment: "Environment & Tooling",
  preference: "User Preferences & Workflow Habits",
  fact: "Verified Project Facts",
  decision: "Key Technical Decisions",
  lesson: "Verified Lessons & Historical Constraints",
};

/**
 * 将 Memory 条目列表渲染为用户友好、清晰可读的 MEMORY.md 内容
 */
export function renderMemoryMarkdown(
  entries: MemoryEntry[],
  title: string = "Nash Project Memory"
): string {
  const activeEntries = entries.filter((e) => !e.deprecated);

  if (activeEntries.length === 0) {
    return `# ${title}\n\nNo active memory records yet.\n`;
  }

  // 按分类分组
  const grouped = new Map<MemoryKind, MemoryEntry[]>();
  for (const entry of activeEntries) {
    const list = grouped.get(entry.kind) ?? [];
    list.push(entry);
    grouped.set(entry.kind, list);
  }

  const sections: string[] = [`# ${title}\n`];

  const order: MemoryKind[] = [
    "architecture",
    "environment",
    "preference",
    "fact",
    "decision",
    "lesson",
  ];

  for (const kind of order) {
    const items = grouped.get(kind);
    if (!items || items.length === 0) continue;

    const header = KIND_HEADERS[kind];
    sections.push(`## ${header}\n`);
    for (const item of items) {
      const sourceTag = item.source === "user-explicit" ? " *(user-explicit)*" : "";
      sections.push(`- ${item.content}${sourceTag}`);
    }
    sections.push("");
  }

  return sections.join("\n").trim() + "\n";
}

/**
 * 针对指定分类渲染特定子 Markdown 文件 (例如 architecture.md)
 */
export function renderCategoryMarkdown(
  kind: MemoryKind,
  entries: MemoryEntry[],
  title?: string
): string {
  const active = entries.filter((e) => !e.deprecated && e.kind === kind);
  const header = title ?? KIND_HEADERS[kind];

  if (active.length === 0) {
    return `# ${header}\n\nNo records.\n`;
  }

  const lines = [`# ${header}\n`];
  for (const item of active) {
    lines.push(`- ${item.content}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * 将散落的 Markdown 文本 (如 ~/.nash/memory.md 或手写 MEMORY.md) 逆向解析为结构化 Memory 条目
 */
export function parseMarkdownToEntries(
  markdown: string,
  options?: { scope?: MemoryScope; defaultKind?: MemoryKind }
): MemoryEntry[] {
  if (!markdown || !markdown.trim()) return [];

  const lines = markdown.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  let currentHeader = "";
  let currentKind: MemoryKind = options?.defaultKind ?? "preference";
  const now = new Date().toISOString();

  function inferKindFromHeader(h: string): MemoryKind {
    const low = h.toLowerCase();
    if (low.includes("偏好") || low.includes("人设") || low.includes("称谓") || low.includes("习惯") || low.includes("preference")) {
      return "preference";
    }
    if (low.includes("架构") || low.includes("设计") || low.includes("architecture")) {
      return "architecture";
    }
    if (low.includes("环境") || low.includes("工具") || low.includes("environment")) {
      return "environment";
    }
    if (low.includes("教训") || low.includes("踩坑") || low.includes("lesson")) {
      return "lesson";
    }
    if (low.includes("决策") || low.includes("decision")) {
      return "decision";
    }
    return "preference";
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      currentHeader = trimmed.replace(/^#+\s*/, "").trim();
      currentKind = inferKindFromHeader(currentHeader);
      continue;
    }

    // 匹配列表项 '- xxx' 或 '* xxx'
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const content = trimmed.substring(2).trim();
      if (content.length >= 2) {
        const id = `mem-ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        entries.push({
          id,
          content,
          kind: currentKind,
          scope: options?.scope ?? "global",
          source: "user-explicit",
          confidence: 1.0,
          reinforcementCount: 1,
          createdAt: now,
          updatedAt: now,
          tags: ["imported-markdown", currentKind],
        });
      }
    }
  }

  return entries;
}

/**
 * 渲染 Tier 1A: 核心偏好与人设 (Invariants & Preferences) 提示词
 */
export function renderPreferencesPrompt(entries: MemoryEntry[]): string {
  const preferences = entries.filter(
    (e) => !e.deprecated && (e.kind === "preference" || e.tags?.includes("persona") || e.tags?.includes("invariant"))
  );

  if (preferences.length === 0) return "";

  const lines = [
    "# User Persona & Core Preferences (Permanent Invariants)",
    "Always adhere strictly to the following user preferences, styling guidelines, and persona constraints across all interactions:",
  ];

  for (const p of preferences) {
    const scopeTag = p.scope === "project" ? " [project]" : " [global]";
    lines.push(`- ${p.content}${scopeTag}`);
  }

  return lines.join("\n");
}

/**
 * 渲染 Tier 1B: 渐进式记忆索引 (Progressive Memory Index) 提示词
 */
export function renderMemoryIndexPrompt(entries: MemoryEntry[], maxEntries: number = 20): string {
  const active = entries.filter((e) => !e.deprecated);
  if (active.length === 0) return "";

  const lines = [
    "# Persistent Memory Index (Tier 1 Overview)",
    "The following persistent memories are indexed. Use the 'search_memory' tool to retrieve full context if needed:",
  ];

  const sliced = active.slice(0, maxEntries);
  for (const item of sliced) {
    const scopeTag = item.scope === "project" ? "project" : "global";
    lines.push(`- [${item.kind}|${scopeTag}] ${item.content}`);
  }

  if (active.length > maxEntries) {
    lines.push(`- ... and ${active.length - maxEntries} more memories in index.`);
  }

  return lines.join("\n");
}

