/**
 * Task Intent Analyzer
 * 负责从用户自然语言输入中准确提取结构化任务意图与执行约束
 */

import type {
  TaskIntent,
  TaskOperationType,
  TaskConstraints,
} from "./types.js";

export interface IntentNodeMetadata {
  nodeId: string;
  name?: string;
  hostname?: string;
  platform?: string;
  capabilities?: readonly { name: string; details?: string }[];
}

export interface AnalyzedTaskIntent extends TaskIntent {
  // Undefined means no node target; an empty array means the requested target is unavailable.
  targetNodeIds?: string[];
}

const NODE_GROUPS = [
  { aliases: ["windows native", "win32", "windows"], platform: "win32", matches: (n: IntentNodeMetadata, text: string) => n.platform === "win32" },
  { aliases: ["macbook", "macos", "darwin", "mac", "苹果"], platform: "darwin", matches: (n: IntentNodeMetadata, text: string) => n.platform === "darwin" },
  { aliases: ["wsl2", "wsl"], platform: "linux", matches: (n: IntentNodeMetadata, text: string) => n.platform === "linux" && /wsl|subsystem/.test(text) },
  { aliases: ["tencent", "cloud", "server", "腾讯云", "云端", "服务器"], platform: "linux", matches: (n: IntentNodeMetadata, text: string) => n.platform === "linux" && /tencent|cloud|server|腾讯|云端|服务器/.test(text) },
  { aliases: ["linux"], platform: "linux", matches: (n: IntentNodeMetadata, text: string) => n.platform === "linux" },
] as const;

// 常见项目关键词映射（仅覆盖本产品自身的公开项目名；其他项目由用户注册目录参与匹配）
const PROJECT_HINTS_KEYWORDS: Record<string, string[]> = {
  "nash-agent": ["nash", "agent", "沙箱", "sandbox", "agentloop", "harness", "nash-agents"],
  "nash-cluster": ["cluster", "coordinator", "集群", "部署", "nash-cluster"],
};

export class TaskIntentAnalyzer {
  /**
   * 分析用户自然语言请求并生成规范 TaskIntent
   */
  analyze(userInput: string, explicitConstraints?: TaskConstraints, nodes: readonly IntentNodeMetadata[] = []): AnalyzedTaskIntent {
    const raw = userInput.trim();
    const lower = raw.toLowerCase();

    // 1. 判断操作类型 (Operation Type)
    const operation = this.detectOperation(lower);

    // 2. 提取节点线索 (Node Hints) 与硬约束判定
    const { nodeHints, explicitNodeId, preferredNodeId, preferredPlatform, targetNodeIds } = this.extractNodeHints(raw, lower, nodes);

    // 3. 提取项目线索 (Project Hints)
    const projectHints = this.extractProjectHints(raw, lower);

    // 4. 提取能力需求 (Capability Hints)
    const { capabilityHints, requiredCapabilities, preferredCapabilities } =
      this.extractCapabilityHints(lower);

    // 5. 提取用户约束 (Constraints)
    const constraints: TaskConstraints = {
      ...explicitConstraints,
    };

    if (explicitNodeId && !constraints.explicitNodeId) {
      constraints.explicitNodeId = explicitNodeId;
    }
    if (preferredNodeId && !constraints.preferredNodeId) {
      constraints.preferredNodeId = preferredNodeId;
    }
    if (preferredPlatform && !constraints.preferredPlatform) {
      constraints.preferredPlatform = preferredPlatform;
    }

    // 只读硬约束识别
    const isExplicitReadOnly =
      lower.includes("只读") ||
      lower.includes("不要修改") ||
      lower.includes("禁止修改") ||
      lower.includes("read-only") ||
      lower.includes("readonly") ||
      (operation === "inspect" && !lower.includes("修复") && !lower.includes("修改"));

    if (isExplicitReadOnly) {
      constraints.readOnly = true;
    }

    // 6. 识别潜在歧义与风险提示
    const ambiguities: string[] = [];
    if (projectHints.length > 1) {
      ambiguities.push(`检测到多个可能相关的候选项目: ${projectHints.join(", ")}`);
    }
    if (nodeHints.length > 1 && !constraints.explicitNodeId) {
      ambiguities.push(`提及了多个节点线索: ${nodeHints.join(", ")}`);
    }

    const riskHints: string[] = [];
    if (operation === "deploy") {
      riskHints.push("任务涉及部署与线上服务状态变更，属于高风险操作");
    }
    if (operation === "fix" && !constraints.readOnly) {
      riskHints.push("任务涉及代码或文件修改，需要在目标沙箱安全策略内执行");
    }

    // 7. 评估置信度
    let confidence = 0.8;
    if (projectHints.length === 1) confidence += 0.1;
    if (nodeHints.length === 1) confidence += 0.05;
    if (ambiguities.length > 0) confidence -= 0.15;

    return {
      originalRequest: raw,
      goal: this.refineGoal(raw, operation),
      operation,
      projectHints,
      nodeHints,
      targetNodeIds: constraints.explicitNodeId ? [constraints.explicitNodeId] : targetNodeIds,
      capabilityHints,
      requiredCapabilities,
      preferredCapabilities,
      constraints,
      ambiguities,
      riskHints,
      confidence: Math.max(0.2, Math.min(1.0, Number(confidence.toFixed(2)))),
    };
  }

