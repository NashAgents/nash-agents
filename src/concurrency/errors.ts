/**
 * 并发与资源限制强类型错误
 */

export class ConcurrencyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ConcurrencyError";
    this.code = code;
  }
}

export class AgentDepthLimitError extends ConcurrencyError {
  readonly depth: number;
  readonly maxDepth: number;

  constructor(depth: number, maxDepth: number) {
    super(
      "AGENT_DEPTH_LIMIT",
      `已达到 Agent 递归深度上限: 当前深度 ${depth}，最大允许深度 ${maxDepth}。拒绝继续派生子 Agent。`
    );
    this.name = "AgentDepthLimitError";
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

export class AgentTotalLimitError extends ConcurrencyError {
  readonly total: number;
  readonly maxTotal: number;

  constructor(total: number, maxTotal: number) {
    super(
      "AGENT_LIMIT",
      `已达到累计创建 Agent 总量上限: 当前总数 ${total}，最大允许 ${maxTotal}。`
    );
    this.name = "AgentTotalLimitError";
    this.total = total;
    this.maxTotal = maxTotal;
  }
}

export class AgentChildrenLimitError extends ConcurrencyError {
  readonly parentAgentId: string;
  readonly count: number;
  readonly maxChildren: number;

  constructor(parentAgentId: string, count: number, maxChildren: number) {
    super(
      "AGENT_CHILDREN_LIMIT",
      `Agent '${parentAgentId}' 派生的子 Agent 数量已达上限: 当前已有 ${count} 个，最大允许 ${maxChildren} 个。`
    );
    this.name = "AgentChildrenLimitError";
    this.parentAgentId = parentAgentId;
    this.count = count;
    this.maxChildren = maxChildren;
  }
}

export class AgentConcurrencyLimitError extends ConcurrencyError {
  readonly currentRunning: number;
  readonly maxConcurrent: number;

  constructor(currentRunning: number, maxConcurrent: number) {
    super(
      "AGENT_CONCURRENCY_LIMIT",
      `并发执行的 Agent 数量达到上限: 当前运行中 ${currentRunning}，最大允许并发 ${maxConcurrent}。`
    );
    this.name = "AgentConcurrencyLimitError";
    this.currentRunning = currentRunning;
    this.maxConcurrent = maxConcurrent;
  }
}

export class TeamMemberLimitError extends ConcurrencyError {
  readonly currentMembers: number;
  readonly maxMembers: number;

  constructor(currentMembers: number, maxMembers: number) {
    super(
      "TEAM_MEMBER_LIMIT",
      `团队成员数量达到上限: 当前 ${currentMembers}，最大允许 ${maxMembers}。`
    );
    this.name = "TeamMemberLimitError";
    this.currentMembers = currentMembers;
    this.maxMembers = maxMembers;
  }
}

export class TaskLimitError extends ConcurrencyError {
  readonly currentTasks: number;
  readonly maxTasks: number;

  constructor(currentTasks: number, maxTasks: number) {
    super(
      "TASK_LIMIT",
      `任务总量达到上限: 当前 ${currentTasks}，最大允许 ${maxTasks}。`
    );
    this.name = "TaskLimitError";
    this.currentTasks = currentTasks;
    this.maxTasks = maxTasks;
  }
}

export class ReplanLimitError extends ConcurrencyError {
  readonly currentReplans: number;
  readonly maxReplans: number;

  constructor(currentReplans: number, maxReplans: number) {
    super(
      "REPLAN_LIMIT",
      `重规划次数达到上限: 已重规划 ${currentReplans} 次，最大允许 ${maxReplans} 次。`
    );
    this.name = "ReplanLimitError";
    this.currentReplans = currentReplans;
    this.maxReplans = maxReplans;
  }
}

export class ExecutionTimeoutError extends ConcurrencyError {
  readonly durationMs: number;
  readonly maxWallTimeMs: number;

  constructor(durationMs: number, maxWallTimeMs: number) {
    super(
      "EXECUTION_TIMEOUT",
      `全局执行时间超时: 已运行 ${durationMs}ms，超时阈值为 ${maxWallTimeMs}ms。`
    );
    this.name = "ExecutionTimeoutError";
    this.durationMs = durationMs;
    this.maxWallTimeMs = maxWallTimeMs;
  }
}

export class ToolLimitError extends ConcurrencyError {
  readonly currentToolCalls: number;
  readonly maxToolCalls: number;

  constructor(currentToolCalls: number, maxToolCalls: number) {
    super(
      "TOOL_LIMIT",
      `工具调用次数达到上限: 当前 ${currentToolCalls}，最大允许 ${maxToolCalls}。`
    );
    this.name = "ToolLimitError";
    this.currentToolCalls = currentToolCalls;
    this.maxToolCalls = maxToolCalls;
  }
}

export class NoProgressDetectedError extends ConcurrencyError {
  readonly consecutiveNoProgressSteps: number;

  constructor(consecutiveNoProgressSteps: number) {
    super(
      "NO_PROGRESS_DETECTED",
      `系统检测到死循环/无进展状态 (No-Progress Loop): 连续 ${consecutiveNoProgressSteps} 步未产生有效状态推进或反复出现相同错误。`
    );
    this.name = "NoProgressDetectedError";
    this.consecutiveNoProgressSteps = consecutiveNoProgressSteps;
  }
}
