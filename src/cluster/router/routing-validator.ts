import { validateSandboxRequirements } from "../protocol/sandbox-requirements.js";
/**
 * Routing Validator
 * 确定性安全验证层 (Deterministic Safety Boundary)
 * 严格阻断未经验证的 LLM 提议、过期索引欺骗、离线虚假派发与越界绝对路径
 */

import type { IClusterStore } from "../storage/cluster-store.js";
import type { NodeRegistry } from "../coordinator/node-registry.js";
import type {
  RoutingDecision,
  RoutingCandidate,
  RoutingValidationResult,
  TaskIntent,
} from "./types.js";

export interface RoutingValidatorOptions {
  store: IClusterStore;
  registry: NodeRegistry;
}

export class RoutingValidator {
  constructor(
    private readonly store: IClusterStore,
    private readonly registry?: Pick<NodeRegistry, "getConnection">
  ) {}

  /**
   * 对路由决策进行确定性安全校验
   */
  async validate(
    decision: RoutingDecision,
    intent: TaskIntent
  ): Promise<RoutingValidationResult> {
    if (decision.decisionType !== "DISPATCH" || !decision.selectedCandidate) {
      // 非派发类决策（如澄清、阻塞等），直接通过自身语义状态
      return {
        valid: true,
        code: "VALID",
        reason: `Decision type is '${decision.decisionType}', no immediate dispatch target required.`,
      };
    }

    const candidate = decision.selectedCandidate;
    return this.validateCandidate(candidate, intent);
  }

