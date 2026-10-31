/**
 * Agent 运行时错误体系
 */

export class AgentRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "AgentRuntimeError";
    this.code = code;
  }
}

export class AgentNotFoundError extends AgentRuntimeError {
  readonly agentId: string;

  constructor(agentId: string) {
    super("AGENT_NOT_FOUND", `未找到 ID 为 '${agentId}' 的 Agent 记录。`);
    this.name = "AgentNotFoundError";
    this.agentId = agentId;
  }
}

export class AgentAlreadyExistsError extends AgentRuntimeError {
  readonly agentId: string;

  constructor(agentId: string) {
    super("AGENT_ALREADY_EXISTS", `Agent ID '${agentId}' 已经存在。`);
    this.name = "AgentAlreadyExistsError";
    this.agentId = agentId;
  }
}

export class AgentInterruptedError extends AgentRuntimeError {
  readonly agentId: string;

  constructor(agentId: string, reason?: string) {
    super(
      "AGENT_INTERRUPTED",
      `Agent '${agentId}' 已被显式中断 (Interrupted)${
        reason ? `: ${reason}` : ""
      }。`
    );
    this.name = "AgentInterruptedError";
    this.agentId = agentId;
  }
}
