import type { ApprovalRequest } from "../approval/types.js";
import type { SessionSummary } from "../context/types.js";
import type { JobRecord } from "../jobs/types.js";
import type { OutputWritable } from "./types.js";
import { stdout as defaultStdout } from "node:process";
import { TerminalMarkdownRenderer } from "../presentation/terminal-markdown-renderer.js";

export interface HeaderOptions {
  modelName?: string;
  projectPath?: string;
  legacyCount?: number;
}

export interface NashStatusInfo {
  project: {
    name: string;
    root: string;
    storage: string;
  };
  model: {
    name: string;
    contextWindow: number;
    compactionThreshold: number;
  };
  security: {
    filesystem: string;
    network: string;
    approval: string;
    backend?: string;
    seccomp?: string;
    noNewPrivs?: string;
    resources?: string;
  };
  runtime: {
    maxAgentTurns: number;
    maxToolCalls: number;
    maxRunMs: number;
  };
  jobs: {
    running: number;
    total: number;
  };
  sessions: {
    currentId?: string;
    legacyCount: number;
  };
}

/**
 * 负责 CLI 终端的所有视觉渲染与格式化输出，严格遵守视觉规范：
 * 1. 极简、克制、低噪；
 * 2. 统一使用 Cyan / Green / Yellow / Red / Gray / Default 标准色盘；
 * 3. 杜绝彩虹终端与冗余的大边框。
 */
export class TerminalUI {
  private readonly output: OutputWritable;

  constructor(output: OutputWritable | { outputStream?: OutputWritable } = defaultStdout) {
    if (output && typeof output === "object" && "outputStream" in output && output.outputStream) {
      this.output = output.outputStream;
    } else {
      this.output = (output as OutputWritable) ?? defaultStdout;
    }
  }

  /**
   * 极简启动 Header（仅显示品牌模型、当前项目路径与必要的 Legacy 提示）
   */
  renderHeader(options?: HeaderOptions): void {
    const model = options?.modelName ?? "deepseek-chat";
    const cwd = options?.projectPath ?? process.cwd();

    this.output.write(`\n\x1b[36mNash\x1b[0m · \x1b[90m${model}\x1b[0m\n`);
    this.output.write(`\x1b[90m${cwd}\x1b[0m\n`);

    if (options?.legacyCount && options.legacyCount > 0) {
      this.output.write(`\x1b[33m⚠ ${options.legacyCount} legacy sessions available\x1b[0m\n`);
    }

    this.output.write("\n");
  }

  /**
   * 渲染系统完整状态信息 (/status)
   */
  renderStatus(info: NashStatusInfo): void {
    const lines: string[] = [];
    lines.push("\n\x1b[1m\x1b[36mNash Status\x1b[0m\n");

    lines.push("\x1b[1mProject\x1b[0m");
    lines.push(`  \x1b[90mName\x1b[0m       ${info.project.name}`);
    lines.push(`  \x1b[90mRoot\x1b[0m       ${info.project.root}`);
    lines.push(`  \x1b[90mStorage\x1b[0m    \x1b[90m${info.project.storage}\x1b[0m`);
    lines.push("");

    lines.push("\x1b[1mModel\x1b[0m");
    lines.push(`  \x1b[90mName\x1b[0m       \x1b[36m${info.model.name}\x1b[0m`);
    lines.push(`  \x1b[90mContext\x1b[0m    ${info.model.contextWindow.toLocaleString()}`);
    lines.push(`  \x1b[90mCompact\x1b[0m    ${Math.round(info.model.compactionThreshold * 100)}%`);
    lines.push("");

    lines.push("\x1b[1mSecurity\x1b[0m");
    if (info.security.backend) {
      lines.push(`  \x1b[90mBackend\x1b[0m    \x1b[32m${info.security.backend}\x1b[0m`);
    }
    lines.push(`  \x1b[90mFiles\x1b[0m      ${info.security.filesystem}`);
    lines.push(`  \x1b[90mNetwork\x1b[0m    ${info.security.network}`);
    lines.push(`  \x1b[90mApproval\x1b[0m   ${info.security.approval}`);
    if (info.security.seccomp) {
      lines.push(`  \x1b[90mSeccomp\x1b[0m    ${info.security.seccomp}`);
    }
    if (info.security.noNewPrivs) {
      lines.push(`  \x1b[90mNoNewPrivs\x1b[0m ${info.security.noNewPrivs}`);
    }
    if (info.security.resources) {
      lines.push(`  \x1b[90mResources\x1b[0m  ${info.security.resources}`);
    }
    lines.push("");

    lines.push("\x1b[1mRuntime\x1b[0m");
    lines.push(`  \x1b[90mTurns\x1b[0m      ${info.runtime.maxAgentTurns}`);
    lines.push(`  \x1b[90mTool Calls\x1b[0m ${info.runtime.maxToolCalls}`);
    lines.push(`  \x1b[90mMax Run\x1b[0m    ${Math.round(info.runtime.maxRunMs / 1000)}s`);
    lines.push("");

    lines.push("\x1b[1mJobs\x1b[0m");
    lines.push(`  \x1b[90mRunning\x1b[0m    ${info.jobs.running}`);
    lines.push(`  \x1b[90mTotal\x1b[0m      ${info.jobs.total}`);
    lines.push("");

    lines.push("\x1b[1mSessions\x1b[0m");
    if (info.sessions.currentId) {
      lines.push(`  \x1b[90mCurrent\x1b[0m    \x1b[36m${info.sessions.currentId}\x1b[0m`);
    }
    lines.push(`  \x1b[90mLegacy\x1b[0m     ${info.sessions.legacyCount}`);
    lines.push("");

    this.output.write(lines.join("\n"));
  }

