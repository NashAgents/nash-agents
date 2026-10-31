/**
 * 统一项目名称与别名规范化处理
 * 兼容大小写、空格、下划线、短横线与点号，确保 MetroWiseV2 能匹配 MetroWise_V2、metro-wise-v2 等
 */
export function normalizeProjectName(name?: string): string {
  if (!name) return "";
  return name.toLowerCase().replace(/[\s_\-.]+/g, "");
}

import type { IClusterStore } from "../../storage/cluster-store.js";
import type { NodeRegistry } from "../node-registry.js";
import type { CoordinatorCatalogService } from "./coordinator-catalog-service.js";
import type {
  ProjectCatalogItem,
  SkillCatalogItem,
  MCPCapabilityCatalogItem,
  FederatedMemoryIndexItem,
  NodeHardwareCapability,
  RemoteMemorySearchResultItem,
} from "../../protocol/types.js";

export interface ProjectSearchResult {
  resourceType: "project";
  nodeId: string;
  projectId: string;
  name: string;
  summary: string;
  description: string;
  technologies: string[];
  capabilities: string[];
  score: number;
  matchReasons: string[];
  evidence: string;
  nodeOnline: boolean;
  visibility: string;
  updatedAt: number;
}

export interface SkillSearchResult {
  resourceType: "skill";
  nodeId: string;
  skillId: string;
  name: string;
  description: string;
  scope: "global" | "project";
  tags: string[];
  available: boolean;
  score: number;
  matchReasons: string[];
  nodeOnline: boolean;
}

export interface MCPSearchResult {
  resourceType: "mcp";
  nodeId: string;
  serverId: string;
  displayName: string;
  transportType: string;
  status: string;
  capabilitySummary: string;
  matchedTools: Array<{
    name: string;
    description: string;
    risk: string;
    available: boolean;
  }>;
  score: number;
  matchReasons: string[];
  nodeOnline: boolean;
}

export interface MemoryIndexSearchResult {
  resourceType: "memory_index";
  nodeId: string;
  projectId: string;
  entryId: string;
  topic: string;
  summary: string;
  keywords: string[];
  score: number;
  matchReasons: string[];
  evidence: string;
  sourceReference: string;
  confidence: number;
  nodeOnline: boolean;
  remoteRetrievalAvailable: boolean;
  remoteResults?: RemoteMemorySearchResultItem[];
  updatedAt: number;
}

export interface UnifiedClusterSearchResult {
  query: string;
  totalMatches: number;
  projects: ProjectSearchResult[];
  memoryIndex: MemoryIndexSearchResult[];
  skills: SkillSearchResult[];
  mcp: MCPSearchResult[];
}

/**
 * 轻量语义同义词与意图词典
 */
const INTENT_SYNONYMS: Record<string, string[]> = {
  知识库: ["rag", "knowledge", "retrieval", "embedding", "向量", "知识库"],
  rag: ["rag", "knowledge", "retrieval", "embedding", "向量", "知识库"],
  英语: ["english", "reader", "reading", "audio", "subtitle", "英语", "阅读"],
  阅读: ["reader", "reading", "article", "book", "text", "阅读"],
  字幕: ["subtitle", "subtitles", "srt", "vtt", "transcript", "字幕"],
  音频: ["audio", "sound", "player", "voice", "speech", "音频", "播放"],
  播放: ["play", "player", "playback", "audio", "video", "播放"],
  高亮: ["highlight", "highlighting", "高亮"],
  逐句: ["sentence", "realtime", "逐句", "实时"],
  代理: ["agent", "harness", "runtime", "loop", "nash", "代理"],
  harness: ["agent", "runtime", "loop", "nash", "harness", "framework"],
  沙箱: ["sandbox", "seatbelt", "bubblewrap", "landlock", "isolation", "沙箱"],
  mcp: ["mcp", "tools", "protocol", "bilibili", "modelcontextprotocol"],
  b站: ["bilibili", "b站", "哔哩哔哩"],
  哔哩哔哩: ["bilibili", "b站", "哔哩哔哩"],
  集群: ["cluster", "coordinator", "worker", "distributed", "node", "集群"],
  视觉: ["visual", "image", "vision", "multimodal", "视觉"],
  学习: ["learning", "study", "reader", "education", "学习"],
  cuda: ["cuda", "gpu", "nvidia", "torch", "pytorch"],
  pytorch: ["pytorch", "torch", "deeplearning", "cuda", "model"],
};

