import { ToolRegistry } from "./registry.js";
import { bashTool, createBashTool } from "./bash.js";
import { readFileTool, createReadFileTool } from "./read-file.js";
import { writeFileTool, createWriteFileTool } from "./write-file.js";
import { editFileTool, createEditFileTool } from "./edit-file.js";
import { listFilesTool, createListFilesTool } from "./list-files.js";
import { grepSearchTool, createGrepSearchTool } from "./grep-search.js";
import { readToolResultTool, createReadToolResultTool } from "./read-tool-result.js";
import {
  createTaskTools,
  createSubAgentTools,
  createTeamTools,
  createPlanTools,
  type AgentToolRole,
} from "./orchestration/index.js";
import {
  type JobManager,
  createJobListTool,
  createJobOutputTool,
  createJobKillTool,
} from "../jobs/index.js";
import type { FileSystemAccess } from "../sandbox/filesystem-access.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type { SpillStore } from "../context/spill/spill-store.js";
import type { TaskManager } from "../task/task-manager.js";
import type { SubAgentRuntime } from "../agent/subagent-runtime.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { TeamRuntime } from "../team/team-runtime.js";
import type { PlanMode } from "../plan/plan-mode.js";
import type { SkillService } from "../skills/skill-service.js";
import { SkillOpenTool } from "../skills/skill-tool.js";
import type { MemoryService } from "../memory/memory-service.js";
import { RememberTool, SearchMemoryTool } from "./memory-tools.js";
import type { MCPManager } from "../mcp/mcp-manager.js";

export * from "./tool.js";
export * from "./registry.js";
export * from "./executor.js";
export * from "./bash.js";
export * from "./path-utils.js";
export * from "./read-file.js";
export * from "./write-file.js";
export * from "./edit-file.js";
export * from "./list-files.js";
export * from "./grep-search.js";
export * from "./read-tool-result.js";
export * from "./memory-tools.js";
export * from "./orchestration/index.js";

export interface ToolRegistryOptions {
  fsAccess?: FileSystemAccess;
  sandboxService?: SandboxService;
  spillStore?: SpillStore;
  taskManager?: TaskManager;
  subAgentRuntime?: SubAgentRuntime;
  agentRegistry?: AgentRegistry;
  teamRuntime?: TeamRuntime;
  planMode?: PlanMode;
  jobManager?: JobManager;
  agentId?: string;
  sessionId?: string;
  projectId?: string;
  role?: AgentToolRole;
  skillService?: SkillService;
  memoryService?: MemoryService;
  mcpManager?: MCPManager;
}

/**
 * 创建并初始化预置工具集的 ToolRegistry 实例
 */
export function createDefaultToolRegistry(
  options?: ToolRegistryOptions
): ToolRegistry {
  const registry = new ToolRegistry();
  const role = options?.role ?? "lead";
  const agentId = options?.agentId ?? "main";
  const actorId = options?.agentId ?? (role === "lead" ? "main" : undefined);

  // 1. 基础文件与进程工具 (所有角色共有)
  if (
    options?.fsAccess ||
    options?.sandboxService ||
    options?.spillStore ||
    options?.jobManager
  ) {
    registry.registerMany([
      createBashTool({
        sandboxService: options.sandboxService,
        jobManager: options.jobManager,
        ownerAgentId: agentId,
        sessionId: options.sessionId,
        projectId: options.projectId,
        cwd: options.fsAccess?.getWorkspaceRoot(),
        scopedWritePaths: options.fsAccess?.getWriteScopes(),
      }),
      createReadFileTool(options.fsAccess),
      createWriteFileTool(options.fsAccess),
      createEditFileTool(options.fsAccess),
      createListFilesTool(options.fsAccess),
      createGrepSearchTool(options.fsAccess),
      createReadToolResultTool(options.spillStore),
    ]);
  } else {
    registry.registerMany([
      bashTool,
      readFileTool,
      writeFileTool,
      editFileTool,
      listFilesTool,
      grepSearchTool,
      readToolResultTool,
    ]);
  }

  // 1.1 后台 Job 治理工具 (所有角色可用，遵循拥有者权限隔离)
  if (options?.jobManager) {
    registry.registerMany([
      createJobListTool(options.jobManager, agentId),
      createJobOutputTool(options.jobManager, agentId),
      createJobKillTool(options.jobManager, agentId),
    ]);
  }

  // 1.2 Skills 按需加载工具 (所有角色可用)
  if (options?.skillService) {
    registry.register(new SkillOpenTool(options.skillService));
  }

  // 1.3 Memory 显式记录与渐进式检索工具 (所有角色可用)
  if (options?.memoryService) {
    registry.registerMany([
      new RememberTool(options.memoryService),
      new SearchMemoryTool(options.memoryService),
    ]);
  }

  // 2. Task 工具 (根据角色分级)
  if (options?.taskManager) {
    registry.registerMany(
      createTaskTools({
        taskManager: options.taskManager,
        planMode: options.planMode,
        agentId: actorId,
        role,
      })
    );
  }

  // 3. SubAgent 组织级工具 (Lead 与有限 SubAgent)
  if (options?.subAgentRuntime && options?.agentRegistry) {
    registry.registerMany(
      createSubAgentTools({
        subAgentRuntime: options.subAgentRuntime,
        agentId,
        agentRegistry: options.agentRegistry,
        taskManager: options.taskManager,
        planMode: options.planMode,
        role,
      })
    );
  }

  // 4. Team 协作工具 (Lead 与 Member 角色)
  if (options?.teamRuntime) {
    registry.registerMany(
      createTeamTools({
        teamRuntime: options.teamRuntime,
        agentId: actorId,
        subAgentRuntime: options.subAgentRuntime,
        taskManager: options.taskManager,
        planMode: options.planMode,
        role,
      })
    );
  }

  // 5. Plan Mode 方案设计工具 (仅 Lead 拥有)
  if (options?.planMode) {
    registry.registerMany(createPlanTools({ planMode: options.planMode, role }));
  }

  // 6. MCP 扩展工具与辅助发现机制
  if (options?.mcpManager) {
    options.mcpManager.syncToolsToRegistry(registry);
  }

  return registry;
}

/**
 * 快捷创建专用于 Lead / Main 组织协调角色的全量工具注册中心
 */
export function createLeadToolRegistry(
  options: Omit<ToolRegistryOptions, "role">
): ToolRegistry {
  return createDefaultToolRegistry({
    ...options,
    role: "lead",
  });
}

/**
 * 快捷创建专用于独立 SubAgent 执行角色的受限工具注册中心
 */
export function createSubAgentToolRegistry(
  options: Omit<ToolRegistryOptions, "role">
): ToolRegistry {
  return createDefaultToolRegistry({
    ...options,
    role: "subagent",
  });
}

/**
 * 快捷创建专用于 TeamMember 长期队员协作角色的受限工具注册中心
 */
export function createMemberToolRegistry(
  options: Omit<ToolRegistryOptions, "role">
): ToolRegistry {
  return createDefaultToolRegistry({
    ...options,
    role: "member",
  });
}

export * from "./adaptive-tool-exposure.js";
