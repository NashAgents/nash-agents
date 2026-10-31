export interface MemoryRecord {
  entryId: string;
  nodeId: string;
  projectId: string;
  topic: string;
  summary: string;
  keywords?: string[];
  sourceReference?: string;
  evidence?: string;
  confidence?: number;
  visibility?: string;
  updatedAt?: number | string;
  score?: number;
  matchReasons?: string[];
}

export type MemoryOrigin = "project" | "discovery";
export const memoryKinds: Record<string, string> = {
  fact: "事实", architecture: "架构", preference: "偏好", environment: "环境",
  decision: "决策", lesson: "经验", general: "综合知识",
};

export function memoryKey(item: MemoryRecord): string {
  return JSON.stringify([item.nodeId, item.projectId, item.entryId]);
}

export function memoryOrigin(item: MemoryRecord): MemoryOrigin {
  return item.entryId.startsWith("mem-disc-") || item.topic.startsWith("Discovery:") ? "discovery" : "project";
}

export function memoryProjectName(item: MemoryRecord): string {
  if (memoryOrigin(item) === "discovery") return item.topic.replace(/^Discovery:\s*/, "") || item.projectId;
  return item.topic.includes(" · ") ? item.topic.split(" · ")[0]! : item.projectId;
}

export function memoryTopic(item: MemoryRecord): string {
  if (memoryOrigin(item) === "discovery") return "项目发现";
  const topic = item.topic.includes(" · ") ? item.topic.split(" · ").slice(1).join(" · ") : item.topic;
  const topics: Record<string, string> = { persona: "用户偏好", "streaming-asr": "流式语音识别", "audio-sync": "音频同步", mcp: "MCP 集成", "nash-agent": "运行架构" };
  return memoryKinds[topic] ?? topics[topic] ?? topic;
}

export function memoryPoints(item: MemoryRecord): { kind: string; content: string }[] {
  return item.summary.split(/\s+\|\s+(?=\[(?:fact|architecture|preference|environment|decision|lesson)\])/)
    .map((point) => {
      const match = point.match(/^\[(\w+)\]\s*([\s\S]*)$/);
      return { kind: match ? memoryKinds[match[1]!] ?? match[1]! : "", content: match ? match[2]! : point };
    });
}

export function memoryTimestamp(item: MemoryRecord): number {
  if (item.updatedAt === undefined || item.updatedAt === null || item.updatedAt === "") return 0;
  const timestamp = typeof item.updatedAt === "number" ? item.updatedAt : Date.parse(item.updatedAt);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function memoryReviewReason(item: MemoryRecord): string {
  const points = memoryPoints(item);
  if (!points.some((point) => point.content.trim())) return "这条记录没有内容，无法作为知识使用。";
  if (points.some((point) => /^叫我什么[?？。!！]*$/.test(point.content.trim()))) return "只保存了一个问题，没有记录具体称谓，无法作为用户偏好使用。";
  if (points.some((point) => /^(?:到|放到|保存到)当前目录下的/.test(point.content.trim()))) return "内容依赖当时的目录和任务上下文，单独使用容易产生误解。";
  return "";
}

export function memoryPurpose(item: MemoryRecord): string {
  if (memoryReviewReason(item)) return "用途尚不明确，需要结合原始来源核对。";
  if (memoryOrigin(item) === "discovery") return "帮助后续任务定位可能相关的项目与能力；发现摘要仍需结合实际项目验证。";
  const kind = memoryPoints(item)[0]?.kind;
  if (kind === "偏好") return "为后续交互提供用户偏好参考；项目内记录不等同于全局偏好。";
  if (kind === "架构") return "为后续项目任务提供实现方案与架构背景，减少重复探查。";
  if (kind === "经验") return "为后续相似任务提供经验参考，避免重复踩坑。";
  return "为后续项目任务提供背景知识参考，使用前仍需核对是否适用于当前环境。";
}

export function formatMemoryTime(item: MemoryRecord): string {
  const timestamp = memoryTimestamp(item);
  return timestamp ? new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(timestamp) : "时间未记录";
}

export function memoryDuplicates(items: MemoryRecord[]): Map<string, MemoryRecord[]> {
  const buckets = new Map<string, MemoryRecord[]>();
  for (const item of items) {
    const content = memoryPoints(item).map((point) => point.content).join(" ").replace(/\s+/g, " ").trim();
    if (!content) continue;
    const bucket = buckets.get(content) ?? [];
    if (!bucket.some((other) => memoryKey(other) === memoryKey(item))) bucket.push(item);
    buckets.set(content, bucket);
  }
  const duplicates = new Map<string, MemoryRecord[]>();
  for (const bucket of buckets.values()) {
    if (bucket.length > 1) for (const item of bucket) duplicates.set(memoryKey(item), bucket.filter((other) => memoryKey(other) !== memoryKey(item)));
  }
  return duplicates;
}
