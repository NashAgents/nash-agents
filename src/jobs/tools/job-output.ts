import { type Tool, defineTool } from "../../tools/tool.js";
import type { JobManager } from "../job-manager.js";

export interface JobOutputArgs {
  /**
   * 目标 Job 的唯一 ID (例如 job-1)
   */
  jobId: string;

  /**
   * 是否主动同步等待该 Job 结束，默认为 false（非阻塞即时查询）
   */
  wait?: boolean;

  /**
   * 当 wait=true 时最多同步等待的时间（毫秒），默认 30000ms (30s)。超时后返回 running 状态，绝不终止 Job
   */
  timeoutMs?: number;

  /**
   * 返回最近尾部输出的行数，默认 50 行
   */
  tailLines?: number;
}

export function createJobOutputTool(
  jobManager: JobManager,
  currentAgentId = "main"
): Tool<JobOutputArgs> {
  return defineTool({
    name: "job_output",
    description:
      "查询指定后台 Job 的当前运行状态与标准输出/错误输出 (stdout/stderr)。支持非阻塞查询以及可选的主动同步等待 (wait=true)。",
    parameters: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "需要查询的后台 Job ID (如 job-1)。",
        },
        wait: {
          type: "boolean",
          description:
            "是否同步等待 Job 完成。若为 false（默认），立即返回当前已有输出；若为 true，最多等待 timeoutMs 毫秒。",
        },
        timeoutMs: {
          type: "number",
          description: "当 wait=true 时的最大等待时间（毫秒），默认为 30000ms。",
        },
        tailLines: {
          type: "number",
          description: "返回尾部输出的行数限制，默认为 50 行。",
        },
      },
      required: ["jobId"],
    },
    async execute(args: JobOutputArgs): Promise<string> {
      if (!args || !args.jobId) {
        throw new Error("缺少必填参数 'jobId'。");
      }

      const jobId = args.jobId;
      const job = jobManager.getJob(jobId);

      let record = jobManager.getJobRecord(jobId);
      if (!record) {
        throw new Error(`Job '${jobId}' 不存在。`);
      }

      if (args.wait && record.status === "running") {
        record = await jobManager.waitForJob(jobId, args.timeoutMs, currentAgentId);
      }

      const durationSec = Math.floor((record.durationMs ?? 0) / 1000);
      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;
      const durationStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

      const lines: string[] = [];
      lines.push(`Job ID: ${record.id}`);
      lines.push(`Command: ${record.command}`);
      lines.push(`Owner: ${record.ownerAgentId}`);
      lines.push(`Status: ${record.status}`);
      lines.push(`Duration: ${durationStr}`);

      if (record.exitCode !== null && record.exitCode !== undefined) {
        lines.push(`Exit Code: ${record.exitCode}`);
      }
      if (record.signal) {
        lines.push(`Signal: ${record.signal}`);
      }
      if (record.error) {
        lines.push(`Error: ${record.error}`);
      }

      lines.push("\nOutput Tail:");
      lines.push("────────────────────────────────────────────");

      let tailOutput = "";
      if (job) {
        tailOutput = job.getBuffer().getTailLines(args.tailLines ?? 50);
      } else if (record.resultSummary) {
        tailOutput = record.resultSummary;
      }

      lines.push(tailOutput || "(暂无输出)");

      return lines.join("\n");
    },
  });
}
