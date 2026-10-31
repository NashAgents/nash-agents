/**
 * Project Explorer 专用辅助函数
 * 负责友好节点名称映射、技术栈归一化、项目状态与图标推断
 */

export interface FriendlyNodeInfo {
  friendlyName: string;
  platformIcon: string;
  badgeClass: string;
}

/**
 * 将长串 Node ID 转换为人机友好的短名称
 */
export function getFriendlyNodeName(nodeId: string, nodeHostname?: string): string {
  const lower = (nodeId + " " + (nodeHostname || "")).toLowerCase();
  if (lower.includes("mac") || lower.includes("darwin") || lower.includes("apple")) {
    return "macOS Node";
  }
  if (lower.includes("tencent") || lower.includes("cloud")) {
    return "Cloud Linux Node";
  }
  if (lower.includes("wsl") || lower.includes("subsystem")) {
    return "WSL2 Linux";
  }
  if (lower.includes("win32") || lower.includes("windows")) {
    return "Windows Node";
  }
  if (lower.includes("linux")) {
    return "Linux Node";
  }
  // 兜底：截取前 8 位
  if (nodeId.length > 12) {
    return nodeId.slice(0, 8);
  }
  return nodeId;
}

/**
 * 推断项目注册与执行安全状态
 */
export type ProjectSecurityStatus = "registered" | "discovered" | "offline" | "archived";

export function getProjectStatus(project: any, isNodeOnline = true): {
  status: ProjectSecurityStatus;
  label: string;
  badgeClass: string;
  canExecuteDirectly: boolean;
} {
  if (!isNodeOnline) {
    return {
      status: "offline",
      label: "节点离线",
      badgeClass: "bg-surface-800 text-surface-400 border border-surface-700",
      canExecuteDirectly: false,
    };
  }

  const pId = project.projectId || "";
  // 如果明确是自动发现候选，或带有 discovered 标识且未在正式白名单
  if (project.visibility === "discovered" || pId.startsWith("discovered-") || project.status === "discovered") {
    return {
      status: "discovered",
      label: "自动发现 · 待授权",
      badgeClass: "bg-amber-500/10 text-amber-400 border border-amber-500/30",
      canExecuteDirectly: false,
    };
  }

  if (project.status === "archived") {
    return {
      status: "archived",
      label: "已归档",
      badgeClass: "bg-surface-800 text-surface-400 border border-surface-700",
      canExecuteDirectly: false,
    };
  }

  return {
    status: "registered",
    label: "已注册",
    badgeClass: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30",
    canExecuteDirectly: true,
  };
}

/**
 * 基于技术栈和项目特征推断主类别图标名称
 */
export function getProjectIconType(project: any): "agent" | "web" | "desktop" | "python" | "code" {
  const techs = (project.technologies || []).map((t: string) => t.toLowerCase());
  const name = (project.name || "").toLowerCase();
  const summary = (project.summary || project.description || "").toLowerCase();

  if (techs.includes("electron") || name.includes("reader") || summary.includes("桌面")) {
    return "desktop";
  }
  if (techs.includes("python") || techs.includes("pytorch") || name.includes("crawler") || summary.includes("爬虫")) {
    return "python";
  }
  if (techs.includes("vue") || techs.includes("react") || techs.includes("web") || techs.includes("tailwind")) {
    return "web";
  }
  if (name.includes("agent") || summary.includes("agent") || summary.includes("harness") || techs.includes("agent")) {
    return "agent";
  }
  return "code";
}
