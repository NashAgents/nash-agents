import { type Tool, defineTool } from "../../tools/tool.js";
import type { JobManager } from "../job-manager.js";

export interface JobKillArgs {
  /**
   * 目标 Job 的唯一 ID
   */
  jobId: string;
}

export function createJobKillTool(
  jobManager: JobManager,
  currentAgentId = "main"
): Tool<JobKillArgs> {
  return defineTool({
    name: "job_kill",
    description: "终止指定的后台 Job 进程并将其状态标记为 cancelled。受 Agent 拥有权权限隔离保护。",
    parameters: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "需要终止的后台 Job ID (如 job-1)。",
        },
      },
      required: ["jobId"],
    },
    async execute(args: JobKillArgs): Promise<string> {
      if (!args || !args.jobId) {
        throw new Error("缺少必填参数 'jobId'。");
      }

      const record = await jobManager.killJob(args.jobId, currentAgentId);
      return `Job '${record.id}' 已成功终止 (状态: ${record.status})。`;
    },
  });
}