  /**
   * 独立校验单个候选目标
   */
  async validateCandidate(
    candidate: RoutingCandidate | Pick<RoutingCandidate, "nodeId" | "projectId">,
    intent: TaskIntent | Pick<TaskIntent, "constraints" | "requiredCapabilities">
  ): Promise<RoutingValidationResult> {
    const { nodeId, projectId } = candidate;

    // 1. 验证 Node ID 是否存在
    const node = await this.store.getNode(nodeId);
    if (!node) {
      return {
        valid: false,
        code: "NODE_NOT_FOUND",
        reason: `Target node '${nodeId}' does not exist in cluster registry.`,
      };
    }

    // 2. 验证目标节点当前物理在线状态 (WebSocket 连接活跃)
    const conn = this.registry?.getConnection(nodeId);
    if (node.status !== "online" || (this.registry && (!conn || conn.ws.readyState !== 1))) {
      return {
        valid: false,
        code: "NODE_OFFLINE",
        reason: `Target node '${nodeId}' (${node.name}) is currently offline. Cannot dispatch task.`,
      };
    }

    // 3. 验证项目是否存在于 Catalog 且未被标记为注销 (Tombstone)
    const catalogProjects = await this.store.listProjectsCatalog({ nodeId });
    const project = catalogProjects.find((p) => p.projectId === projectId);

    if (!project || projectId.startsWith("discovered-")) {
      // 检查是否被墓碑拦截
      const tombstones = await this.store.listTombstones?.(nodeId);
      const isTombstoned = (tombstones ?? []).some(
        (t) => t.resourceType === "project" && t.resourceId === projectId
      );

      if (isTombstoned) {
        return {
          valid: false,
          code: "PROJECT_TOMBSTONE",
          reason: `Target project '${projectId}' on node '${nodeId}' has been revoked/deleted (Tombstone recorded).`,
        };
      }

      return {
        valid: false,
        code: "PROJECT_NOT_FOUND",
        reason: `Target project '${projectId}' is not registered on node '${nodeId}'. Arbitrary paths are strictly forbidden.`,
      };
    }

    if (project.status !== "active") {
      return {
        valid: false,
        code: "PROJECT_TOMBSTONE",
        reason: `Target project '${projectId}' on node '${nodeId}' status is '${project.status}', not active.`,
      };
    }

    // 4. 验证项目访问权限 (visibility)
    if (project.visibility === "not_published") {
      return {
        valid: false,
        code: "PROJECT_ACCESS_DENIED",
        reason: `Target project '${projectId}' visibility is 'not_published'. Execution is denied.`,
      };
    }

    // 5. 校验用户显式硬约束
    if (intent.constraints.explicitNodeId && intent.constraints.explicitNodeId !== nodeId) {
      return {
        valid: false,
        code: "HARD_CONSTRAINT_VIOLATED",
        reason: `Hard constraint violation: user explicitly pinned node to '${intent.constraints.explicitNodeId}', but proposal targeted '${nodeId}'.`,
      };
    }

    if (intent.constraints.explicitProjectId && intent.constraints.explicitProjectId !== projectId) {
      return {
        valid: false,
        code: "HARD_CONSTRAINT_VIOLATED",
        reason: `Hard constraint violation: user explicitly pinned project to '${intent.constraints.explicitProjectId}', but proposal targeted '${projectId}'.`,
      };
    }

    // 6. 验证必需 MCP、Skill 与节点硬件/运行时能力是否就绪
    const catRevForCaps = await this.store.getCatalogRevision(nodeId);
    const nodeHwCaps = catRevForCaps?.capabilities ?? [];
    for (const reqCap of intent.requiredCapabilities) {
      if (reqCap.startsWith("mcp:")) {
        const serverName = reqCap.replace("mcp:", "");
        const mcpServers = await this.store.listMCPCatalog({ nodeId });
        const mcp = mcpServers.find((m) => m.serverId === serverName || m.displayName === serverName);

        if (!mcp) {
          return {
            valid: false,
            code: "CAPABILITY_UNVERIFIED",
            reason: `Required MCP capability '${serverName}' is not installed or detected on node '${nodeId}'.`,
          };
        }

        if (mcp.status === "needs_auth") {
          return {
            valid: false,
            code: "CAPABILITY_NEEDS_AUTH",
            reason: `MCP capability '${serverName}' on node '${nodeId}' requires authentication before use.`,
          };
        }

        if (mcp.status !== "available") {
          return {
            valid: false,
            code: "CAPABILITY_UNVERIFIED",
            reason: `MCP capability '${serverName}' on node '${nodeId}' is in '${mcp.status}' state, not available.`,
          };
        }
      } else if (reqCap.startsWith("skill:")) {
        const skillName = reqCap.replace("skill:", "").toLowerCase();
        const skills = await this.store.listSkillsCatalog({ nodeId });
        const matchedSkill = skills.find(
          (s) => s.skillId.toLowerCase() === skillName || s.name.toLowerCase() === skillName
        );
        if (!matchedSkill) {
          return {
            valid: false,
            code: "CAPABILITY_UNVERIFIED",
            reason: `Required skill '${skillName}' is not registered on node '${nodeId}'.`,
          };
        }
      } else if (!reqCap.startsWith("sandbox:")) {
        const cleanCap = reqCap.replace(/^(?:hardware|runtime|capability):/i, "").toLowerCase();
        const sandbox = nodeHwCaps.find((c) => c.category === "sandbox");
        const backend = sandbox?.structuredDetails?.backend;
        const backendNames: Record<string, string> = { bwrap: "bubblewrap", bubblewrap: "bubblewrap", seatbelt: "seatbelt", appcontainer: "windows-sandbox" };
        if (backendNames[cleanCap]) {
          if (sandbox?.status !== "verified" || backend !== backendNames[cleanCap]) {
            return { valid: false, code: "CAPABILITY_UNVERIFIED", reason: `Required backend '${reqCap}' is not verified on ${nodeId} (${node.platform}/${backend ?? "unknown"})` };
          }
          continue;
        }
        if (["filesystem-read", "filesystem-write", "sandbox"].includes(cleanCap) && sandbox?.status === "verified") continue;
        if (nodeHwCaps.some((c) => c.name === `tool:${cleanCap}` && c.status === "available")) continue;
        const normalize = (name: string) => name.toLowerCase().replace(/runtime|[^a-z0-9]/g, "");
        const aliases: Record<string, string> = { node: "nodejs", python3: "python", pwsh: "powershell" };
        const explicitHw = nodeHwCaps.find(
          (c) =>
            normalize(c.name) === (aliases[cleanCap] ?? normalize(cleanCap)) ||
            c.category.toLowerCase() === cleanCap
        );
        if (explicitHw) {
          if (!["verified", "available"].includes(explicitHw.status)) {
            return {
              valid: false,
              code: "CAPABILITY_UNVERIFIED",
              reason: `Required capability '${reqCap}' on node '${nodeId}' is reported as unavailable.`,
            };
          }
          if ((explicitHw.status as string) === "needs_auth") {
            return {
              valid: false,
              code: "CAPABILITY_NEEDS_AUTH",
              reason: `Required capability '${reqCap}' on node '${nodeId}' requires authentication.`,
            };
          }
        } else {
            return {
              valid: false,
              code: "CAPABILITY_UNVERIFIED",
              reason: `Required capability '${reqCap}' is not verified on node '${nodeId}' or project '${projectId}'.`,
            };
        }
      }
    }

    // 7. 验证物理平台与路径互斥 (Platform Path Isolation)
    if (project.canonicalPath) {
      const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(project.canonicalPath);
      if (node.platform === "win32") {
        if (!isWindowsPath) {
          return {
            valid: false,
            code: "PLATFORM_PATH_MISMATCH",
            reason: `Target node '${nodeId}' is Windows (win32), but project path '${project.canonicalPath}' is not a valid Windows absolute path.`,
          };
        }
        // 拦截 Windows 保留设备名 (CON, PRN, AUX, NUL, COM*, LPT*)
        const baseName = project.canonicalPath.split(/[/\\]/).pop()?.toUpperCase() ?? "";
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/.test(baseName)) {
          return {
            valid: false,
            code: "PLATFORM_PATH_MISMATCH",
            reason: `Project path '${project.canonicalPath}' contains Windows reserved device name '${baseName}'.`,
          };
        }
      } else {
        // POSIX 平台 (Linux, macOS, WSL2)
        if (isWindowsPath) {
          return {
            valid: false,
            code: "PLATFORM_PATH_MISMATCH",
            reason: `Target node '${nodeId}' is ${node.platform}, but project path '${project.canonicalPath}' is a Windows drive path. Arbitrary cross-platform path mapping is strictly forbidden.`,
          };
        }
      }
    }