  /**
   * 格式化提权审批的提示卡片
   */
  formatApprovalPrompt(request: ApprovalRequest): string {
    const lines: string[] = [];
    lines.push("\n\x1b[33m\x1b[1mAgent requests additional permission:\x1b[0m");

    switch (request.capability) {
      case "filesystem-outside-workspace":
        lines.push("Filesystem access outside workspace:");
        if (request.target) {
          lines.push(`  \x1b[36m${request.target}\x1b[0m`);
        }
        break;
      case "filesystem-write":
        lines.push("Filesystem write access (read-only mode active):");
        if (request.target) {
          lines.push(`  \x1b[36m${request.target}\x1b[0m`);
        }
        break;
      case "network":
        lines.push("Network access required for command:");
        if (request.target) {
          lines.push(`  \x1b[36m${request.target}\x1b[0m`);
        }
        break;
      case "mcp-local":
        lines.push("Local MCP tool execution (stdio, OS sandbox enforced):");
        if (request.target) {
          lines.push(`  \x1b[36m${request.target}\x1b[0m`);
        }
        break;
      case "full-access":
        lines.push("Full system access override:");
        if (request.reason) {
          lines.push(`  \x1b[36m${request.reason}\x1b[0m`);
        }
        break;
    }

    if (request.reason && request.capability !== "full-access") {
      lines.push(`Reason: ${request.reason}`);
    }

    lines.push("\nAllow once? [y/N] ");
    return lines.join("\n");
  }

  /**
   * 渲染警告提示
   */
  renderWarning(message: string): void {
    this.output.write(`\x1b[33m${message}\x1b[0m\n`);
  }

  /**
   * 渲染普通信息提示
   */
  renderInfo(message: string): void {
    this.output.write(`${message}\n`);
  }

  /**
   * 渲染错误信息
   */
  renderError(message: string): void {
    this.output.write(`\n\x1b[31m[Error]\x1b[0m ${message}\n\n`);
  }

  /**
   * 渲染 Agent 最终回复（使用 TerminalMarkdownRenderer 渲染为 ANSI 富文本）
   */
  renderAgentResponse(response: string): void {
    const columns =
      typeof process.stdout.columns === "number" && process.stdout.columns > 0
        ? process.stdout.columns
        : 80;
    const renderedLines = TerminalMarkdownRenderer.render(response, {
      maxWidth: Math.max(20, columns - 2),
      indent: "",
    });
    this.output.write(`\n\x1b[1m\x1b[36m[Agent Response]\x1b[0m\n${renderedLines.join("\n")}\n\n`);
  }

