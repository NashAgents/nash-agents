import { redactString } from "../observability/redaction.js";

/**
 * 格式化 Tool 调用参数为高度简洁、人类可读的单行自然动作摘要
 *
 * 铁律：
 * 1. 绝不展示 raw JSON、内部 tool_call_id 或 Python 多行脚本；
 * 2. 单行展示，自动截断超长内容，最大宽度控制在 60 字符以内；
 * 3. 严格经过密钥与敏感凭证脱敏处理器。
 */
export function formatToolCallSummary(
  toolName: string,
  rawArgs: string | Record<string, unknown>
): string {
  let args: Record<string, unknown> = {};

  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      args = { _raw: rawArgs };
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }

  let summary = "";

  switch (toolName) {
    case "read_file": {
      const p = String(args.path ?? "");
      summary = `reading ${p}`;
      break;
    }

    case "write_file": {
      const p = String(args.path ?? "");
      summary = `writing ${p}`;
      break;
    }

    case "edit_file": {
      const p = String(args.path ?? "");
      summary = `editing ${p}`;
      break;
    }

    case "list_files": {
      const p = String(args.path ?? ".");
      summary = `listing ${p}`;
      break;
    }

    case "grep_search": {
      const q = String(args.query ?? "").slice(0, 20);
      summary = `searching "${q}"`;
      break;
    }

    case "bash": {
      const cmd = String(args.command ?? "").trim();
      summary = summarizeBashCommand(cmd);
      break;
    }

    case "read_tool_result": {
      summary = `checking tool output`;
      break;
    }

    case "job_output": {
      summary = `checking background output`;
      break;
    }

    case "job_kill": {
      summary = `stopping background process`;
      break;
    }

    case "spawn_agent": {
      const name = String(args.name ?? args.role ?? "subagent");
      summary = `starting ${name}`;
      break;
    }

    case "interrupt_agent": {
      const id = String(args.agentId ?? "");
      summary = `interrupting ${id}`;
      break;
    }

    case "list_agents": {
      summary = `checking agent tree`;
      break;
    }

    case "spawn_teammate": {
      const name = String(args.name ?? "teammate");
      summary = `adding team member ${name}`;
      break;
    }

    case "create_task": {
      const subj = String(args.subject ?? "").slice(0, 25);
      summary = `creating task "${subj}"`;
      break;
    }

    case "update_task": {
      const id = String(args.taskId ?? "");
      summary = `updating task [${id}]`;
      break;
    }

    case "complete_task": {
      const id = String(args.taskId ?? "");
      summary = `completed task [${id}]`;
      break;
    }

    case "claim_task": {
      const id = String(args.taskId ?? "");
      summary = `claimed task [${id}]`;
      break;
    }

    case "assign_task": {
      const id = String(args.taskId ?? "");
      const agent = String(args.agentId ?? "");
      summary = `assigned task [${id}] -> ${agent}`;
      break;
    }

    case "block_task": {
      const id = String(args.taskId ?? "");
      summary = `blocked task [${id}]`;
      break;
    }

    case "list_tasks": {
      summary = `checking task plan`;
      break;
    }

    case "send_message": {
      const target = String(args.targetAgentId ?? "");
      summary = `messaging ${target}`;
      break;
    }

    case "list_team": {
      summary = `checking team roster`;
      break;
    }

    case "wait_for_change": {
      summary = `waiting for team update`;
      break;
    }

    case "enter_plan_mode": {
      summary = `planning architecture`;
      break;
    }

    case "propose_plan": {
      summary = `proposing plan`;
      break;
    }

    case "skill_open": {
      const name = String(args.name ?? args.skill ?? "");
      summary = name ? `${name}` : "skill";
      break;
    }

    case "search_memory": {
      const q = String(args.query ?? "").slice(0, 25);
      summary = q ? `"${q}"` : "memories";
      break;
    }

    case "remember": {
      const text = String(args.fact ?? args.content ?? "").slice(0, 25);
      summary = text ? `"${text}"` : "fact";
      break;
    }

    default: {
      summary = `${toolName}`;
    }
  }

  // 确保单行，去除所有换行并做最大 60 字符宽度截断
  const singleLine = summary.replace(/[\r\n\t]+/g, " ").trim();
  const truncated = singleLine.length > 60 ? singleLine.slice(0, 57) + "..." : singleLine;

  return redactString(truncated);
}

/**
 * 将 Bash 命令行提炼为人类可读的动作短语
 */
function summarizeBashCommand(cmd: string): string {
  const norm = cmd.replace(/[\r\n\t]+/g, " ").trim();

  if (norm === "pwd") return "checking working directory";
  if (norm.startsWith("git status")) return "checking git status";
  if (norm.startsWith("git diff")) return "checking git diff";
  if (norm.startsWith("git log")) return "checking git log";
  if (norm.startsWith("git branch")) return "checking git branch";
  if (norm.startsWith("git remote")) return "checking git remotes";
  if (norm.startsWith("ls") || norm.startsWith("find")) return "scanning directory";
  if (norm.startsWith("echo")) return "checking environment";
  if (norm.startsWith("which ") || norm.startsWith("command -v")) return "checking CLI toolchain";
  if (norm.includes("python3 -c") || norm.includes("python -c")) return "running environment check";
  if (norm.includes("node -e") || norm.includes("node --eval")) return "running environment check";
  if (norm.startsWith("npm test") || norm.startsWith("npm run test") || norm.startsWith("npx tsx --test")) {
    return "running tests";
  }
  if (norm.startsWith("npm run build") || norm.startsWith("npm run compile")) {
    return "building project";
  }
  if (norm.startsWith("npm run typecheck") || norm.startsWith("npx tsc")) {
    return "type checking";
  }
  if (norm.startsWith("npm i") || norm.startsWith("npm install") || norm.startsWith("pnpm i") || norm.startsWith("yarn")) {
    return "installing dependencies";
  }

  // 兜底返回截断命令
  const cleanCmd = norm.replace(/\s+/g, " ");
  return cleanCmd.length > 35 ? cleanCmd.slice(0, 32) + "..." : cleanCmd;
}
