import type { RuntimeLimitsConfig } from "./types.js";

export const DEFAULT_RUNTIME_LIMITS: Required<RuntimeLimitsConfig> = {
  maxAgentDepth: 3,
  maxTotalAgents: 20,
  maxConcurrentAgents: 4,
  maxChildrenPerAgent: 5,
  maxTasks: 50,
  maxReplans: 5,
  maxAgentTurns: 100,
  maxToolCalls: 200,
  maxWallTimeMs: 1_800_000,
  maxRunMs: 1_800_000,
  maxConsecutiveWakes: 20,
  maxTeamMembers: 8,
  enableNoProgressDetection: true,
  noProgressThreshold: 5,
};

export function resolveRuntimeLimits(
  config?: RuntimeLimitsConfig
): Required<RuntimeLimitsConfig> {
  const wallTime =
    config?.maxRunMs ?? config?.maxWallTimeMs ?? DEFAULT_RUNTIME_LIMITS.maxWallTimeMs;

  return {
    maxAgentDepth: config?.maxAgentDepth ?? DEFAULT_RUNTIME_LIMITS.maxAgentDepth,
    maxTotalAgents:
      config?.maxTotalAgents ?? DEFAULT_RUNTIME_LIMITS.maxTotalAgents,
    maxConcurrentAgents:
      config?.maxConcurrentAgents ?? DEFAULT_RUNTIME_LIMITS.maxConcurrentAgents,
    maxChildrenPerAgent:
      config?.maxChildrenPerAgent ?? DEFAULT_RUNTIME_LIMITS.maxChildrenPerAgent,
    maxTasks: config?.maxTasks ?? DEFAULT_RUNTIME_LIMITS.maxTasks,
    maxReplans: config?.maxReplans ?? DEFAULT_RUNTIME_LIMITS.maxReplans,
    maxAgentTurns:
      config?.maxAgentTurns ?? DEFAULT_RUNTIME_LIMITS.maxAgentTurns,
    maxToolCalls: config?.maxToolCalls ?? DEFAULT_RUNTIME_LIMITS.maxToolCalls,
    maxWallTimeMs: wallTime,
    maxRunMs: wallTime,
    maxConsecutiveWakes:
      config?.maxConsecutiveWakes ?? DEFAULT_RUNTIME_LIMITS.maxConsecutiveWakes,
    maxTeamMembers:
      config?.maxTeamMembers ?? DEFAULT_RUNTIME_LIMITS.maxTeamMembers,
    enableNoProgressDetection:
      config?.enableNoProgressDetection ??
      DEFAULT_RUNTIME_LIMITS.enableNoProgressDetection,
    noProgressThreshold:
      config?.noProgressThreshold ?? DEFAULT_RUNTIME_LIMITS.noProgressThreshold,
  };
}
