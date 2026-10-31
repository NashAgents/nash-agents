/**
 * Agent Team 强类型错误体系
 */

export class TeamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "TeamError";
    this.code = code;
  }
}

export class TeamNotFoundError extends TeamError {
  readonly teamId: string;

  constructor(teamId: string) {
    super("TEAM_NOT_FOUND", `未找到 ID 为 '${teamId}' 的 Agent Team。`);
    this.name = "TeamNotFoundError";
    this.teamId = teamId;
  }
}

export class TeamMemberNotFoundError extends TeamError {
  readonly agentId: string;

  constructor(agentId: string) {
    super("TEAM_MEMBER_NOT_FOUND", `在团队中未找到成员 Agent '${agentId}'。`);
    this.name = "TeamMemberNotFoundError";
    this.agentId = agentId;
  }
}

export class TeamMemberAlreadyExistsError extends TeamError {
  readonly agentId: string;

  constructor(agentId: string) {
    super(
      "TEAM_MEMBER_ALREADY_EXISTS",
      `团队成员 Agent '${agentId}' 已经存在于团队中。`
    );
    this.name = "TeamMemberAlreadyExistsError";
    this.agentId = agentId;
  }
}