export class ClusterSearchService {
  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry,
    private readonly catalogService?: CoordinatorCatalogService
  ) {}

  /**
   * 分词并展开中英文同义词
   */
  private tokenizeAndExpand(query: string): string[] {
    const rawTokens = query.toLowerCase().split(/[\s,，、._\-/+]+/).filter(Boolean);
    const expanded = new Set<string>(rawTokens);
    const qLower = query.toLowerCase();

    // 驼峰切分与字母数字边界切分 (如 MetroWiseV2 -> metro, wise, v2)
    const camelSpaced = query
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([a-zA-Z])([0-9]+)/g, "$1 $2")
      .replace(/([0-9]+)([a-zA-Z])/g, "$1 $2");
    const camelTokens = camelSpaced.toLowerCase().split(/[\s,，、._\-/+]+/).filter(Boolean);
    for (const ct of camelTokens) {
      expanded.add(ct);
    }
    const norm = normalizeProjectName(query);
    if (norm) expanded.add(norm);

    // 针对紧凑中文句子的意图词与同义词命中
    for (const [key, list] of Object.entries(INTENT_SYNONYMS)) {
      if (qLower.includes(key)) {
        expanded.add(key);
        for (const item of list) {
          expanded.add(item);
        }
      }
    }

    for (const token of rawTokens) {
      if (INTENT_SYNONYMS[token]) {
        for (const s of INTENT_SYNONYMS[token]!) {
          expanded.add(s);
        }
      }
      for (const [key, list] of Object.entries(INTENT_SYNONYMS)) {
        if (list.includes(token)) {
          expanded.add(key);
          list.forEach((item) => expanded.add(item));
        }
      }
    }

    return Array.from(expanded);
  }

  /**
   * 搜索集群节点及状态
   */
  async searchNodes(query?: string): Promise<Array<{
    nodeId: string;
    name: string;
    role: string;
    platform: string;
    arch: string;
    status: string;
    online: boolean;
    lastSeenAt: number;
    catalogRevision: number;
    capabilities: NodeHardwareCapability[];
  }>> {
    const nodes = await this.store.listNodes();
    const qLower = query?.toLowerCase().trim();

    const results = [];
    for (const node of nodes) {
      const isOnline = this.registry.getConnection(node.nodeId) !== undefined;
      const catRev = await this.store.getCatalogRevision(node.nodeId);

      if (qLower) {
        const matched =
          node.nodeId.toLowerCase().includes(qLower) ||
          node.name.toLowerCase().includes(qLower) ||
          node.platform.toLowerCase().includes(qLower) ||
          node.arch.toLowerCase().includes(qLower) ||
          (catRev?.capabilities ?? []).some((c) =>
            c.name.toLowerCase().includes(qLower) || c.details.toLowerCase().includes(qLower)
          );
        if (!matched) continue;
      }

      results.push({
        nodeId: node.nodeId,
        name: node.name,
        role: node.role,
        platform: node.platform,
        arch: node.arch,
        status: isOnline ? "online" : node.status,
        online: isOnline,
        lastSeenAt: node.lastSeenAt,
        catalogRevision: catRev?.revision ?? 0,
        capabilities: catRev?.capabilities ?? [],
      });
    }

    return results;
  }

  /**
   * 搜索项目目录
   */
  async searchProjects(
    query?: string,
    options?: { nodeId?: string; limit?: number }
  ): Promise<ProjectSearchResult[]> {
    const projects = await this.store.listProjectsCatalog({ nodeId: options?.nodeId });
    if (!query || query.trim() === "") {
      return projects.map((p) => ({
        resourceType: "project",
        nodeId: p.nodeId,
        projectId: p.projectId,
        name: p.name,
        summary: p.summary,
        description: p.description,
        technologies: p.technologies,
        capabilities: p.capabilities,
        score: 1.0,
        matchReasons: ["All projects listing"],
        evidence: "Project Catalog Metadata",
        nodeOnline: this.registry.getConnection(p.nodeId) !== undefined,
        visibility: p.visibility,
        updatedAt: p.updatedAt,
      }));
    }

    const tokens = this.tokenizeAndExpand(query);
    const qLower = query.toLowerCase();
    const scoredList: ProjectSearchResult[] = [];

    for (const p of projects) {
      let score = 0;
      const matchReasons: string[] = [];

      const nameLower = (p.name ?? "").toLowerCase();
      const summaryLower = (p.summary ?? "").toLowerCase();
      const descLower = (p.description ?? "").toLowerCase();
      const techLower = (p.technologies ?? []).map((t) => t.toLowerCase());
      const capLower = (p.capabilities ?? []).map((c) => c.toLowerCase());
      const aliasLower = (p.userAliases ?? []).map((a) => a.toLowerCase());

      const normQ = normalizeProjectName(query);
      const normName = normalizeProjectName(p.name);
      const normAliases = (p.userAliases ?? []).map((a) => normalizeProjectName(a));

      // 1. 完全或子串精准匹配项目名/别名（含大小写/下划线/连字符归一化）
      if (nameLower === qLower || aliasLower.includes(qLower) || (normQ && (normName === normQ || normAliases.includes(normQ)))) {
        score += 100;
        matchReasons.push(`Exact project name/alias match: "${p.name}"`);
      } else if (nameLower.includes(qLower) || (normQ && (normName.includes(normQ) || (normQ.length >= 4 && normName && normQ.includes(normName))))) {
        score += 50;
        matchReasons.push(`Project name contains query pattern: "${p.name}"`);
      } else if (summaryLower.includes(qLower) || (normQ && normalizeProjectName(p.summary).includes(normQ))) {
        score += 60;
        matchReasons.push(`Summary contains search phrase`);
      } else if (descLower.includes(qLower) || (normQ && normalizeProjectName(p.description).includes(normQ))) {
        score += 40;
        matchReasons.push(`Description contains search phrase`);
      }

      // 2. 关键词与同义词命中技术栈与能力标签
      for (const t of tokens) {
        if (techLower.includes(t)) {
          score += 35;
          matchReasons.push(`Technology match: "${t}"`);
        }
        if (capLower.includes(t)) {
          score += 35;
          matchReasons.push(`Capability match: "${t}"`);
        }
        if (summaryLower.includes(t)) {
          score += 20;
          matchReasons.push(`Summary matched keyword: "${t}"`);
        }
        if (descLower.includes(t)) {
          score += 10;
        }
      }

      if (score > 0) {
        // 归一化分数 0.0 ~ 1.0
        const normalizedScore = Number(Math.min(1.0, score / 120).toFixed(2));
        const isOnline = this.registry.getConnection(p.nodeId) !== undefined;

        scoredList.push({
          resourceType: "project",
          nodeId: p.nodeId,
          projectId: p.projectId,
          name: p.name,
          summary: p.summary,
          description: p.description,
          technologies: p.technologies,
          capabilities: p.capabilities,
          score: normalizedScore,
          matchReasons: Array.from(new Set(matchReasons)),
          evidence: "Project Catalog Metadata",
          nodeOnline: isOnline,
          visibility: p.visibility,
          updatedAt: p.updatedAt,
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, options?.limit ?? 20);
  }

  /**
   * 搜索集群 Skills
   */
  async searchSkills(
    query?: string,
    options?: { nodeId?: string; limit?: number }
  ): Promise<SkillSearchResult[]> {
    const skills = await this.store.listSkillsCatalog({ nodeId: options?.nodeId });
    if (!query || query.trim() === "") {
      return skills.map((s) => ({
        resourceType: "skill",
        nodeId: s.nodeId,
        skillId: s.skillId,
        name: s.name,
        description: s.description,
        scope: s.scope,
        tags: s.tags,
        available: s.available,
        score: 1.0,
        matchReasons: ["All skills listing"],
        nodeOnline: this.registry.getConnection(s.nodeId) !== undefined,
      }));
    }

    const tokens = this.tokenizeAndExpand(query);
    const scoredList: SkillSearchResult[] = [];

    for (const s of skills) {
      let score = 0;
      const matchReasons: string[] = [];
      const nameLower = s.name.toLowerCase();
      const descLower = s.description.toLowerCase();
      const tagsLower = s.tags.map((t) => t.toLowerCase());

      for (const t of tokens) {
        if (nameLower.includes(t)) {
          score += 40;
          matchReasons.push(`Skill name matched: "${t}"`);
        }
        if (descLower.includes(t)) {
          score += 25;
          matchReasons.push(`Skill description matched: "${t}"`);
        }
        if (tagsLower.includes(t)) {
          score += 20;
          matchReasons.push(`Skill tag matched: "${t}"`);
        }
      }

      if (score > 0) {
        const isOnline = this.registry.getConnection(s.nodeId) !== undefined;
        scoredList.push({
          resourceType: "skill",
          nodeId: s.nodeId,
          skillId: s.skillId,
          name: s.name,
          description: s.description,
          scope: s.scope,
          tags: s.tags,
          available: s.available,
          score: Number(Math.min(1.0, score / 80).toFixed(2)),
          matchReasons: Array.from(new Set(matchReasons)),
          nodeOnline: isOnline,
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, options?.limit ?? 20);
  }

  /**
   * 搜索集群 MCP 能力
   */
  async searchMCPCapabilities(
    query?: string,
    options?: { nodeId?: string; limit?: number }
  ): Promise<MCPSearchResult[]> {
    const servers = await this.store.listMCPCatalog({ nodeId: options?.nodeId });
    if (!query || query.trim() === "") {
      return servers.map((m) => ({
        resourceType: "mcp",
        nodeId: m.nodeId,
        serverId: m.serverId,
        displayName: m.displayName,
        transportType: m.transportType,
        status: m.status,
        capabilitySummary: m.capabilitySummary,
        matchedTools: m.tools.map((t) => ({
          name: t.toolName,
          description: t.description,
          risk: t.riskClassification,
          available: t.available,
        })),
        score: 1.0,
        matchReasons: ["All MCP capabilities listing"],
        nodeOnline: this.registry.getConnection(m.nodeId) !== undefined,
      }));
    }

    const tokens = this.tokenizeAndExpand(query);
    const scoredList: MCPSearchResult[] = [];

    for (const m of servers) {
      let score = 0;
      const matchReasons: string[] = [];
      const matchedTools: MCPSearchResult["matchedTools"] = [];

      const serverLower = m.serverId.toLowerCase();
      const summaryLower = m.capabilitySummary.toLowerCase();

      for (const t of tokens) {
        if (serverLower.includes(t)) {
          score += 50;
          matchReasons.push(`MCP server name matched: "${t}"`);
        }
        if (summaryLower.includes(t)) {
          score += 20;
          matchReasons.push(`MCP capability summary matched: "${t}"`);
        }
      }

      for (const tool of m.tools) {
        const toolLower = tool.toolName.toLowerCase();
        const descLower = tool.description.toLowerCase();
        let toolMatched = false;

        for (const t of tokens) {
          if (toolLower.includes(t) || descLower.includes(t)) {
            score += 30;
            toolMatched = true;
            matchReasons.push(`Tool matched: "${tool.toolName}"`);
          }
        }

        if (toolMatched) {
          matchedTools.push({
            name: tool.toolName,
            description: tool.description,
            risk: tool.riskClassification,
            available: tool.available,
          });
        }
      }

      if (score > 0) {
        const isOnline = this.registry.getConnection(m.nodeId) !== undefined;
        scoredList.push({
          resourceType: "mcp",
          nodeId: m.nodeId,
          serverId: m.serverId,
          displayName: m.displayName,
          transportType: m.transportType,
          status: m.status,
          capabilitySummary: m.capabilitySummary,
          matchedTools,
          score: Number(Math.min(1.0, score / 100).toFixed(2)),
          matchReasons: Array.from(new Set(matchReasons)),
          nodeOnline: isOnline,
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    return scoredList.slice(0, options?.limit ?? 20);
  }

  /**
   * 两级联邦记忆检索 (Two-Stage Federated Retrieval)
   * 第一级: Coordinator 本地轻量主题索引查询 (缩小候选)
   * 第二级: 向目标在线 Worker 发起 WSS RPC 细粒度检索 (仅在 deep=true 时)
   */
  async searchFederatedMemory(
    query: string,
    options?: { nodeId?: string; projectId?: string; deep?: boolean; topK?: number }
  ): Promise<MemoryIndexSearchResult[]> {
    const memoryEntries = await this.store.listMemoryIndex({
      nodeId: options?.nodeId,
      projectId: options?.projectId,
    });

    const tokens = this.tokenizeAndExpand(query);
    const scoredList: MemoryIndexSearchResult[] = [];

    // Stage 1: Global Index Search
    for (const e of memoryEntries) {
      let score = 0;
      const matchReasons: string[] = [];

      const topicLower = e.topic.toLowerCase();
      const summaryLower = e.summary.toLowerCase();
      const kwLower = e.keywords.map((k) => k.toLowerCase());
      const qLower = query.toLowerCase();

      const normQ = normalizeProjectName(query);
      const normTopic = normalizeProjectName(e.topic);
      const normSummary = normalizeProjectName(e.summary);
      const normKws = e.keywords.map((k) => normalizeProjectName(k));

      // 归一化精准匹配与子串匹配 (兼容 MetroWiseV2 vs MetroWise_V2)
      if (normQ && normTopic === normQ) {
        score += 100;
        matchReasons.push(`Exact memory topic match (normalized): "${e.topic}"`);
      } else if (normQ && (normTopic.includes(normQ) || (normQ.length >= 4 && normTopic && normQ.includes(normTopic)))) {
        score += 50;
        matchReasons.push(`Topic matches query pattern: "${e.topic}"`);
      } else if (topicLower.includes(qLower)) {
        score += 50;
        matchReasons.push(`Topic contains query phrase`);
      }

      if (summaryLower.includes(qLower) || (normQ && normSummary.includes(normQ))) {
        score += 60;
        matchReasons.push(`Summary contains query phrase`);
      }

      if (normQ && normKws.includes(normQ)) {
        score += 45;
        matchReasons.push(`Keyword exact match (normalized)`);
      }

      for (const t of tokens) {
        if (topicLower.includes(t) || (normTopic && normalizeProjectName(t) && normTopic.includes(normalizeProjectName(t)))) {
          score += 45;
          matchReasons.push(`Topic matched: "${t}"`);
        }
        if (kwLower.includes(t) || (normKws.length > 0 && normalizeProjectName(t) && normKws.includes(normalizeProjectName(t)))) {
          score += 35;
          matchReasons.push(`Keyword matched: "${t}"`);
        }
        if (summaryLower.includes(t) || (normSummary && normalizeProjectName(t) && normSummary.includes(normalizeProjectName(t)))) {
          score += 25;
          matchReasons.push(`Summary matched: "${t}"`);
        }
      }

      if (score > 0) {
        const isOnline = this.registry.getConnection(e.nodeId) !== undefined;
        scoredList.push({
          resourceType: "memory_index",
          nodeId: e.nodeId,
          projectId: e.projectId,
          entryId: e.entryId,
          topic: e.topic,
          summary: e.summary,
          keywords: e.keywords,
          score: Number(Math.min(1.0, (score * e.confidence) / 100).toFixed(2)),
          matchReasons: Array.from(new Set(matchReasons)),
          evidence: `Memory Topic Summary (${e.sourceReference})`,
          sourceReference: e.sourceReference,
          confidence: e.confidence,
          nodeOnline: isOnline,
          remoteRetrievalAvailable: isOnline && e.visibility === "retrievable",
          updatedAt: e.updatedAt,
        });
      }
    }

    scoredList.sort((a, b) => b.score - a.score);
    const candidates = scoredList.slice(0, options?.topK ?? 10);

    // Stage 2: Remote Memory Retrieval (仅当 deep=true 且节点在线且服务可用时触发)
    if (options?.deep && this.catalogService && candidates.length > 0) {
      const deepTasks = candidates.slice(0, 3).map(async (candidate) => {
        if (candidate.remoteRetrievalAvailable) {
          try {
            const remoteRes = await this.catalogService!.searchRemoteMemory(
              candidate.nodeId,
              candidate.projectId,
              query,
              { topK: 3 }
            );
            if (remoteRes.retrievalStatus === "ok") {
              candidate.remoteResults = remoteRes.results;
            }
          } catch {}
        }
      });

      await Promise.allSettled(deepTasks);
    }

    return candidates;
  }

  /**
   * 跨目录统一联合检索 (Unified Multi-Resource Cluster Search)
   */
  async searchAll(query: string, options?: { topK?: number; deep?: boolean }): Promise<UnifiedClusterSearchResult> {
    const [projects, memoryIndex, skills, mcp] = await Promise.all([
      this.searchProjects(query, { limit: options?.topK ?? 10 }),
      this.searchFederatedMemory(query, { deep: options?.deep ?? false, topK: options?.topK ?? 10 }),
      this.searchSkills(query, { limit: options?.topK ?? 10 }),
      this.searchMCPCapabilities(query, { limit: options?.topK ?? 10 }),
    ]);

    const totalMatches = projects.length + memoryIndex.length + skills.length + mcp.length;

    return {
      query,
      totalMatches,
      projects,
      memoryIndex,
      skills,
      mcp,
    };
  }
}
