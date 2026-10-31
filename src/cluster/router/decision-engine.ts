/**
 * Routing Decision Engine
 * 负责依据 TaskIntent 与候选排序生成最终结构化路由决策
 * 支持确定性推导与 Coordinator AgentLoop 深层语义推理双模驱动
 */

import * as crypto from "node:crypto";
import type {
  TaskIntent,
  RoutingCandidate,
  RoutingDecision,
  RoutingDecisionType,
  MultiNodeSubTask,
} from "./types.js";

export class RoutingDecisionEngine {
  /**
   * 基于意图与候选排序生成结构化决策
   */
  decide(intent: TaskIntent, rankedCandidates: RoutingCandidate[]): RoutingDecision {
    const decisionId = `dec-${crypto.randomUUID().slice(0, 10)}`;
    const now = Date.now();

    // 1. 检查是否存在跨节点多能力复合需求
    const multiNodeCheck = this.detectMultiNodeRequirement(intent, rankedCandidates);
    if (multiNodeCheck.isMultiNode) {
      return {
        decisionId,
        decisionType: "MULTI_NODE_REQUIRED",
        intent,
        alternativeCandidates: rankedCandidates,
        reason: "任务需要跨节点协同执行，涉及分布在不同物理节点上的独特能力与项目",
        explanation: {
          whyAlternativesRejected: [],
          evidencesUsed: ["Multi-node capability detection"],
          hardConstraintsChecked: ["cross_node_dependencies"],
        },
        multiNodePlan: multiNodeCheck.plan,
        createdAt: now,
      };
    }

    // 2. 候选为空检查
    if (rankedCandidates.length === 0) {
      return {
        decisionId,
        decisionType: "NO_CANDIDATE",
        intent,
        alternativeCandidates: [],
        reason: `在集群 Catalog 与联邦记忆中未检索到与目标 "${intent.goal}" 匹配的项目或节点`,
        explanation: {
          whyAlternativesRejected: [],
          evidencesUsed: ["Cluster catalog search returned 0 items"],
          hardConstraintsChecked: [],
        },
        createdAt: now,
      };
    }

    // 筛选硬约束满足的有效候选
    const validCandidates = rankedCandidates.filter((c) => c.hardConstraintsSatisfied);

    // 3. 检查阻塞情况 (如 MCP 需要授权认证)
    const blockedCandidate = rankedCandidates.find((c) => c.blockedReason);
    if (validCandidates.length === 0 && blockedCandidate) {
      return {
        decisionId,
        decisionType: "BLOCKED",
        intent,
        selectedCandidate: blockedCandidate,
        alternativeCandidates: rankedCandidates,
        reason: blockedCandidate.blockedReason ?? "目标执行依赖的能力未就绪",
        blockedReason: blockedCandidate.blockedReason,
        explanation: {
          whyAlternativesRejected: [],
          evidencesUsed: blockedCandidate.evidences.map((e) => e.summary),
          hardConstraintsChecked: ["mcp_auth_state"],
        },
        createdAt: now,
      };
    }

    // 4. 检查节点离线情况 (DEFERRED)
    if (validCandidates.length === 0) {
      const offlineCandidates = rankedCandidates.filter(
        (c) =>
          !c.nodeOnline &&
          c.unsatisfiedConstraints.every((r) => r.includes("离线") || r.includes("offline"))
      );
      if (offlineCandidates.length > 0) {
        const topOffline = offlineCandidates[0]!;
        return {
          decisionId,
          decisionType: "DEFERRED",
          intent,
          selectedCandidate: topOffline,
          alternativeCandidates: rankedCandidates,
          reason: `匹配到的目标项目位于节点 '${topOffline.nodeId}'，但该节点当前处于离线状态，等待重新上线`,
          explanation: {
            selectedNodeReason: `Node ${topOffline.nodeId} holds target project ${topOffline.projectId}`,
            whyAlternativesRejected: rankedCandidates
              .filter((c) => c !== topOffline)
              .map((c) => ({
                nodeId: c.nodeId,
                projectId: c.projectId,
                reason: c.unsatisfiedConstraints.join("; ") || `Score lower (${c.score})`,
              })),
            evidencesUsed: topOffline.evidences.map((e) => e.summary),
            hardConstraintsChecked: ["node_online"],
          },
          createdAt: now,
        };
      }

      // 所有候选均因其他硬约束不满足
      return {
        decisionId,
        decisionType: "NO_CANDIDATE",
        intent,
        alternativeCandidates: rankedCandidates,
        reason: `检索到候选资源，但均未能满足执行硬约束条件：\n${rankedCandidates
          .map((c) => `• [${c.nodeId} / ${c.projectId}]: ${c.unsatisfiedConstraints.join(", ")}`)
          .join("\n")}`,
        explanation: {
          whyAlternativesRejected: rankedCandidates.map((c) => ({
            nodeId: c.nodeId,
            projectId: c.projectId,
            reason: c.unsatisfiedConstraints.join("; "),
          })),
          evidencesUsed: [],
          hardConstraintsChecked: ["explicit_constraints", "node_online", "project_status"],
        },
        createdAt: now,
      };
    }

    // 5. 候选歧义检查 (CLARIFICATION_REQUIRED)
    // 当存在多个满足硬约束的候选，且前两名得分非常接近 (差值 <= 0.15) 且不是用户显式指定或明确偏好节点/项目时
    if (
      validCandidates.length >= 2 &&
      !intent.constraints.explicitNodeId &&
      !intent.constraints.explicitProjectId &&
      (!intent.constraints.preferredNodeId || validCandidates[0]!.nodeId !== intent.constraints.preferredNodeId)
    ) {
      const first = validCandidates[0]!;
      const second = validCandidates[1]!;

      const scoreDiff = Math.abs(first.score - second.score);
      // 若操作涉及修改(fix)或前两名得分极其接近，触发澄清以确保安全
      const isSensitiveOp = intent.operation === "fix" || intent.operation === "deploy";
      if (scoreDiff <= 0.15 || (isSensitiveOp && scoreDiff <= 0.25)) {
        return {
          decisionId,
          decisionType: "CLARIFICATION_REQUIRED",
          intent,
          alternativeCandidates: validCandidates,
          reason: `发现 ${validCandidates.length} 个相关度接近的候选项目，需要用户确认执行目标`,
          clarificationPrompt: `检索到多个可能相符的项目，请选择您希望在哪个项目上执行任务：`,
          clarificationOptions: validCandidates.slice(0, 4).map((c, idx) => ({
            optionId: `opt-${idx + 1}`,
            label: `${c.projectName} (${c.nodeId.replace(/^node-/, "").slice(0, 10)})`,
            nodeId: c.nodeId,
            projectId: c.projectId,
            description: c.projectSummary || c.projectName,
          })),
          explanation: {
            whyAlternativesRejected: [],
            evidencesUsed: validCandidates.flatMap((c) => c.evidences.map((e) => e.summary)),
            hardConstraintsChecked: ["ambiguity_threshold_0.15"],
          },
          createdAt: now,
        };
      }
    }

    // 6. 确定性派发决策 (DISPATCH)
    const bestCandidate = validCandidates[0]!;
    const otherCandidates = validCandidates.slice(1);

    const evidencesUsed = bestCandidate.evidences.map(
      (e) => `[${e.sourceType}] ${e.summary} (confidence: ${e.confidence})`
    );

    return {
      decisionId,
      decisionType: "DISPATCH",
      intent,
      selectedCandidate: bestCandidate,
      alternativeCandidates: otherCandidates,
      reason: `匹配到最佳目标项目 '${bestCandidate.projectName}' (位于节点 ${bestCandidate.nodeId})，综合得分 ${bestCandidate.score}`,
      explanation: {
        selectedNodeReason: `节点在线且具备相应项目环境与依赖能力`,
        selectedProjectReason: `项目元数据与长期记忆均高度匹配当前任务目标: ${bestCandidate.projectSummary}`,
        whyAlternativesRejected: otherCandidates.map((c) => ({
          nodeId: c.nodeId,
          projectId: c.projectId,
          reason: `匹配得分 (${c.score}) 低于最佳候选 (${bestCandidate.score})`,
        })),
        evidencesUsed,
        hardConstraintsChecked: [
          "node_online",
          "project_registered",
          "not_tombstone",
          "capabilities_verified",
        ],
      },
      createdAt: now,
    };
  }

