import type { AgentRecord } from "../agent/types.js";
import type { TeamMemberConfig } from "./types.js";
import { TeamMemberNotFoundError, TeamMemberAlreadyExistsError } from "./errors.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { ConcurrencyController } from "../concurrency/concurrency-controller.js";

/**
 * 团队成员详细信息
 */
export interface RosterMember {
  agentId: string;
  name: string;
  role: string;
  roleDescription: string;
  systemPrompt?: string;
  writeScopes?: string[];
  worktreePath?: string;
  joinedAt: number;
}

/**
 * 团队花名册 (Roster) - 管理 Team 的成员配置与在线状态索引
 */
export class Roster {
  private readonly members = new Map<string, RosterMember>();
  private readonly agentRegistry: AgentRegistry;
  private readonly concurrencyController: ConcurrencyController;

  constructor(
    agentRegistry: AgentRegistry,
    concurrencyController: ConcurrencyController
  ) {
    this.agentRegistry = agentRegistry;
    this.concurrencyController = concurrencyController;
  }

  /**
   * 向团队花名册中添加新成员
   */
  addMember(config: TeamMemberConfig, leaderId?: string): RosterMember {
    const agentId = config.agentId ?? `member-${config.name.toLowerCase().replace(/\s+/g, "-")}`;
    if (this.members.has(agentId)) {
      throw new TeamMemberAlreadyExistsError(agentId);
    }

    // 校验团队成员容量上限与总 Agent 数限制
    this.concurrencyController.registerTeamMember();
    this.concurrencyController.registerAgentSpawn(1, leaderId);

    // 在 AgentRegistry 中注册对应 AgentRecord (新加入成员初始状态为 ready)
    this.agentRegistry.register({
      agentId,
      name: config.name,
      parentAgentId: leaderId,
      type: "team-member",
      status: "ready",
      depth: 1,
      role: config.role,
      roleDescription: config.roleDescription,
      worktreePath: config.worktreePath,
    });

    const member: RosterMember = {
      agentId,
      name: config.name,
      role: config.role,
      roleDescription: config.roleDescription,
      systemPrompt: config.systemPrompt,
      writeScopes: config.writeScopes ? [...config.writeScopes] : undefined,
      worktreePath: config.worktreePath,
      joinedAt: Date.now(),
    };

    this.members.set(agentId, member);
    return { ...member };
  }

  /**
   * 移除团队成员
   */
  removeMember(agentId: string): void {
    if (!this.members.has(agentId)) {
      throw new TeamMemberNotFoundError(agentId);
    }
    this.members.delete(agentId);
    this.concurrencyController.unregisterTeamMember();
    this.agentRegistry.updateStatus(agentId, "completed");
  }

  getMember(agentId: string): RosterMember | undefined {
    const member = this.members.get(agentId);
    return member ? { ...member } : undefined;
  }

  requireMember(agentId: string): RosterMember {
    const member = this.members.get(agentId);
    if (!member) {
      throw new TeamMemberNotFoundError(agentId);
    }
    return { ...member };
  }

  getMembers(): RosterMember[] {
    return Array.from(this.members.values()).map((m) => ({ ...m }));
  }

  hasMember(agentId: string): boolean {
    return this.members.has(agentId);
  }

  getMemberCount(): number {
    return this.members.size;
  }
}
