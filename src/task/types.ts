/**
 * Task 状态生命周期枚举
 */
export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Task 执行结果结构
 */
export interface TaskResult {
  /**
   * 执行结果概要总结
   */
  summary: string;

  /**
   * 产物清单（如生成的文件路径、测试报告等）
   */
  artifacts?: string[];

  /**
   * 附加元数据
   */
  metadata?: Record<string, unknown>;
}

/**
 * Task 实体接口
 */
export interface Task {
  /**
   * 唯一任务 ID
   */
  id: string;

  /**
   * 任务简明主题
   */
  subject: string;

  /**
   * 任务详细描述
   */
  description?: string;

  /**
   * 当前状态
   */
  status: TaskStatus;

  /**
   * 所依赖的前置任务 ID 列表（全部 completed 后本任务变为 ready）
   */
  dependencies: string[];

  /**
   * 当前拥有/认领该任务的 Agent ID
   */
  ownerAgentId?: string;

  /**
   * 实际完成该任务的 Agent ID (保留归属追溯)
   */
  completedByAgentId?: string;

  /**
   * 导致该任务失败的 Agent ID
   */
  failedByAgentId?: string;

  /**
   * 被新任务取代时的替代任务 ID (当任务被 supersede 时)
   */
  supersededByTaskId?: string;

  /**
   * 取代/作废原因
   */
  supersededReason?: string;

  /**
   * 阻塞原因（当 status === "blocked" 时有效）
   */
  blockedReason?: string;

  /**
   * 阻塞来源任务或资源 ID
   */
  blockedBy?: string[];

  /**
   * 任务执行成功时的产出结果
   */
  result?: TaskResult;

  /**
   * 任务执行失败时的错误信息
   */
  error?: {
    code?: string;
    message: string;
    stack?: string;
  };

  /**
   * 该任务预期写入的文件/目录通配范围（例如 ["src/auth/**"]）
   */
  writeScopes?: string[];

  /**
   * 乐观锁版本号（用于 CAS 保证并发认领与状态修改的原子性）
   */
  revision: number;

  /**
   * 创建时间戳 (ms)
   */
  createdAt: number;

  /**
   * 最近更新时间戳 (ms)
   */
  updatedAt: number;

  /**
   * 开始运行时间戳 (ms)
   */
  startedAt?: number;

  /**
   * 结束运行时间戳 (ms)
   */
  completedAt?: number;

  /**
   * 自定义元数据
   */
  metadata?: Record<string, unknown>;
}

/**
 * 创建任务的输入结构
 */
export interface CreateTaskInput {
  id?: string;
  subject: string;
  description?: string;
  dependencies?: string[];
  ownerAgentId?: string;
  writeScopes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * 更新任务的输入结构（支持乐观并发 CAS 校验）
 */
export interface UpdateTaskInput {
  subject?: string;
  description?: string;
  dependencies?: string[];
  ownerAgentId?: string;
  writeScopes?: string[];
  metadata?: Record<string, unknown>;
  expectedRevision?: number;
}