    // 8. 验证沙箱安全策略与能力兼容性 (Sandbox Policy Compatibility & Freshness)
    const catRev = await this.store.getCatalogRevision(nodeId);
    const sandboxCap = (catRev?.capabilities ?? []).find((c) => c.category === "sandbox");
    const details = sandboxCap?.structuredDetails;

    // 8.1 确定任务执行所需的沙箱策略
    const isReadOnly =
      Boolean(intent.constraints?.readOnly) ||
      (intent as any).operation === "inspect" ||
      (intent as any).operation === "research";
    const requestedFsMode =
      intent.constraints?.requiredPolicy?.filesystem ??
      (isReadOnly ? "read-only" : "workspace-write");
    const requestedNetMode =
      intent.constraints?.requiredPolicy?.network ??
      (intent.requiredCapabilities?.includes("sandbox:network-allow") ? "allow" : "deny");

    // 8.2 校验沙箱能力过期时间 (防陈旧 verified 状态)
    if (sandboxCap && sandboxCap.status === "verified") {
      const now = Date.now();
      const verifiedAt = sandboxCap.verifiedAt ?? sandboxCap.detectedAt;
      const expiresAt = details?.verificationExpiresAt ?? verifiedAt + 24 * 60 * 60 * 1000;
      if (now > expiresAt) {
        return {
          valid: false,
          code: "STALE_SANDBOX_CAPABILITY",
          reason: `Target node '${nodeId}' sandbox capability verification has expired. Re-verification required before dispatching restricted tasks.`,
        };
      }
    }

    const rejection = validateSandboxRequirements(node.platform, sandboxCap, requestedFsMode, requestedNetMode);
    if (rejection) return { valid: false, ...rejection };

    return {
      valid: true,
      code: "VALID",
      reason: `Deterministic safety validation passed for node '${nodeId}' and project '${projectId}'.`,
    };
  }
}