  /**
   * 检测是否属于跨节点多任务依赖
   */
  private detectMultiNodeRequirement(
    intent: TaskIntent,
    candidates: RoutingCandidate[]
  ): { isMultiNode: boolean; plan?: RoutingDecision["multiNodePlan"] } {
    const raw = intent.originalRequest.toLowerCase();

    // 检测多动作跨节点连接词
    const hasCrossMarkers =
      (raw.includes("提取") || raw.includes("获取") || raw.includes("下载")) &&
      (raw.includes("导入") || raw.includes("同步") || raw.includes("放入") || raw.includes("写入"));

    if (!hasCrossMarkers) {
      return { isMultiNode: false };
    }

    // 检查能力分布：Bilibili MCP 与 英语阅读器 项目是否分别位于不同节点
    // 注意：必须排除 needs_auth 的未授权能力，找到真实可用的 MCP 节点
    const b站Candidate = candidates.find((c) =>
      c.evidences.some(
        (e) =>
          e.sourceType === "mcp_catalog" &&
          (e.referenceId.includes("bilibili") || e.summary.includes("bilibili")) &&
          !e.summary.includes("needs_auth")
      )
    );
    const readerCandidate = candidates.find((c) =>
      /阅读|reader|subtitle|字幕/i.test(`${c.projectId} ${c.projectName} ${c.projectSummary}`)
    );

    if (b站Candidate && readerCandidate && b站Candidate.nodeId !== readerCandidate.nodeId) {
      const subTasks: MultiNodeSubTask[] = [
        {
          subTaskId: "sub-1-fetch-subtitles",
          nodeId: b站Candidate.nodeId,
          projectId: b站Candidate.projectId,
          goal: "使用 Bilibili MCP 提取目标视频字幕内容并生成规范中间产物",
          requiredCapabilities: ["mcp:bilibili-subtitles"],
          dependencies: [],
        },
        {
          subTaskId: "sub-2-import-reader",
          nodeId: readerCandidate.nodeId,
          projectId: readerCandidate.projectId,
          goal: "将前序提取的字幕导入文章阅读器并建立时间轴索引",
          requiredCapabilities: ["Audio Playback", "Subtitle Highlighting"],
          dependencies: ["sub-1-fetch-subtitles"],
        },
      ];

      return {
        isMultiNode: true,
        plan: {
          summary: `检测到跨节点任务依赖：阶段 1 在 ${b站Candidate.nodeId} 提取字幕；阶段 2 在 ${readerCandidate.nodeId} 导入阅读器项目。`,
          subTasks,
          recommendedExecutionOrder: ["sub-1-fetch-subtitles", "sub-2-import-reader"],
        },
      };
    }

    return { isMultiNode: false };
  }
}