  /**
   * 渲染后台 Jobs 列表 (/jobs)
   */
  renderJobs(jobs: JobRecord[]): void {
    if (jobs.length === 0) {
      this.output.write("\n\x1b[90m(当前无任何后台 Job 记录)\x1b[0m\n\n");
      return;
    }

    const lines: string[] = [];
    lines.push("\n\x1b[1m\x1b[36mJobs\x1b[0m\n");
    lines.push("ID        Owner       Status       Duration   Command");
    lines.push("\x1b[90m────────────────────────────────────────────────────────────\x1b[0m");

    for (const j of jobs) {
      const id = j.id.padEnd(10);
      const owner = j.ownerAgentId.padEnd(12);

      let statusStr = j.status.padEnd(13);
      if (j.status === "completed") {
        statusStr = "\x1b[32mcompleted ✓\x1b[0m  ";
      } else if (j.status === "failed") {
        statusStr = "\x1b[31mfailed ✗\x1b[0m     ";
      } else if (j.status === "running") {
        statusStr = "\x1b[36mrunning\x1b[0m      ";
      } else if (j.status === "timed_out") {
        statusStr = "\x1b[31mtimed out\x1b[0m    ";
      } else if (j.status === "cancelled") {
        statusStr = "\x1b[33mcancelled\x1b[0m    ";
      }

      const durationSec = Math.floor((j.durationMs ?? 0) / 1000);
      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;
      const durationStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`.padEnd(11);

      const cmd = j.command.length > 35 ? j.command.slice(0, 32) + "..." : j.command;
      lines.push(`${id}${owner}${statusStr}${durationStr}${cmd}`);
    }

    lines.push("");
    this.output.write(lines.join("\n") + "\n");
  }

  /**
   * 渲染单个 Job 详情及输出 (/job <id>)
   */
  renderJobDetail(job: JobRecord, tailOutput: string): void {
    const durationSec = Math.floor((job.durationMs ?? 0) / 1000);
    const mins = Math.floor(durationSec / 60);
    const secs = durationSec % 60;
    const durationStr = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

    const lines: string[] = [];
    lines.push("\n\x1b[1m\x1b[36mJob Details\x1b[0m");
    lines.push(`  \x1b[90mID\x1b[0m          ${job.id}`);
    lines.push(`  \x1b[90mOwner\x1b[0m       ${job.ownerAgentId}`);
    lines.push(`  \x1b[90mStatus\x1b[0m      ${job.status}`);
    lines.push(`  \x1b[90mCommand\x1b[0m     ${job.command}`);
    lines.push(`  \x1b[90mDuration\x1b[0m    ${durationStr} (${durationSec}s)`);

    if (job.pid) {
      lines.push(`  \x1b[90mPID\x1b[0m         ${job.pid}`);
    }
    if (job.exitCode !== null && job.exitCode !== undefined) {
      lines.push(`  \x1b[90mExit Code\x1b[0m   ${job.exitCode}`);
    }
    if (job.error) {
      lines.push(`  \x1b[90mError\x1b[0m       \x1b[31m${job.error}\x1b[0m`);
    }

    lines.push("\n\x1b[1mRecent Output\x1b[0m");
    lines.push("\x1b[90m────────────────────────────────────────────\x1b[0m");
    lines.push(tailOutput || "(暂无输出)");
    lines.push("");

    this.output.write(lines.join("\n") + "\n");
  }

  /**
   * 格式化并渲染会话列表
   */
  renderSessionList(
    sessions: Array<SessionSummary & { isLegacy?: boolean; source?: string }>,
    currentSessionId?: string
  ): void {
    if (sessions.length === 0) {
      this.output.write("\n\x1b[33mNo saved sessions found.\x1b[0m\n\n");
      return;
    }

    this.output.write("\n\x1b[1m\x1b[36mAvailable Sessions\x1b[0m\n");
    sessions.forEach((s, idx) => {
      const isCurrent = s.sessionId === currentSessionId;
      const marker = isCurrent ? "\x1b[32m* (Current)\x1b[0m" : "";
      const dateStr = new Date(s.updatedAt).toLocaleString("zh-CN", {
        hour12: false,
      });
      const promptPreview = s.title || s.firstUserPrompt
        ? (s.title || s.firstUserPrompt)!.replace(/\r?\n/g, " ").slice(0, 60)
        : "(Empty prompt)";
      const compactTag = s.hasCompaction ? " \x1b[33m[Compacted]\x1b[0m" : "";
      const legacyTag = s.isLegacy
        ? " \x1b[33m[Legacy ~/.nash/context]\x1b[0m"
        : "";

      this.output.write(
        `  \x1b[1m\x1b[33m[${idx + 1}]\x1b[0m \x1b[36m${s.sessionId}\x1b[0m ${marker}${legacyTag}\n` +
          `      \x1b[90mUpdated:\x1b[0m ${dateStr} | \x1b[90mMessages:\x1b[0m ${s.messageCount}${compactTag}\n` +
          `      \x1b[90mPrompt:\x1b[0m "${promptPreview}"\n`
      );
    });
    this.output.write("\n");
  }

  /**
   * 渲染会话成功恢复提示
   */
  renderSessionResumed(session: SessionSummary): void {
    const promptPreview = session.title || session.firstUserPrompt
      ? (session.title || session.firstUserPrompt)!.replace(/\r?\n/g, " ").slice(0, 60)
      : "(Empty)";
    this.output.write(
      `\n\x1b[32m✓ Session resumed:\x1b[0m \x1b[36m${session.sessionId}\x1b[0m\n` +
        `  \x1b[90mMessages:\x1b[0m ${session.messageCount} | \x1b[90mFirst Prompt:\x1b[0m "${promptPreview}"\n\n`
    );
  }

  /**
   * 渲染当前会话详细信息
   */
  renderSessionInfo(session: SessionSummary, isActive = true): void {
    const dateStr = new Date(session.updatedAt).toLocaleString("zh-CN", {
      hour12: false,
    });
    const activeStr = isActive ? "\x1b[32mActive\x1b[0m" : "\x1b[90mInactive\x1b[0m";
    this.output.write(
      `\n\x1b[1m\x1b[36m[Session Info]\x1b[0m\n` +
        `  ID: \x1b[36m${session.sessionId}\x1b[0m (${activeStr})\n` +
        `  Last Updated: ${dateStr}\n` +
        `  Total Records: ${session.recordCount} (Messages: ${session.messageCount})\n` +
        `  Compacted: ${session.hasCompaction ? "Yes" : "No"}\n`
    );
    if (session.firstUserPrompt) {
      this.output.write(`  First Prompt: "${session.firstUserPrompt}"\n`);
    }
    if (session.lastUserPrompt && session.lastUserPrompt !== session.firstUserPrompt) {
      this.output.write(`  Last Prompt: "${session.lastUserPrompt}"\n`);
    }
    this.output.write("\n");
  }

  /**
   * 渲染 CLI 帮助信息
   */
  renderHelp(): void {
    this.output.write(
      `\n\x1b[1m\x1b[36mNash Agent Commands:\x1b[0m\n` +
        `  \x1b[1mInspect work\x1b[0m\n` +
        `  \x1b[33m/agents\x1b[0m              Agent tree, including subagents and team members\n` +
        `  \x1b[33m/agent\x1b[0m <name/id>     Agent status and metrics\n` +
        `  \x1b[33m/tasks\x1b[0m               Plan execution and task graph\n` +
        `  \x1b[33m/stats\x1b[0m               Run and per-agent metrics\n` +
        `  \x1b[33m/status\x1b[0m              Show comprehensive status (Project, Model, Security, Runtime, Jobs)\n` +
        `  \x1b[33m/diff\x1b[0m                Review local changes and diff summary\n` +
        `  \x1b[33m/jobs\x1b[0m                List all background jobs and status\n` +
        `  \x1b[33m/job\x1b[0m <id>            Show details and output tail for a specific job\n` +
        `  \x1b[33m/copy\x1b[0m                Copy latest assistant response to clipboard\n` +
        `  \x1b[1mSessions\x1b[0m\n` +
        `  \x1b[33m/resume\x1b[0m [index|id]   List and choose a previous session to resume\n` +
        `  \x1b[33m/session\x1b[0m             Show information about the current session\n` +
        `  \x1b[33m/new\x1b[0m                 Start a brand new session\n` +
        `  \x1b[33m/compact\x1b[0m             Manually trigger context compaction\n` +
        `  \x1b[1mMemory & Skills\x1b[0m\n` +
        `  \x1b[33m/memory\x1b[0m [project|global] View active memory summary\n` +
        `  \x1b[33m/memory search\x1b[0m <q>    Search stored memories\n` +
        `  \x1b[33m/memory forget\x1b[0m <id>   Deprecate/remove a specific memory record\n` +
        `  \x1b[33m/remember\x1b[0m <fact>      Explicitly remember a fact or user preference\n` +
        `  \x1b[33m/skills\x1b[0m              List all available skills (project & global)\n` +
        `  \x1b[33m/skills show\x1b[0m <name>   Inspect full procedure and verification for a skill\n` +
        `  \x1b[33m/context\x1b[0m             Audit active context hierarchy and budgets\n` +
        `  \x1b[33m/help\x1b[0m                Show this help message\n` +
        `  \x1b[33mexit\x1b[0m | \x1b[33mquit\x1b[0m          Exit the Nash Agents CLI\n` +
        `  \x1b[1mKeys while running\x1b[0m\n` +
        `  ↑↓ select agent · Enter open · Esc Main · Ctrl+T plan\n` +
        `  Tab steer/queue on Main · Ctrl+O call details · drag to select · right-click copy · scroll terminal history\n` +
        `  Plan approval: ↑↓ choose · PgUp/PgDn steps · D details\n\n`
    );
  }
}
