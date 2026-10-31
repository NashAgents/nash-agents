/**
 * Routing Candidate Ranker
 * 负责硬约束过滤、软偏好排序、事实可信度评估以及跨节点多任务依赖识别
 */

import type {
  TaskIntent,
  RoutingCandidate,
} from "./types.js";

export class RoutingCandidateRanker {
  /**
   * 过滤并排序候选者
   */
  rank(intent: TaskIntent, candidates: RoutingCandidate[]): RoutingCandidate[] {
    const scoredCandidates: RoutingCandidate[] = [];

    for (const rawCandidate of candidates) {
      const c: RoutingCandidate = {
        ...rawCandidate,
        unsatisfiedConstraints: [...rawCandidate.unsatisfiedConstraints],
      };

      // 1. 硬约束判定 (Hard Constraints)
      let hardSatisfied = true;

      // 1.1 显式指定节点
      if (
        intent.constraints.explicitNodeId &&
        c.nodeId !== intent.constraints.explicitNodeId
      ) {
        hardSatisfied = false;
        c.unsatisfiedConstraints.push(
          `用户显式约束节点为 '${intent.constraints.explicitNodeId}'，候选节点 '${c.nodeId}' 不匹配`
        );
      }

      // 1.2 显式指定项目
      if (
        intent.constraints.explicitProjectId &&
        c.projectId !== intent.constraints.explicitProjectId
      ) {
        hardSatisfied = false;
        c.unsatisfiedConstraints.push(
          `用户显式约束项目为 '${intent.constraints.explicitProjectId}'，候选项目 '${c.projectId}' 不匹配`
        );
      }

      // 1.3 节点在线状态
      if (!c.nodeOnline) {
        hardSatisfied = false;
        c.unsatisfiedConstraints.push(`目标节点 '${c.nodeId}' 当前处于离线状态`);
      }

      // 1.4 项目状态
      if (c.projectStatus === "tombstone") {
        hardSatisfied = false;
        c.unsatisfiedConstraints.push(`目标项目已被注销 (Tombstone)`);
      }

      // 1.5 必需 MCP 能力检查
      for (const reqCap of intent.requiredCapabilities) {
        if (reqCap.startsWith("mcp:")) {
          const serverName = reqCap.replace("mcp:", "");
          const mcpEvidence = c.evidences.find(
            (e) => e.sourceType === "mcp_catalog" && e.referenceId.includes(serverName)
          );
          if (!mcpEvidence) {
            c.requiredMCPAvailable = false;
            hardSatisfied = false;
            c.unsatisfiedConstraints.push(`目标节点缺少必需 MCP: '${serverName}'`);
          } else if (mcpEvidence.summary.includes("needs_auth")) {
            c.requiredMCPAvailable = false;
            hardSatisfied = false;
            c.blockedReason = `目标节点 MCP '${serverName}' 需要用户完成授权认证 (needs_auth)`;
            c.unsatisfiedConstraints.push(c.blockedReason);
          }
        }
      }

      // 1.6 沙箱隔离能力硬约束检查
      const isReadOnly =
        Boolean(intent.constraints.readOnly) ||
        intent.operation === "inspect" ||
        intent.operation === "research";
      const requestedFsMode =
        intent.constraints.requiredPolicy?.filesystem ??
        (isReadOnly ? "read-only" : "workspace-write");

      const sandboxEvidence = c.evidences.find(
        (e) => e.sourceType === "node_hardware" && e.referenceId.toLowerCase().includes("sandbox")
      );

      // 若任务需要受限写入 (workspace-write) 且未显式放行全权限
      if (requestedFsMode === "workspace-write" && !intent.constraints.allowSideEffects) {
        if (sandboxEvidence) {
          const summaryLower = sandboxEvidence.summary.toLowerCase();
          const isWindowsNative = summaryLower.includes("windows native") || summaryLower.includes("win32");
          const isVerified = summaryLower.includes("verified") && !summaryLower.includes("unverified");

          if (isWindowsNative && !isVerified) {
            hardSatisfied = false;
            c.unsatisfiedConstraints.push(
              `目标节点缺少已验证的沙箱文件系统写隔离能力 (Windows Native AppContainer 未就绪，受限执行需使用 WSL2)`
            );
            c.blockedReason = "目标节点缺少已验证的沙箱内核写隔离能力";
          }
        }
      }

      // 若任务明确要求网络隔离 (sandbox:network-deny)
      if (intent.requiredCapabilities.includes("sandbox:network-deny")) {
        if (sandboxEvidence) {
          const summaryLower = sandboxEvidence.summary.toLowerCase();
          const isWindowsNative = summaryLower.includes("windows native") || summaryLower.includes("win32");
          const isVerified = summaryLower.includes("verified") && !summaryLower.includes("unverified");

          if (isWindowsNative && !isVerified) {
            hardSatisfied = false;
            c.unsatisfiedConstraints.push(`目标节点缺少已验证的沙箱网络阻断能力`);
            c.blockedReason = "目标节点缺少已验证的沙箱网络阻断能力";
          }
        }
      }

      c.hardConstraintsSatisfied = hardSatisfied;

      // 2. 软偏好评分 (Soft Preferences)
      let finalScore = c.score;

      // 2.1 偏好节点加分
      if (intent.constraints.preferredNodeId && c.nodeId === intent.constraints.preferredNodeId) {
        finalScore += 0.5;
      }

      // 2.2 项目名称直接命中加分
      if (intent.projectHints.length > 0) {
        const nameLower = c.projectName.toLowerCase();
        for (const hint of intent.projectHints) {
          if (nameLower.includes(hint.toLowerCase())) {
            finalScore += 0.3;
          }
        }
      }

      // 2.3 依据事实置信度微调最终分 (避免不可靠或过期记忆高分虚高)
      finalScore = finalScore * (0.6 + 0.4 * c.confidence);

      // 2.4 沙箱隔离验证充分度偏好加权 (已验证安全沙箱享有优先评分)
      if (
        sandboxEvidence &&
        sandboxEvidence.summary.toLowerCase().includes("verified") &&
        !sandboxEvidence.summary.toLowerCase().includes("unverified")
      ) {
        finalScore += 0.2;
      }

      // 归一化得分
      c.score = Number(Math.min(1.0, Math.max(0.01, finalScore)).toFixed(2));
      scoredCandidates.push(c);
    }

    // 排序准则：
    // 1. 硬约束满足的排在前面
    // 2. 在线节点排在前面
    // 3. 用户偏好节点排在前面
    // 4. 得分 (score) 从高到低
    // 5. 置信度 (confidence) 从高到低
    scoredCandidates.sort((a, b) => {
      if (a.hardConstraintsSatisfied !== b.hardConstraintsSatisfied) {
        return a.hardConstraintsSatisfied ? -1 : 1;
      }
      if (a.nodeOnline !== b.nodeOnline) {
        return a.nodeOnline ? -1 : 1;
      }
      const aPref = intent.constraints.preferredNodeId && a.nodeId === intent.constraints.preferredNodeId;
      const bPref = intent.constraints.preferredNodeId && b.nodeId === intent.constraints.preferredNodeId;
      if (aPref !== bPref) {
        return aPref ? -1 : 1;
      }
      if (Math.abs(b.score - a.score) > 0.05) {
        return b.score - a.score;
      }
      return b.confidence - a.confidence;
    });

    return scoredCandidates;
  }
}
