import { type Tool, defineTool } from "../../tools/tool.js";
import type { JobManager } from "../job-manager.js";

export interface JobListArgs {
  /**
   * 是否列出全局所有 Agent 的 Job（仅 Main / Lead 具有完整视图，普通 Agent 仅查看自身）
   */
  all?: boolean;
}

export function createJobListTool(
  jobManager: JobManager,
  currentAgentId = "main"
): Tool<JobListArgs> {
  return defineTool({
    name: "job_list",
    description: "查看后台运行或已结束的 Job 列表及其当前状态与运行耗时。",
    parameters: {
      type: "object",
      properties: {
        all: {
          type: "boolean",
          description: "是否查看所有 Agent 的 Job 列表（默认为 false，仅列出当前 Agent 的 Job）。",
        },
      },
    },
    async execute(args: JobListArgs): Promise<string> {
      const isLead = currentAgentId === "main" || currentAgentId === "main-agent";
      const filter =
        args?.all && isLead
          ? undefined
          : { ownerAgentId: currentAgentId };

      const jobs = jobManager.listJobs(filter);
      if (jobs.length === 0) {
        return "(当前暂无任何后台 Job)";
      }

      const lines: string[] = [];
      lines.push("ID        Owner       Status       Duration   Command");
      lines.push("────────────────────────────────────────────────────────────");

      for (const j of jobs) {
        const id = j.id.padEnd(10);
        const owner = j.ownerAgentId.padEnd(12);
        let status = j.status.padEnd(13);
        if (j.status === "completed") {
          status = "completed ✓".padEnd(13);
        } else if (j.status === "failed") {
          status = "failed ✗".padEnd(13);
        }

        const durationSec = Math.floor((j.durationMs ?? 0) / 1000);
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;
        const durationStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`.padEnd(11);

        const cmd = j.command.length > 35 ? j.command.slice(0, 32) + "..." : j.command;
        lines.push(`${id}${owner}${status}${durationStr}${cmd}`);
      }

      return lines.join("\n");
    },
  });
}
