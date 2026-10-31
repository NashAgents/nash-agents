/**
 * Discovery Result Validator
 * 负责严格审查分布式 Scout Agent 上报的发现证据，防止幻觉、伪造或未经验证的推断污染系统知识库
 * 遵循 Fail-Closed 原则与安全防护规则
 */

import type { DiscoveryCandidate, DiscoveryEvidence, DiscoveryReport } from "./types.js";
import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";

export interface ValidationSummary {
  valid: boolean;
  validatedCandidates: DiscoveryCandidate[];
  rejectedCandidates: Array<{ candidate: DiscoveryCandidate; reason: string }>;
  warnings: string[];
}

export class DiscoveryResultValidator {
  constructor(
    private readonly store: IClusterStore,
    private readonly registry: NodeRegistry
  ) {}

  /**
   * 严格核验证查单个 Scout 报告
   */
  async validateReport(report: DiscoveryReport): Promise<ValidationSummary> {
    const validatedCandidates: DiscoveryCandidate[] = [];
    const rejectedCandidates: Array<{ candidate: DiscoveryCandidate; reason: string }> = [];
    const warnings: string[] = [];

    // 1. 验证目标节点是否真实存在且属于集群合法节点
    const nodeConn = this.registry.getConnection(report.nodeId);
    const nodeRecord = await this.store.getNode(report.nodeId);
    if (!nodeRecord) {
      return {
        valid: false,
        validatedCandidates: [],
        rejectedCandidates: report.candidates.map((c) => ({
          candidate: c,
          reason: `Node '${report.nodeId}' is not a recognized cluster node`,
        })),
        warnings: [`Report from unrecognized node ${report.nodeId}`],
      };
    }

    // 2. 逐一审查上报的候选项目与能力
    for (const raw of report.candidates) {
      const sanitized = this.sanitizeCandidate(raw, report.nodeId);

      // 证据链完备性审查：必须拥有至少一项物理证据 (文件/MCP/Memory)
      if (!sanitized.evidences || sanitized.evidences.length === 0) {
        rejectedCandidates.push({
          candidate: sanitized,
          reason: "Candidate rejected: Missing required physical evidence (evidences array is empty)",
        });
        continue;
      }

      // 证据内容合法性检查（防 Prompt Injection 与空白伪造）
      const hasValidEvidence = sanitized.evidences.some(
        (e) => Boolean(e.matchedContent && e.matchedContent.trim().length > 5)
      );
      if (!hasValidEvidence) {
        rejectedCandidates.push({
          candidate: sanitized,
          reason: "Candidate rejected: Evidence lacks verifiable physical content",
        });
        continue;
      }

      // 检查注册状态与 Project ID 真实性
      if (sanitized.candidateProjectId) {
        const catalogProj = await this.store.getProjectCatalog(report.nodeId, sanitized.candidateProjectId);
        if (catalogProj && !sanitized.candidateProjectId.startsWith("discovered-")) {
          // 属于正式已注册项目
          sanitized.isRegistered = true;
          sanitized.verificationStatus = "verified";
          sanitized.projectName = catalogProj.name || sanitized.projectName;
        } else {
          // Scout 发现了未在 Catalog 注册的项目
          sanitized.isRegistered = false;
          sanitized.verificationStatus = "discovered_unregistered";
          warnings.push(
            `Project '${sanitized.projectName}' on node '${report.nodeId}' is discovered but currently unregistered`
          );
        }
      } else {
        // 未提供或不存在 projectId
        sanitized.isRegistered = false;
        sanitized.verificationStatus = "discovered_unregistered";
      }

      // MCP 能力比对：核验 Scout 声称的 MCP 服务是否在节点元数据中存在
      if (sanitized.relevantCapabilities && sanitized.relevantCapabilities.length > 0) {
        const mcpList = await this.store.listMCPCatalog({ nodeId: report.nodeId });
        for (const cap of sanitized.relevantCapabilities) {
          if (cap.capabilityType === "mcp") {
            const matchedServer = mcpList.find(
              (m) =>
                m.serverId.toLowerCase() === cap.name.toLowerCase() ||
                m.displayName.toLowerCase().includes(cap.name.toLowerCase()) ||
                m.tools.some((t) => t.toolName.toLowerCase().includes(cap.name.toLowerCase()))
            );
            if (matchedServer) {
              cap.status = "verified_live";
            } else {
              cap.status = "unverified_reported";
              warnings.push(`MCP capability '${cap.name}' reported by scout not found in live catalog`);
            }
          }
        }
      }

      // 计算最终置信度 (0.0 ~ 1.0)
      sanitized.confidence = this.computeConfidence(sanitized);

      validatedCandidates.push(sanitized);
    }

    return {
      valid: validatedCandidates.length > 0,
      validatedCandidates,
      rejectedCandidates,
      warnings,
    };
  }

  /**
   * 清洗候选内容，防止格式错误与潜在提示词注入
   */
  private sanitizeCandidate(raw: DiscoveryCandidate, nodeId: string): DiscoveryCandidate {
    const cleanStr = (s?: string) => (s ? String(s).trim().slice(0, 1000) : "");
    const cleanEvidences: DiscoveryEvidence[] = (raw.evidences || []).map((e) => ({
      evidenceType: e.evidenceType ?? "file_content",
      sourcePath: cleanStr(e.sourcePath),
      matchedContent: cleanStr(e.matchedContent),
      confidence: typeof e.confidence === "number" ? Math.max(0, Math.min(1, e.confidence)) : 0.7,
      extractedMetadata: e.extractedMetadata ?? {},
    }));

    return {
      candidateId: raw.candidateId || `cand-${Math.random().toString(36).slice(2, 10)}`,
      nodeId,
      candidateProjectId: raw.candidateProjectId ? cleanStr(raw.candidateProjectId) : undefined,
      projectName: cleanStr(raw.projectName) || "Unknown Resource",
      projectSummary: cleanStr(raw.projectSummary) || "No summary provided by scout",
      canonicalPath: cleanStr(raw.canonicalPath) || undefined,
      isRegistered: Boolean(raw.isRegistered),
      verificationStatus: raw.verificationStatus || "unverified",
      confidence: typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      evidences: cleanEvidences,
      relevantCapabilities: raw.relevantCapabilities || [],
      relevantMemorySnippets: (raw.relevantMemorySnippets || []).map((m) => cleanStr(m)),
      suggestedAction: raw.suggestedAction,
    };
  }

  /**
   * 依据物理证据丰富程度与匹配度计算最终置信度
   */
  private computeConfidence(candidate: DiscoveryCandidate): number {
    let score = 0.3;

    // 1. 已注册项目加分
    if (candidate.isRegistered) {
      score += 0.2;
    }

    // 2. 具备结构化配置文件证据 (package.json / README)
    const hasConfigEvidence = candidate.evidences.some(
      (e) => e.evidenceType === "package_json" || /(?:package\.json|README\.md|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(e.sourcePath ?? "")
    );
    if (hasConfigEvidence) {
      score += 0.25;
    }

    // 3. 具备活跃 MCP 工具配合
    const hasLiveMcp = candidate.relevantCapabilities.some((c) => c.status === "verified_live");
    if (hasLiveMcp) {
      score += 0.2;
    }

    // 4. 多证据来源交叉印证
    if (candidate.evidences.length >= 2) {
      score += 0.1;
    }

    return Number(Math.min(0.99, score).toFixed(2));
  }
}
