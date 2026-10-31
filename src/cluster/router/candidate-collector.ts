/**
 * Routing Candidate Collector
 * 负责基于 TaskIntent，从 Project Catalog、Federated Memory、Capability Catalog 与 Node Hardware 中收集候选节点与项目
 */

import type { ClusterSearchService } from "../coordinator/catalog/cluster-search-service.js";
import type { TaskIntent, RoutingCandidate, CandidateEvidence } from "./types.js";

export interface CandidateCollectorOptions {
  searchService: ClusterSearchService;
}

export class RoutingCandidateCollector {
  constructor(private readonly searchService: ClusterSearchService) {}

  /**
   * 收集符合意图的候选节点与项目集合
   */
  async collect(intent: TaskIntent): Promise<RoutingCandidate[]> {
    const candidateMap = new Map<string, RoutingCandidate>();

    // 辅助唯一 Key
    const candidateKey = (nodeId: string, projectId: string) => `${nodeId}::${projectId}`;

    // 1. 从 Project Catalog 检索项目
    const queryTerm = intent.goal;
    const projectResults = await this.searchService.searchProjects(queryTerm, {
      limit: 10,
    });

    for (const p of projectResults) {
      const key = candidateKey(p.nodeId, p.projectId);
      const evidence: CandidateEvidence = {
        sourceType: "project_catalog",
        referenceId: `proj:${p.projectId}`,
        summary: p.summary || p.description || p.name,
        confidence: 0.95,
        freshnessTimestamp: p.updatedAt,
        matchReasons: p.matchReasons,
      };

      if (!candidateMap.has(key)) {
        candidateMap.set(key, {
          nodeId: p.nodeId,
          projectId: p.projectId,
          projectName: p.name,
          projectSummary: p.summary,
          technologies: p.technologies,
          capabilities: p.capabilities,
          nodeOnline: p.nodeOnline,
          projectStatus: "active",
          score: p.score,
          confidence: 0.9,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [evidence],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        });
      } else {
        const c = candidateMap.get(key)!;
        c.evidences.push(evidence);
        c.score = Math.max(c.score, p.score);
      }
    }

    // 1.1 若用户显式或偏好指定了目标节点，但该节点项目因关键词差异未在第一轮返回，强制保底搜寻目标节点项目
    const targetedNodeId = intent.constraints.explicitNodeId || intent.constraints.preferredNodeId;
    if (targetedNodeId) {
      const hasTargetNodeCandidate = Array.from(candidateMap.values()).some((c) => c.nodeId === targetedNodeId);
      if (!hasTargetNodeCandidate) {
        const targetNodeProjects = await this.searchService.searchProjects("", { nodeId: targetedNodeId });
        for (const p of targetNodeProjects) {
          const key = candidateKey(p.nodeId, p.projectId);
          if (!candidateMap.has(key)) {
            candidateMap.set(key, {
              nodeId: p.nodeId,
              projectId: p.projectId,
              projectName: p.name,
              projectSummary: p.summary,
              technologies: p.technologies,
              capabilities: p.capabilities,
              nodeOnline: p.nodeOnline,
              projectStatus: "active",
              score: 0.85,
              confidence: 0.9,
              hardConstraintsSatisfied: true,
              unsatisfiedConstraints: [],
              evidences: [
                {
                  sourceType: "project_catalog",
                  referenceId: `proj:${p.projectId}`,
                  summary: `Target node project '${p.name}' selected to satisfy explicit node constraint`,
                  confidence: 0.95,
                  freshnessTimestamp: p.updatedAt,
                  matchReasons: [`User explicit/preferred node matches node '${targetedNodeId}'`],
                },
              ],
              requiredSkillsAvailable: true,
              requiredMCPAvailable: true,
            });
          }
        }
      }
    }

    // 2. 从 Federated Memory 检索项目与长期知识 (两级检索)
    const memoryResults = await this.searchService.searchFederatedMemory(queryTerm, {
      topK: 6,
      deep: false, // 初筛阶段使用轻量级本地主题索引
    });

    for (const m of memoryResults) {
      const key = candidateKey(m.nodeId, m.projectId);
      const evidence: CandidateEvidence = {
        sourceType: "federated_memory",
        referenceId: `mem:${m.entryId}`,
        summary: m.summary,
        confidence: 0.85,
        freshnessTimestamp: m.updatedAt,
        matchReasons: m.matchReasons,
      };

      if (!candidateMap.has(key)) {
        // 如果此前未在项目目录直接搜出，则通过 Memory 发现该候选项目
        candidateMap.set(key, {
          nodeId: m.nodeId,
          projectId: m.projectId,
          projectName: m.topic || m.projectId.replace(/^proj-/, ""),
          projectSummary: m.summary,
          technologies: [],
          capabilities: [],
          nodeOnline: m.nodeOnline,
          projectStatus: "active",
          score: m.score * 0.9,
          confidence: 0.8,
          hardConstraintsSatisfied: true,
          unsatisfiedConstraints: [],
          evidences: [evidence],
          requiredSkillsAvailable: true,
          requiredMCPAvailable: true,
        });
      } else {
        const c = candidateMap.get(key)!;
        c.evidences.push(evidence);
        // 联邦记忆补充命中加分
        c.score = Math.min(1.0, c.score + m.score * 0.25);
      }
    }

    // 3. 关联 Capability Catalog (MCP 与 Skills)
    if (intent.capabilityHints.length > 0 || intent.requiredCapabilities.length > 0) {
      const mcpResults = await this.searchService.searchMCPCapabilities(queryTerm, { limit: 10 });
      const skillResults = await this.searchService.searchSkills(queryTerm, { limit: 10 });

      // 如果某些节点具备独占的 MCP 能力但尚未作为候选加入，将其关联节点项目拉入候选集
      for (const mcp of mcpResults) {
        const hasNodeCandidate = Array.from(candidateMap.values()).some((c) => c.nodeId === mcp.nodeId);
        if (!hasNodeCandidate) {
          const nodeProjects = await this.searchService.searchProjects("", { nodeId: mcp.nodeId });
          const proj = nodeProjects[0];
          if (proj) {
            const key = candidateKey(mcp.nodeId, proj.projectId);
            candidateMap.set(key, {
              nodeId: mcp.nodeId,
              projectId: proj.projectId,
              projectName: proj.name,
              projectSummary: proj.summary,
              technologies: proj.technologies,
              capabilities: proj.capabilities,
              nodeOnline: mcp.nodeOnline,
              projectStatus: "active",
              score: mcp.score * 0.85,
              confidence: mcp.status === "available" ? 0.95 : 0.4,
              hardConstraintsSatisfied: true,
              unsatisfiedConstraints: [],
              evidences: [],
              requiredSkillsAvailable: true,
              requiredMCPAvailable: mcp.status === "available",
            });
          }
        }
      }

      for (const candidate of candidateMap.values()) {
        // 检查该节点上的 MCP 能力
        const nodeMcps = mcpResults.filter((m) => m.nodeId === candidate.nodeId);
        for (const mcp of nodeMcps) {
          candidate.evidences.push({
            sourceType: "mcp_catalog",
            referenceId: `mcp:${mcp.serverId}`,
            summary: `MCP Server '${mcp.displayName}' (${mcp.status}) - ${mcp.capabilitySummary}`,
            confidence: mcp.status === "available" ? 1.0 : 0.4,
            freshnessTimestamp: Date.now(),
            matchReasons: mcp.matchReasons,
          });
        }

        // 检查该节点上的 Skills
        const nodeSkills = skillResults.filter((s) => s.nodeId === candidate.nodeId);
        for (const s of nodeSkills) {
          candidate.evidences.push({
            sourceType: "skill_catalog",
            referenceId: `skill:${s.skillId}`,
            summary: `Skill '${s.name}' - ${s.description}`,
            confidence: 0.9,
            freshnessTimestamp: Date.now(),
            matchReasons: s.matchReasons,
          });
        }
      }
    }

    // 4. 获取节点硬件与运行态信息
    const nodes = await this.searchService.searchNodes();
    for (const candidate of candidateMap.values()) {
      const node = nodes.find((n) => n.nodeId === candidate.nodeId);
      if (node) {
        candidate.nodeOnline = node.online;
        for (const cap of node.capabilities) {
          candidate.evidences.push({
            sourceType: "node_hardware",
            referenceId: `hw:${cap.name}`,
            summary: `${cap.name}: ${cap.details}`,
            confidence: 1.0,
            freshnessTimestamp: node.lastSeenAt,
            matchReasons: [`Node platform ${node.platform}/${node.arch}`],
          });
        }
      }
    }

    return Array.from(candidateMap.values());
  }
}