  private detectOperation(lower: string): TaskOperationType {
    const hasNegativeModification =
      lower.includes("不要修改") ||
      lower.includes("不用修改") ||
      lower.includes("禁止修改") ||
      lower.includes("无需修改") ||
      lower.includes("不改动");

    if (
      !hasNegativeModification &&
      (lower.includes("修复") || lower.includes("fix") || lower.includes("修改") || lower.includes("重构"))
    ) {
      return "fix";
    }
    if (lower.includes("测试") || lower.includes("test") || lower.includes("验证") || lower.includes("verify")) {
      return "test";
    }
    if (lower.includes("部署") || lower.includes("deploy") || lower.includes("发布") || lower.includes("上线")) {
      return "deploy";
    }
    if (lower.includes("环境") || lower.includes("cuda") || lower.includes("pytorch") || lower.includes("python环境")) {
      return "environment_check";
    }
    if (lower.includes("安装") || lower.includes("install") || lower.includes("配置") || lower.includes("setup")) {
      return "setup";
    }
    if (lower.includes("调研") || lower.includes("研究") || lower.includes("research") || lower.includes("查明")) {
      return "research";
    }
    if (lower.includes("检查") || lower.includes("查看") || lower.includes("check") || lower.includes("inspect") || lower.includes("看下")) {
      return "inspect";
    }
    return "general";
  }

  private isNegatedAlias(lower: string, alias: string): boolean {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const negRegex = new RegExp(
      `(?:不|不要|禁止|无需|不用|(?<!分)别|切勿|not\\s+|without\\s+)(?:访问|使用|调用|去|在|检查|修改|连接|触碰|动)?\\s*${escaped}`,
      "i"
    );
    return negRegex.test(lower);
  }

  private extractNodeHints(raw: string, lower: string, nodes: readonly IntentNodeMetadata[]): {
    nodeHints: string[];
    explicitNodeId?: string;
    preferredNodeId?: string;
    preferredPlatform?: "darwin" | "linux" | "win32";
    targetNodeIds?: string[];
  } {
    const containsAlias = (alias: string): boolean => {
      if (this.isNegatedAlias(lower, alias)) return false;
      if (/^[a-z0-9 ]+$/.test(alias)) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(lower);
      }
      return lower.includes(alias);
    };
    const groups = NODE_GROUPS.filter(group => group.aliases.some(containsAlias));
    const direct = nodes.filter(node => {
      const escaped = node.nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, "i").test(raw) && !this.isNegatedAlias(lower, node.nodeId.toLowerCase());
    });
    const targetNodes = direct.length ? direct : nodes.filter(node => {
      const text = [node.nodeId, node.name, node.hostname, ...(node.capabilities ?? []).map(cap => `${cap.name} ${cap.details ?? ""}`)].filter(Boolean).join(" ").toLowerCase();
      return groups.some(group => group.matches(node, text));
    });
    const hasTarget = direct.length > 0 || groups.length > 0;
    const platforms = new Set(groups.map(group => group.platform).filter(Boolean));
    const platform = platforms.size === 1 ? [...platforms][0] : undefined;
    const preferred = /(?:最好|优先|建议)在/.test(raw);
    const uniqueNodeId = targetNodes.length === 1 ? targetNodes[0]!.nodeId : undefined;
    return {
      nodeHints: direct.length ? direct.map(node => node.nodeId) : groups.map(group => group.aliases[0]),
      ...(preferred ? { preferredNodeId: uniqueNodeId } : { explicitNodeId: uniqueNodeId }),
      preferredPlatform: platform,
      targetNodeIds: hasTarget ? targetNodes.map(node => node.nodeId) : undefined,
    };
  }

  private extractProjectHints(raw: string, lower: string): string[] {
    const hints = new Set<string>();

    for (const [projectKey, keywords] of Object.entries(PROJECT_HINTS_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) {
          hints.add(projectKey);
          break;
        }
      }
    }

    return Array.from(hints);
  }

  private extractCapabilityHints(lower: string): {
    capabilityHints: string[];
    requiredCapabilities: string[];
    preferredCapabilities: string[];
  } {
    const capabilityHints: string[] = [];
    const requiredCapabilities: string[] = [];
    const preferredCapabilities: string[] = [];

    if (lower.includes("mcp") || lower.includes("bilibili") || lower.includes("b站")) {
      capabilityHints.push("mcp");
      if (lower.includes("bilibili") || lower.includes("b站") || lower.includes("字幕提取")) {
        requiredCapabilities.push("mcp:bilibili-subtitles");
      }
    }

    if (lower.includes("cuda") || lower.includes("gpu")) {
      capabilityHints.push("hardware:gpu");
      requiredCapabilities.push("cuda");
    }

    if (lower.includes("pytorch") || lower.includes("torch")) {
      capabilityHints.push("runtime:pytorch");
      requiredCapabilities.push("pytorch");
    }

    if (lower.includes("python")) {
      capabilityHints.push("runtime:python");
      preferredCapabilities.push("python3");
    }

    if (lower.includes("node") || lower.includes("npm") || lower.includes("typescript")) {
      capabilityHints.push("runtime:nodejs");
      preferredCapabilities.push("nodejs");
    }

    if (lower.includes("sherpa") || lower.includes("asr")) {
      capabilityHints.push("capability:asr");
      preferredCapabilities.push("sherpa-onnx");
    }

    return {
      capabilityHints,
      requiredCapabilities,
      preferredCapabilities,
    };
  }

  private refineGoal(raw: string, operation: TaskOperationType): string {
    // 保持用户原始意图，杜绝篡改
    return raw;
  }
}
