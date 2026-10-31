import * as crypto from "node:crypto";
import type {
  MemoryEntry,
  MemoryKind,
  MemorySource,
  MemoryEvidence,
} from "./types.js";
import { containsSecret, sanitizeSecretText } from "./secret-sanitizer.js";
import type { MemoryStore } from "./memory-store.js";

export interface AddMemoryInput {
  content: string;
  kind?: MemoryKind;
  source?: MemorySource;
  confidence?: number;
  evidence?: MemoryEvidence[];
  supersedes?: string[];
  tags?: string[];
  projectId?: string;
}

/**
 * 计算两个文本的相似度系数 (Jaccard on token set)
 */
function calculateTextSimilarity(a: string, b: string): number {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();
  if (normA === normB) return 1.0;

  const setA = new Set(normA.match(/[\w\d\-_]+|[一-龥]/gu) || []);
  const setB = new Set(normB.match(/[\w\d\-_]+|[一-龥]/gu) || []);

  if (setA.size === 0 || setB.size === 0) return 0.0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

/**
 * 探测是否属于针对同一主体属性的冲突/更新
 * 例如："Node.js >=24.14" vs "Node.js 22"
 * 或："Linux sandbox backend is Bubblewrap" vs "Linux sandbox backend is Landlock"
 */
function isConflictingTopic(a: string, b: string): boolean {
  const lowA = a.toLowerCase();
  const lowB = b.toLowerCase();

  const subjects = [
    /\bnode(?:\.js)?\s+(?:version|requirement|版本)\b/i,
    /^(?:(linux|macos|windows)\s+)?sandbox\s+(?:primary\s+)?backend\b/i,
    /\bpackage\s+manager\s+(?:is|:|为)/i,
    /\btest\s+command\s+(?:is|:|为)/i,
    /\bbuild\s+tool\s+(?:is|:|为)/i,
  ];
  if (subjects.some(subject => {
    const left = subject.exec(lowA), right = subject.exec(lowB);
    return left && right && left[1] === right[1];
  })) return true;

  // 显式排斥模式匹配 (例如 "pnpm 而不是 npm" 对应包含 "npm" 的旧条目)
  const replaceMatch = lowA.match(/(.+?)\s*(?:而不是|而非|instead of|not)\s*(.+)/i);
  if (replaceMatch && replaceMatch[2]) {
    const rejectedTerm = replaceMatch[2].replace(/[.。!！,，]/g, "").trim();
    if (rejectedTerm.length > 1 && new RegExp(`(?:^|\\W)${rejectedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|\\W)`, "i").test(lowB)) {
      return true;
    }
  }

  return false;
}

/**
 * 获取来源的数值优先级 (越大越权威)
 */
function getSourcePriority(source: MemorySource): number {
  switch (source) {
    case "user-explicit":
      return 100;
    case "user-correction":
      return 90;
    case "verified-runtime":
    case "verified-code":
      return 70;
    case "agent-learned":
      return 40;
    default:
      return 10;
  }
}

/**
 * Memory 写入与冲突协调器
 */
export class MemoryWriter {
  constructor(private readonly store: MemoryStore) {}

  /**
   * 写入或更新一条 Memory，自动执行校验、去重、冲突检测与 supersede
   */
  async addMemory(input: AddMemoryInput): Promise<{
    entry: MemoryEntry;
    action: "created" | "reinforced" | "superseded";
    supersededIds?: string[];
  }> {
    let content = input.content.trim();
    if (!content) {
      throw new Error("Memory 内容不能为空。");
    }

    // Secret 防护过滤与净化
    if (containsSecret(content)) {
      content = sanitizeSecretText(content);
    }

    const source: MemorySource = input.source ?? "agent-learned";
    const confidence = input.confidence ?? (source === "user-explicit" ? 1.0 : 0.8);
    const kind: MemoryKind = input.kind ?? "fact";

    await this.store.loadEntries();
    return this.store.updateEntries<Awaited<ReturnType<MemoryWriter["addMemory"]>>>(existingEntries => {
      const activeEntries = existingEntries.filter((e) => !e.deprecated);

      const now = new Date().toISOString();

      // 1. 同义/重复条目检测与强化 (Deduplication / Reinforcement)
      for (const existing of activeEntries) {
        const similarity = calculateTextSimilarity(content, existing.content);
        if (similarity >= 0.85) {
          // 高度相似，判定为同义知识 -> 强化并更新
          existing.reinforcementCount = (existing.reinforcementCount || 0) + 1;
          existing.updatedAt = now;
          if (confidence > existing.confidence) {
            existing.confidence = confidence;
          }
          if (getSourcePriority(source) > getSourcePriority(existing.source)) {
            existing.source = source;
            existing.content = content; // 采用更高优先级的表达
          }
          if (input.evidence && input.evidence.length > 0) {
            existing.evidence = [...(existing.evidence || []), ...input.evidence].slice(-5);
          }

          return {
            entry: existing,
            action: "reinforced",
          };
        }
      }

      // 2. 冲突检测与 Supersede (例如旧的 Node 22 被新的 Node 24 替换)
      const supersededIds: string[] = [...(input.supersedes || [])];
      const incomingPriority = getSourcePriority(source);

      for (const existing of activeEntries) {
        if (isConflictingTopic(content, existing.content)) {
          const existingPriority = getSourcePriority(existing.source);
          // 如果新事实优先级更高，或者同为用户操作且新事实更新，则废弃旧事实
          if (incomingPriority >= existingPriority) {
            existing.deprecated = true;
            existing.updatedAt = now;
            supersededIds.push(existing.id);
          }
        }
      }

      // 3. 创建全新条目
      const newEntry: MemoryEntry = {
        id: `mem-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
        scope: this.store.scope,
        kind,
        content,
        confidence,
        source,
        createdAt: now,
        updatedAt: now,
        reinforcementCount: 1,
        supersedes: supersededIds.length > 0 ? supersededIds : undefined,
        evidence: input.evidence,
        projectId: input.projectId,
        tags: input.tags,
      };

      existingEntries.push(newEntry);

      return {
        entry: newEntry,
        action: supersededIds.length > 0 ? "superseded" : "created",
        supersededIds: supersededIds.length > 0 ? supersededIds : undefined,
      };
    });
  }
}
