import * as crypto from "node:crypto";
import type { AgentRecord, RegisterAgentInput, AgentStatus } from "./types.js";
import { AgentNotFoundError, AgentAlreadyExistsError } from "./errors.js";
import type { EventBus } from "../observability/event-bus.js";

export interface AgentRegistryOptions {
  eventBus?: EventBus;
  projectId?: string;
  sessionId?: string;
}

/**
 * 统一 Agent 注册中心与生命周期追踪器 (AgentRegistry)
 */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly sessionId: string;

  constructor(options?: AgentRegistryOptions) {
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectId ?? "default-project";
    this.sessionId = options?.sessionId ?? "default-session";
  }

  /**
   * 注册一个新的 Agent 实例
   */
  register(input: RegisterAgentInput): AgentRecord {
    const agentId = input.agentId ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
    if (this.agents.has(agentId)) {
      const existing = this.agents.get(agentId)!;
      // 若已有同 ID 成员（如预先登记的 team-member），允许复用并更新元数据与状态
      if (input.name) existing.name = input.name;
      if (input.role) existing.role = input.role;
      if (input.roleDescription) existing.roleDescription = input.roleDescription;
      if (input.status) existing.status = input.status;
      if (input.currentTaskId !== undefined) existing.currentTaskId = input.currentTaskId;
      existing.updatedAt = Date.now();
      return { ...existing };
    }

    let depth = input.depth;
    if (depth === undefined) {
      if (input.parentAgentId) {
        const parent = this.agents.get(input.parentAgentId);
        depth = parent ? parent.depth + 1 : 1;
      } else {
        depth = input.type === "main" ? 0 : 1;
      }
    }

    const now = Date.now();
    const defaultStatus: AgentStatus =
      input.status ?? (input.type === "team-member" ? "ready" : "running");
    const record: AgentRecord = {
      agentId,
      name: input.name,
      parentAgentId: input.parentAgentId,
      type: input.type,
      status: defaultStatus,
      depth,
      role: input.role,
      roleDescription: input.roleDescription,
      worktreePath: input.worktreePath,
      currentTaskId: input.currentTaskId,
      createdAt: now,
      updatedAt: now,
    };

    this.agents.set(agentId, record);

    this.emitEvent("agent.spawned", {
      agent: { ...record },
    });

    return { ...record };
  }

  getAgent(agentId: string): AgentRecord | undefined {
    const record = this.agents.get(agentId);
    return record ? { ...record } : undefined;
  }

  findByName(name: string): AgentRecord | undefined {
    return Array.from(this.agents.values()).find(
      (a) => a.name === name || a.agentId === name
    );
  }

  getRunningAgents(): AgentRecord[] {
    return Array.from(this.agents.values())
      .filter((a) => a.status === "running")
      .map((a) => ({ ...a }));
  }

  requireAgent(agentId: string): AgentRecord {
    const record = this.agents.get(agentId);
    if (!record) {
      throw new AgentNotFoundError(agentId);
    }
    return { ...record };
  }

  getAllAgents(): AgentRecord[] {
    return Array.from(this.agents.values()).map((a) => ({ ...a }));
  }

  getChildren(parentAgentId: string): AgentRecord[] {
    return Array.from(this.agents.values())
      .filter((a) => a.parentAgentId === parentAgentId)
      .map((a) => ({ ...a }));
  }

  updateStatus(
    agentId: string,
    status: AgentStatus,
    extra?: {
      currentTaskId?: string;
      error?: { message: string; code?: string; stack?: string };
    }
  ): AgentRecord {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }

    const oldStatus = agent.status;
    agent.status = status;
    agent.updatedAt = Date.now();

    if (extra?.currentTaskId !== undefined) {
      agent.currentTaskId = extra.currentTaskId;
    }
    if (extra?.error) {
      agent.error = extra.error;
    }
    if (status === "completed" || status === "failed" || status === "interrupted") {
      agent.completedAt = agent.completedAt ?? Date.now();
    }

    // 触发对应生命周期事件
    switch (status) {
      case "ready":
        this.emitEvent("agent.ready", { agent: { ...agent } });
        break;
      case "running":
        this.emitEvent("agent.running", { agent: { ...agent } });
        break;
      case "waiting":
        this.emitEvent("agent.waiting", { agent: { ...agent } });
        break;
      case "completed":
        this.emitEvent("agent.completed", { agent: { ...agent } });
        break;
      case "failed":
        this.emitEvent("agent.failed", {
          agent: { ...agent },
          error: agent.error,
        });
        break;
      case "interrupted":
        this.emitEvent("agent.interrupted", { agent: { ...agent } });
        break;
    }

    return { ...agent };
  }

  unregister(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  clear(): void {
    this.agents.clear();
  }

  updateCurrentTaskId(agentId: string, currentTaskId?: string): AgentRecord {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }
    agent.currentTaskId = currentTaskId;
    agent.updatedAt = Date.now();
    return { ...agent };
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: this.sessionId,
        data,
      });
    }
  }
}
