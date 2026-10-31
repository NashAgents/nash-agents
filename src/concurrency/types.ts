/**
 * 运行时限制配置项
 */
export interface RuntimeLimitsConfig {
  /**
   * 最大嵌套调用深度 (Main depth=0, child depth=1...)，默认 3
   */
  maxAgentDepth?: number;

  /**
   * 整个运行生命周期中允许累计创建的最大 Agent 实例总数，默认 20
   */
  maxTotalAgents?: number;

  /**
   * 允许同时处于运行中 (running) 的瞬时最大 Agent 数量，默认 4
   */
  maxConcurrentAgents?: number;

  /**
   * 单个父 Agent 允许直接 spawn 的子 Agent 最大数量，默认 5
   */
  maxChildrenPerAgent?: number;

  /**
   * 允许创建的最大任务数，默认 50
   */
  maxTasks?: number;

  /**
   * 允许的最大重规划次数，默认 5
   */
  maxReplans?: number;

  /**
   * 单个 Agent 允许执行的最大步数 / 轮数，默认 100
   */
  maxAgentTurns?: number;

  /**
   * 单个 Agent 允许调用的最大工具总次数，默认 200
   */
  maxToolCalls?: number;

  /**
   * 单次任务/工作流全局最大超时时间 (ms)，默认 1,800,000 (30分钟)
   */
  maxWallTimeMs?: number;
  maxRunMs?: number;

  /**
   * 自动唤醒上限：在无新用户输入时，允许因后台事件自动唤醒 Agent 的最大连续次数，默认 20
   */
  maxConsecutiveWakes?: number;

  /**
   * 一个 Team 允许容纳的最大常驻成员数量，默认 8
   */
  maxTeamMembers?: number;

  /**
   * 是否启用无进展检测 (No-Progress Detection)，默认 true
   */
  enableNoProgressDetection?: boolean;

  /**
   * 无进展检测判定阈值：连续未产生有效状态转移或工具失败轮数，默认 5
   */
  noProgressThreshold?: number;
}
