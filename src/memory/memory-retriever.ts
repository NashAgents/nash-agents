import type {
  MemoryEntry,
  MemoryQuery,
  MemoryRetrievalResult,
  ScoredMemoryEntry,
} from "./types.js";

/**
 * 极简分词与关键词提取 (支持中英文混排、短横线与下划线拆分)
 */
function tokenize(text: string): string[] {
  if (!text) return [];
  const normalized = text.toLowerCase();
  // 提取英文单词/数字，以及连续的 CJK 字符序列
  const matches = normalized.match(/[\w\d\-_]+|[一-龥]{1,4}/gu) || [];
  const tokens = new Set<string>();

  for (const m of matches) {
    const trimmed = m.trim();
    if (trimmed.length > 1 || /[一-龥]/.test(trimmed)) {
      tokens.add(trimmed);
      // 拆分短横线/下划线组合词
      if (trimmed.includes("-") || trimmed.includes("_")) {
        const subParts = trimmed.split(/[-_]+/);
        for (const sub of subParts) {
          if (sub.length > 1) tokens.add(sub);
        }
      }
    }
  }

  return Array.from(tokens);
}

/**
 * 粗略估算字符串 Token 消耗 (中文 1.5 char/token, 英文 4 char/token)
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(/[一-龥]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 0.8 + nonCjkCount * 0.25);
}

/**
 * Memory 检索评分器
 */
export class MemoryRetriever {
  /**
   * 从候选 Memory 列表中检索出最相关的条目
   */
  retrieve(
    candidates: MemoryEntry[],
    query: MemoryQuery
  ): MemoryRetrievalResult {
    const activeEntries = candidates.filter((e) => !e.deprecated);
    const minConfidence = query.minConfidence ?? 0.2;
    const maxEntries = query.maxEntries ?? 8;
    const maxTokens = query.maxTokens ?? 1500;

    const queryTokens = tokenize(query.query);
    const scored: ScoredMemoryEntry[] = [];

    const now = Date.now();

    for (const entry of activeEntries) {
      if (entry.confidence < minConfidence) {
        continue;
      }

      // 如果指定了 scope，严格过滤
      if (query.scope && query.scope !== "all" && entry.scope !== query.scope) {
        continue;
      }

      let score = 0;
      const matchReasons: string[] = [];

      // 1. 基础作用域权重：Project Memory 优先级高于 Global Memory
      if (entry.scope === "project") {
        score += 2.0;
        matchReasons.push("scope:project(+2.0)");
      } else {
        score += 0.5;
        matchReasons.push("scope:global(+0.5)");
      }

      // 2. 来源与置信度权重
      if (entry.source === "user-explicit") {
        score += 3.0;
        matchReasons.push("source:user-explicit(+3.0)");
      } else if (entry.source === "user-correction") {
        score += 2.5;
        matchReasons.push("source:user-correction(+2.5)");
      } else if (entry.source === "verified-code" || entry.source === "verified-runtime") {
        score += 1.5;
        matchReasons.push("source:verified(+1.5)");
      }

      score += entry.confidence * 2.0;

      // 3. 强化次数加权 (多次验证的知识更稳定)
      if (entry.reinforcementCount > 0) {
        const reinBonus = Math.min(2.0, entry.reinforcementCount * 0.4);
        score += reinBonus;
        matchReasons.push(`reinforcement:+${reinBonus.toFixed(1)}`);
      }

      // 4. 文本关键词相关性打分 (重点)
      const contentTokens = tokenize(entry.content);
      const tagTokens = entry.tags ? entry.tags.flatMap(tokenize) : [];
      const allEntryTokens = new Set([...contentTokens, ...tagTokens]);

      let termMatches = 0;
      for (const qToken of queryTokens) {
        if (allEntryTokens.has(qToken)) {
          termMatches++;
        } else if (entry.content.toLowerCase().includes(qToken)) {
          termMatches += 0.8;
        }
      }

      // 如果有明确查询词但该条目完全没有命中任何相关词：
      // 对于普通知识直接过滤；但对于核心偏好与人设 (preference/invariant)，予以保活不强行丢弃
      const isPreference =
        entry.kind === "preference" ||
        entry.tags?.includes("persona") ||
        entry.tags?.includes("invariant");

      if (queryTokens.length > 0 && termMatches === 0) {
        if (!isPreference) {
          continue;
        }
        score += 1.0;
        matchReasons.push("preference:invariant-retention(+1.0)");
      }

      if (queryTokens.length > 0) {
        const matchRatio = termMatches / queryTokens.length;
        const termScore = termMatches * 3.0 + matchRatio * 2.0;
        score += termScore;
        if (termMatches > 0) {
          matchReasons.push(`termMatches:${termMatches}(+${termScore.toFixed(1)})`);
        }
      }

      // 5. 分类匹配加权
      if (
        entry.kind === "architecture" ||
        entry.kind === "environment" ||
        entry.kind === "preference"
      ) {
        score += 0.5;
      }

      // 6. 时效性 (Recency decay)
      const updatedTime = entry.updatedAt ? new Date(entry.updatedAt).getTime() : now;
      const ageDays = (now - updatedTime) / (1000 * 60 * 60 * 24);
      if (ageDays < 7) {
        score += 0.5;
      }

      scored.push({
        entry,
        score,
        matchReasons,
      });
    }

    // 按得分降序排序
    scored.sort((a, b) => b.score - a.score);

    // 预算截断与去重
    const selectedEntries: MemoryEntry[] = [];
    const seenIds = new Set<string>();
    let currentTokens = 0;
    let projectCount = 0;
    let globalCount = 0;

    for (const item of scored) {
      if (selectedEntries.length >= maxEntries) break;
      if (seenIds.has(item.entry.id)) continue;

      const itemTokens = estimateTokens(item.entry.content);
      if (currentTokens + itemTokens > maxTokens && selectedEntries.length > 0) {
        continue;
      }

      selectedEntries.push(item.entry);
      seenIds.add(item.entry.id);
      currentTokens += itemTokens;

      if (item.entry.scope === "project") {
        projectCount++;
      } else {
        globalCount++;
      }
    }

    return {
      entries: selectedEntries,
      totalRetrieved: selectedEntries.length,
      estimatedTokens: currentTokens,
      projectCount,
      globalCount,
    };
  }
}
