import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LocalSessionStore } from "../context/session/local-session-store.js";
import type { ContextManager } from "../context/context-manager.js";
import type { InputManager } from "./input-manager.js";
import type { TerminalUI, NashStatusInfo } from "./terminal-ui.js";
import type { ProjectContext } from "../project/project-context.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { TaskManager } from "../task/task-manager.js";
import type { JobManager } from "../jobs/job-manager.js";
import type { CliPresenter } from "../presentation/cli-presenter.js";
import { formatAgentCentricView, formatTaskCentricView } from "../projection/index.js";
import { MemoryService } from "../memory/index.js";
import { SkillService } from "../skills/index.js";
import { loadRepositoryInstructions } from "../context/repository-instructions.js";
import { SLASH_COMMANDS } from "./slash-commands-registry.js";
import { MCPManager } from "../mcp/mcp-manager.js";

const execFileAsync = promisify(execFile);

export interface CommandExecutionContext {
  inputManager: InputManager;
  terminalUI: TerminalUI;
  contextManager: ContextManager;
  projectContext?: ProjectContext;
  baseDir?: string;
  agentRegistry?: AgentRegistry;
  taskManager?: TaskManager;
  jobManager?: JobManager;
  cliPresenter?: CliPresenter;
  statusProvider?: () => NashStatusInfo;
  memoryService?: MemoryService;
  skillService?: SkillService;
  mcpManager?: MCPManager;
  onSessionSwitched?: (newSessionId: string) => void | Promise<void>;
}

export interface CommandResult {
  handled: boolean;
  shouldExit?: boolean;
}

/**
 * 判断输入是否为 Slash 命令
 */
export function isSlashCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("/");
}

/**
 * 分发与执行 Slash 命令
 */
export async function handleSlashCommand(
  input: string,
  context: CommandExecutionContext
): Promise<CommandResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const rawCommand = (parts[0] || "").toLowerCase();
  const args = parts.slice(1).join(" ").trim();

  // 智能解析命令缩写与别名 (例如 /ski 唯一匹配 /skills)
  let command = rawCommand;
  let customPromptServer: string | undefined;
  let customPromptName: string | undefined;

  // 支持 /server:prompt 快捷调用
  if (rawCommand.includes(":") && !rawCommand.startsWith("http")) {
    const colonIdx = rawCommand.indexOf(":");
    customPromptServer = rawCommand.slice(0, colonIdx);
    customPromptName = rawCommand.slice(colonIdx + 1);
    command = "prompt";
  } else {
    const prefixMatches = SLASH_COMMANDS.filter((c) =>
      c.name.slice(1).toLowerCase().startsWith(rawCommand) ||
      c.aliases?.some((a) => a.slice(1).toLowerCase().startsWith(rawCommand))
    );
    if (prefixMatches.length === 1) {
      command = prefixMatches[0]!.name.slice(1).toLowerCase();
    }
  }

  const {
    inputManager,
    terminalUI,
    contextManager,
    projectContext,
    baseDir,
    jobManager,
    onSessionSwitched,
  } = context;

  const targetSessionsRoot =
    (typeof contextManager?.getProjectContext === "function"
      ? contextManager.getProjectContext()
      : undefined) ||
    projectContext ||
    baseDir;

  const runDirectOutput = async (action: () => void | Promise<void>) => {
    if (context.cliPresenter?.isInteractiveTTY()) {
      context.cliPresenter.prepareForDirectTerminalOutput();
      try {
        await action();
      } finally {
        context.cliPresenter.requestRender({ immediate: true });
      }
    } else {
      await action();
    }
  };

  switch (command) {
    case "mcp": {
      await runDirectOutput(async () => {
        const mcpMgr =
          context.mcpManager ??
          new MCPManager({
            projectRoot: projectContext?.projectRoot ?? baseDir ?? process.cwd(),
          });

        const subParts = args.split(/\s+/).filter(Boolean);
        const subCmd = (subParts[0] || "list").toLowerCase();
        const targetServer = subParts[1];

        if (subCmd === "list" || (!subParts[0] && !args)) {
          const statuses = mcpMgr.listStatuses();
          if (statuses.length === 0) {
            terminalUI.renderInfo(
              "\n\x1b[33mNo MCP servers configured.\x1b[0m\nUse `nash mcp add --help` or edit settings.json to configure servers.\n"
            );
            return;
          }

          terminalUI.renderInfo(`\n\x1b[1mModel Context Protocol (MCP) Servers:\x1b[0m\n`);
          for (const s of statuses) {
            let statusDot = "\x1b[32m●\x1b[0m"; // green
            if (s.status === "failed") statusDot = "\x1b[31m✖\x1b[0m"; // red
            else if (s.status === "disabled" || s.status === "disconnected") statusDot = "\x1b[90m○\x1b[0m"; // gray
            else if (s.status === "connecting" || s.status === "reconnecting") statusDot = "\x1b[33m↻\x1b[0m"; // yellow

            const endpointStr = s.endpoint ? ` (${s.endpoint})` : "";
            const protoStr = s.protocolVersion ? ` · protocol: ${s.protocolVersion}` : "";
            const toolsStr = s.status === "connected" ? ` · \x1b[36m${s.toolCount} tools\x1b[0m` : "";

            console.log(`  ${statusDot} \x1b[1m${s.name}\x1b[0m \x1b[90m[${s.transport}]\x1b[0m${toolsStr}`);
            console.log(`    Status: ${s.status}${protoStr} · Scope: ${s.scope || "global"}`);
            if (s.lastError) {
              console.log(`    \x1b[31mError: ${s.lastError}\x1b[0m`);
            }
            console.log("");
          }
          console.log(`Commands: /mcp test <name> | /mcp tools [name] | /mcp enable <name> | /mcp disable <name>\n`);
          return;
        }

        if (subCmd === "test") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp test <server-name>");
            return;
          }
          console.log(`\n\x1b[36mTesting MCP connection to '${targetServer}'...\x1b[0m`);
          const res = await mcpMgr.testServer(targetServer);
          if (res.success) {
            terminalUI.renderInfo(
              `\x1b[32m✓ Handshake succeeded!\x1b[0m Protocol: ${res.protocolVersion || "negotiated"}, Latency: ${res.latencyMs}ms, Tools: ${res.toolCount}`
            );
            if (res.tools && res.tools.length > 0) {
              console.log(`  Tools: ${res.tools.join(", ")}`);
            }
          } else {
            terminalUI.renderError(`\x1b[31m✖ Handshake failed:\x1b[0m ${res.error}`);
          }
          console.log("");
          return;
        }

        if (subCmd === "tools") {
          const tools = targetServer
            ? mcpMgr.connectionManager.getTools(targetServer)
            : mcpMgr.connectionManager.getAllTools();

          if (tools.length === 0) {
            terminalUI.renderInfo(`\n\x1b[33mNo tools discovered${targetServer ? ` for '${targetServer}'` : ""}.\x1b[0m\n`);
            return;
          }

          terminalUI.renderInfo(`\n\x1b[1mDiscovered MCP Tools (${tools.length}):\x1b[0m\n`);
          for (const t of tools) {
            console.log(`  \x1b[36m${t.name}\x1b[0m (from \`${t.serverName}\`)`);
            if (t.description) console.log(`    ${t.description}`);
            const props = Object.keys((t.inputSchema?.properties as any) || {});
            if (props.length > 0) console.log(`    \x1b[90mParams: ${props.join(", ")}\x1b[0m`);
            console.log("");
          }
          return;
        }

        if (subCmd === "enable") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp enable <server-name>");
            return;
          }
          const ok = await mcpMgr.enableServer(targetServer);
          if (ok) terminalUI.renderInfo(`\x1b[32m✓ MCP Server '${targetServer}' enabled.\x1b[0m\n`);
          else terminalUI.renderError(`MCP Server '${targetServer}' not found.\n`);
          return;
        }

        if (subCmd === "disable") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp disable <server-name>");
            return;
          }
          const ok = await mcpMgr.disableServer(targetServer);
          if (ok) terminalUI.renderInfo(`\x1b[32m✓ MCP Server '${targetServer}' disabled.\x1b[0m\n`);
          else terminalUI.renderError(`MCP Server '${targetServer}' not found.\n`);
          return;
        }

        if (subCmd === "reconnect") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp reconnect <server-name>");
            return;
          }
          console.log(`\x1b[36mReconnecting '${targetServer}'...\x1b[0m`);
          await mcpMgr.reconnectServer(targetServer);
          terminalUI.renderInfo(`\x1b[32m✓ Reconnected '${targetServer}'.\x1b[0m\n`);
          return;
        }

        if (subCmd === "doctor") {
          const { runMcpDoctor } = await import("./mcp-doctor.js");
          await runMcpDoctor(mcpMgr);
          return;
        }

        if (subCmd === "trust") {
          mcpMgr.configManager.trustCurrentProject();
          terminalUI.renderInfo("\n\x1b[32m✔ 已成功批准并信任当前项目的 .mcp.json 配置。\x1b[0m\n");
          return;
        }

        if (subCmd === "remove") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp remove <server-name>");
            return;
          }
          const ok = await mcpMgr.removeServer(targetServer);
          if (ok) terminalUI.renderInfo(`\x1b[32m✓ MCP Server '${targetServer}' removed.\x1b[0m\n`);
          else terminalUI.renderError(`MCP Server '${targetServer}' not found.\n`);
          return;
        }

        if (subCmd === "login") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp login <server-name>");
            return;
          }
          console.log(`\x1b[36mStarting OAuth login for '${targetServer}'...\x1b[0m`);
          const ok = await mcpMgr.loginServer(targetServer);
          if (ok) terminalUI.renderInfo(`\x1b[32m✓ Logged in to '${targetServer}'.\x1b[0m\n`);
          return;
        }

        if (subCmd === "logout") {
          if (!targetServer) {
            terminalUI.renderError("Usage: /mcp logout <server-name>");
            return;
          }
          await mcpMgr.logoutServer(targetServer);
          terminalUI.renderInfo(`\x1b[32m✓ Logged out from '${targetServer}'.\x1b[0m\n`);
          return;
        }

        terminalUI.renderWarning(
          `Unknown /mcp subcommand '${subCmd}'. Available: list, test, tools, enable, disable, reconnect, doctor, trust, login, logout, remove`
        );
      });
      return { handled: true };
    }
    case "prompt": {
      await runDirectOutput(async () => {
        const mcpMgr =
          context.mcpManager ??
          new MCPManager({
            projectRoot: projectContext?.projectRoot ?? baseDir ?? process.cwd(),
          });

        let server = customPromptServer;
        let promptName = customPromptName;
        const subParts = args.split(/\s+/).filter(Boolean);

        if (!server && subParts.length > 0) {
          server = subParts[0];
          promptName = subParts[1];
        }

        if (!server) {
          const allPrompts = mcpMgr.connectionManager.getAllPrompts();
          if (allPrompts.length === 0) {
            terminalUI.renderInfo("\n\x1b[33m当前无可用 MCP Prompts 模板。\x1b[0m\n");
            return;
          }
          terminalUI.renderInfo(`\n\x1b[1m可用 MCP Prompts 模板 (${allPrompts.length}):\x1b[0m\n`);
          for (const p of allPrompts) {
            console.log(`  \x1b[36m/${p.serverName}:${p.name}\x1b[0m - ${p.description || "无描述"}`);
          }
          console.log("");
          return;
        }

        if (!promptName) {
          terminalUI.renderError("用法: /prompt <server> <prompt-name> [key=value...]");
          return;
        }

        try {
          const paramObj: Record<string, string> = {};
          const paramParts = customPromptServer ? subParts : subParts.slice(2);
          for (const item of paramParts) {
            const idx = item.indexOf("=");
            if (idx > 0) paramObj[item.slice(0, idx)] = item.slice(idx + 1);
          }
          const promptRes = await mcpMgr.promptManager.getPrompt(server, promptName, paramObj);
          terminalUI.renderInfo(`\n\x1b[32m✔ 获取 MCP Prompt '${promptName}':\x1b[0m\n`);
          console.log(JSON.stringify(promptRes, null, 2));
          console.log("");
        } catch (err: unknown) {
          terminalUI.renderError(`获取 Prompt 失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      return { handled: true };
    }
    case "diff": {
      const cwd = projectContext?.projectRoot ?? baseDir ?? process.cwd();
      try {
        const [{ stdout }, { stdout: diffStat }] = await Promise.all([
          execFileAsync("git", ["status", "--short", "--"], { cwd, maxBuffer: 256 * 1024 }),
          execFileAsync("git", ["diff", "--stat", "--"], { cwd, maxBuffer: 256 * 1024 }),
        ]);
        const lines = stdout.trim().split("\n").filter(Boolean);
        const detail = lines.length ? lines.slice(0, 30).join("\n") + (lines.length > 30 ? `\n… ${lines.length - 30} more` : "") : "No local changes";
        const message = `Working tree · ${lines.length} changed paths\n${detail}${diffStat.trim() ? `\nDiff summary:\n${diffStat.trim()}` : ""}`;
        if (context.cliPresenter) context.cliPresenter.showReview(message);
        else terminalUI.renderInfo(message);
      } catch {
        terminalUI.renderWarning("Could not read Git changes in this project.");
      }
      return { handled: true };
    }
    case "status": {
      await runDirectOutput(() => {
        if (context.statusProvider) {
          const info = context.statusProvider();
          terminalUI.renderStatus(info);
        } else {
          terminalUI.renderInfo("(状态提供者未初始化)");
        }
      });
      return { handled: true };
    }

    case "jobs": {
      await runDirectOutput(() => {
        if (!jobManager) {
          terminalUI.renderInfo("\n\x1b[90m(当前无活跃 JobManager 实例)\x1b[0m\n");
          return;
        }
        const jobs = jobManager.listJobs();
        terminalUI.renderJobs(jobs);
      });
      return { handled: true };
    }

    case "copy": {
      if (context.cliPresenter) {
        context.cliPresenter.copyLatestResponseToClipboard();
      } else {
        terminalUI.renderInfo("(当前无活跃 CLI Presenter 实例)");
      }
      return { handled: true };
    }

    case "job": {
      await runDirectOutput(() => {
        if (!jobManager) {
          terminalUI.renderInfo("\n\x1b[90m(当前无活跃 JobManager 实例)\x1b[0m\n");
          return;
        }

        if (!args) {
          terminalUI.renderWarning("请指定 Job ID。例如: /job job-1\n");
          return;
        }

        const record = jobManager.getJobRecord(args);
        if (!record) {
          terminalUI.renderError(`未找到 Job "${args}"。输入 /jobs 查看全部列表。\n`);
          return;
        }

        const jobInstance = jobManager.getJob(args);
        const tailOutput = jobInstance
          ? jobInstance.getBuffer().getTailLines(50)
          : (record.resultSummary || "");

        terminalUI.renderJobDetail(record, tailOutput);
      });
      return { handled: true };
    }

    case "resume": {
      const targetCtx =
        (typeof contextManager?.getProjectContext === "function"
          ? contextManager.getProjectContext()
          : undefined) || projectContext;
      const nashHome = targetCtx?.nashHome;

      const projectSessions = await LocalSessionStore.listSessionSummaries(targetSessionsRoot);
      const legacySessions = nashHome
        ? await LocalSessionStore.listLegacySessionSummaries(nashHome)
        : [];

      const allSessions: Array<
        import("../context/types.js").SessionSummary & {
          isLegacy?: boolean;
          sourceSessionsDir?: string;
        }
      > = [
        ...projectSessions.map((s) => ({ ...s, isLegacy: false })),
        ...legacySessions.map((s) => ({
          ...s,
          isLegacy: true,
          sourceSessionsDir: nashHome
            ? `${nashHome}/context/sessions`
            : undefined,
        })),
      ];
      allSessions.sort((a, b) => b.updatedAt - a.updatedAt);
      const interactivePicker = context.cliPresenter?.isInteractiveTTY() ?? false;

      const resumeNotice = (message: string, kind: "info" | "error" = "info") => {
        if (interactivePicker) context.cliPresenter!.showReview(message);
        else if (kind === "error") terminalUI.renderError(message);
        else terminalUI.renderInfo(message);
      };
      const activateSession = async (matched: typeof allSessions[number]) => {
        const previousId = contextManager.sessionId;
        const previous = allSessions.find((session) => session.sessionId === previousId);
        try {
          const summary = await contextManager.switchSession(
            matched.sessionId,
            matched.sourceSessionsDir ? { sessionsDir: matched.sourceSessionsDir } : undefined
          );
          await onSessionSwitched?.(matched.sessionId);
          if (interactivePicker) context.cliPresenter!.showReview(`Resumed session · ${summary.lastUserPrompt || summary.firstUserPrompt || summary.sessionId}`);
          else terminalUI.renderSessionResumed(summary);
        } catch (error) {
          try {
            await contextManager.switchSession(previousId, previous?.sourceSessionsDir ? { sessionsDir: previous.sourceSessionsDir } : undefined);
            await onSessionSwitched?.(previousId);
          } catch {}
          resumeNotice(`Could not resume session: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      };

      if (allSessions.length === 0) {
        resumeNotice("No saved sessions found in this project.");
        return { handled: true };
      }

      // 如果提供了参数，直接尝试恢复
      if (args.length > 0) {
        const matched = findMatchingSession(allSessions, args);
        if (!matched) {
          resumeNotice(`Session not found: "${args}". Open /resume to search saved sessions.`, "error");
          return { handled: true };
        }

        await activateSession(matched);
        return { handled: true };
      }

      if (interactivePicker) {
        const matched = await context.cliPresenter!.openResumePicker(allSessions, contextManager.sessionId);
        if (!matched) return { handled: true };
        await activateSession(matched);
        return { handled: true };
      }

      // 未提供参数，展示列表并进入交互式选择
      terminalUI.renderSessionList(allSessions, contextManager.sessionId);
      terminalUI.renderInfo(
        `Enter session number (1-${allSessions.length}), Session ID / prefix, or 'c' to cancel:`
      );

      let choiceInput: string;
      try {
        choiceInput = await inputManager.readUserMessage("\x1b[36mResume > \x1b[0m");
      } catch (err) {
        terminalUI.renderInfo("Resume cancelled.");
        return { handled: true };
      }

      const choice = choiceInput.trim();
      if (
        !choice ||
        choice.toLowerCase() === "c" ||
        choice.toLowerCase() === "cancel" ||
        choice.toLowerCase() === "q" ||
        choice.toLowerCase() === "exit"
      ) {
        terminalUI.renderInfo("Resume cancelled.\n");
        return { handled: true };
      }

      const matched = findMatchingSession(allSessions, choice);
      if (!matched) {
        terminalUI.renderError(`Invalid session selection: "${choice}".`);
        return { handled: true };
      }

      await activateSession(matched);
      return { handled: true };
    }

    case "session":
    case "sessions": {
      await runDirectOutput(async () => {
        if (command === "sessions" || args === "list") {
          const targetCtx =
            (typeof contextManager?.getProjectContext === "function"
              ? contextManager.getProjectContext()
              : undefined) || projectContext;
          const nashHome = targetCtx?.nashHome;
          const projectSessions = await LocalSessionStore.listSessionSummaries(targetSessionsRoot);
          const legacySessions = nashHome
            ? await LocalSessionStore.listLegacySessionSummaries(nashHome)
            : [];
          const allSessions = [
            ...projectSessions.map((s) => ({ ...s, isLegacy: false })),
            ...legacySessions.map((s) => ({ ...s, isLegacy: true })),
          ];
          terminalUI.renderSessionList(allSessions, contextManager.sessionId);
          return;
        }

        const summary = await contextManager.getSession().getSummary();
        terminalUI.renderSessionInfo(summary, true);
      });
      return { handled: true };
    }

    case "new": {
      const newSessionId = crypto.randomUUID();
      const summary = await contextManager.switchSession(newSessionId);
      if (onSessionSwitched) {
        await onSessionSwitched(newSessionId);
      }
      if (context.cliPresenter?.isInteractiveTTY()) {
        context.cliPresenter.getProjection("main").addSystemNotice(
          `\x1b[32m✓\x1b[0m \x1b[1mStarted new session:\x1b[0m \x1b[36m${newSessionId}\x1b[0m`
        );
        context.cliPresenter.showSteerFeedback(`✓ New session: ${newSessionId.slice(0, 8)}...`);
        context.cliPresenter.requestRender({ immediate: true });
      } else {
        terminalUI.renderInfo(
          `\n\x1b[32m✓ Started new session:\x1b[0m \x1b[36m${newSessionId}\x1b[0m\n`
        );
      }
      return { handled: true };
    }

    case "compact": {
      if (context.cliPresenter?.isInteractiveTTY()) {
        context.cliPresenter.showSteerFeedback("↻ Compacting context...");
        const compactionRecord = await contextManager.compactNow();
        if (!compactionRecord) {
          context.cliPresenter.showSteerFeedback("Context is currently too short to compact.");
        } else {
          const compactedMsgCount = compactionRecord.compactedRange
            ? Math.max(1, compactionRecord.compactedRange.endIndex - compactionRecord.compactedRange.startIndex + 1)
            : (compactionRecord.consolidatedCount ?? 1);
          context.cliPresenter.getProjection("main").addSystemNotice(
            `\x1b[32m✓\x1b[0m \x1b[1mContext compacted successfully!\x1b[0m Consolidated ${compactedMsgCount} message${compactedMsgCount === 1 ? "" : "s"}.`
          );
          context.cliPresenter.showSteerFeedback(
            `✓ Context compacted (${compactedMsgCount} message${compactedMsgCount === 1 ? "" : "s"} consolidated)`
          );
          context.cliPresenter.requestRender({ immediate: true });
        }
      } else {
        terminalUI.renderInfo("Compacting context...");
        const compactionRecord = await contextManager.compactNow();
        if (!compactionRecord) {
          terminalUI.renderInfo(
            "Context is currently too short or has too few messages to compact.\n"
          );
        } else {
          const compactedMsgCount = compactionRecord.compactedRange
            ? Math.max(1, compactionRecord.compactedRange.endIndex - compactionRecord.compactedRange.startIndex + 1)
            : (compactionRecord.consolidatedCount ?? 1);
          terminalUI.renderInfo(
            `\n\x1b[32m✓ Context compacted successfully!\x1b[0m Consolidated ${compactedMsgCount} message${compactedMsgCount === 1 ? "" : "s"}.\n`
          );
        }
      }
      return { handled: true };
    }

    case "agents": {
      await runDirectOutput(() => {
        if (!context.agentRegistry) {
          terminalUI.renderInfo("(当前无活跃 AgentRegistry 实例)");
          return;
        }

        terminalUI.renderInfo("\n\x1b[1m\x1b[36mActive Agents Tree\x1b[0m");
        const tree = formatAgentCentricView(context.agentRegistry, context.taskManager);
        console.log(tree + "\n");
      });
      return { handled: true };
    }

    case "agent": {
      await runDirectOutput(() => {
        if (!context.agentRegistry) {
          terminalUI.renderInfo("(当前无活跃 AgentRegistry 实例)");
          return;
        }

        if (!args) {
          terminalUI.renderWarning("请指定 Agent ID 或名称。例如: /agent reviewer\n");
          return;
        }

        const all = context.agentRegistry.getAllAgents();
        const target = all.find(
          (a) =>
            a.agentId.toLowerCase() === args.toLowerCase() ||
            a.name?.toLowerCase() === args.toLowerCase()
        );

        if (!target) {
          terminalUI.renderError(`未找到 Agent "${args}"。输入 /agents 查看全部列表。\n`);
          return;
        }

        terminalUI.renderInfo(`\n\x1b[1m\x1b[36mAgent Details: ${target.name ?? target.agentId}\x1b[0m`);
        console.log(`ID: ${target.agentId}`);
        console.log(`Type: ${target.type} | Depth: ${target.depth}`);
        console.log(`Status: ${target.status}`);
        if (target.role) console.log(`Role: ${target.role} (${target.roleDescription ?? ""})`);
        if (target.currentTaskId) console.log(`Current Task: ${target.currentTaskId}`);
        if (target.parentAgentId) console.log(`Parent Agent: ${target.parentAgentId}`);

        const activity = context.cliPresenter?.treeProjection.getActivity(target.agentId);
        if (activity?.summary) {
          console.log(`Current Activity: \x1b[33m${activity.summary}\x1b[0m`);
        }

        const metrics = context.cliPresenter?.metricsCollector.getPerAgentStats().find((m) => m.agentId === target.agentId);
        if (metrics) {
          console.log("\n[Metrics]");
          console.log(`  Model Calls: ${metrics.modelCalls} | Tool Calls: ${metrics.toolCalls}`);
          console.log(`  Tokens: ${metrics.inputTokens.toLocaleString()} in / ${metrics.outputTokens.toLocaleString()} out`);
        }
        console.log("");
      });
      return { handled: true };
    }

    case "tasks": {
      await runDirectOutput(() => {
        if (!context.taskManager) {
          terminalUI.renderInfo("(当前无活跃 TaskManager 实例)");
          return;
        }

        terminalUI.renderInfo("\n\x1b[1m\x1b[36mWork Plan / Task Graph\x1b[0m");
        const taskView = formatTaskCentricView(context.taskManager);
        console.log(taskView + "\n");
      });
      return { handled: true };
    }

    case "stats": {
      await runDirectOutput(() => {
        if (context.cliPresenter?.metricsCollector) {
          console.log("\n" + context.cliPresenter.metricsCollector.formatDetailedStats() + "\n");
        } else {
          terminalUI.renderInfo("(当前无统计数据)");
        }
      });
      return { handled: true };
    }

    case "memory": {
      const memService =
        context.memoryService ??
        new MemoryService({ projectContext: context.projectContext });

      const subParts = args.split(/\s+/).filter(Boolean);
      const subCmd = (subParts[0] || "").toLowerCase();
      const subArgs = subParts.slice(1).join(" ").trim();

      if (subCmd === "forget" || subCmd === "delete" || subCmd === "remove") {
        if (!subArgs) {
          terminalUI.renderWarning("Usage: /memory forget <id>");
          return { handled: true };
        }
        const ok = await memService.forget(subArgs);
        if (ok) {
          if (context.cliPresenter?.isInteractiveTTY()) {
            context.cliPresenter.getProjection("main").addSystemNotice(
              `\x1b[32m✓\x1b[0m \x1b[1mMemory record '${subArgs}' deprecated/removed.\x1b[0m`
            );
            context.cliPresenter.showSteerFeedback(`✓ Memory forgotten: ${subArgs}`);
            context.cliPresenter.requestRender({ immediate: true });
          } else {
            terminalUI.renderInfo(`\n\x1b[32m✓ Memory record '${subArgs}' deprecated/removed.\x1b[0m\n`);
          }
        } else {
          if (context.cliPresenter?.isInteractiveTTY()) {
            context.cliPresenter.showSteerFeedback(`Memory record '${subArgs}' not found.`);
          } else {
            terminalUI.renderError(`\nMemory record '${subArgs}' not found.\n`);
          }
        }
        return { handled: true };
      }

      await runDirectOutput(async () => {
        if (subCmd === "search") {
          if (!subArgs) {
            terminalUI.renderWarning("Usage: /memory search <query>");
            return;
          }
          const results = await memService.search(subArgs);
          if (results.length === 0) {
            terminalUI.renderInfo(`\nNo memories matched "${subArgs}".\n`);
            return;
          }
          terminalUI.renderInfo(`\n\x1b[1m\x1b[36mMemory Search Results (${results.length})\x1b[0m`);
          for (const entry of results) {
            const scopeTag = entry.scope === "project" ? "\x1b[35m[project]\x1b[0m" : "\x1b[34m[global]\x1b[0m";
            console.log(`  • ${scopeTag} \x1b[90m(${entry.id})\x1b[0m ${entry.content}`);
          }
          console.log("");
          return;
        }

        const scope = subCmd === "global" ? "global" : subCmd === "project" ? "project" : "all";
        const entries = await memService.getAll(scope);
        const active = entries.filter((e) => !e.deprecated);

        if (active.length === 0) {
          terminalUI.renderInfo(
            `\n\x1b[90m(No active ${scope === "all" ? "project or global" : scope} memory records found)\x1b[0m\n`
          );
          return;
        }

        const projectName = context.projectContext?.displayName ?? "Current Project";
        terminalUI.renderInfo(`\n\x1b[1m\x1b[36mMemory Records (${active.length} active)\x1b[0m`);

        const grouped = new Map<string, typeof active>();
        for (const e of active) {
          const key = `${e.scope}:${e.kind}`;
          const list = grouped.get(key) ?? [];
          list.push(e);
          grouped.set(key, list);
        }

        for (const [key, items] of grouped.entries()) {
          const [sc, kd] = key.split(":");
          const scopeLabel = sc === "project" ? `Project: ${projectName}` : "Global";
          console.log(`\n\x1b[1m${scopeLabel} · ${kd}\x1b[0m`);
          for (const item of items) {
            const srcTag = item.source === "user-explicit" ? " \x1b[33m(user-explicit)\x1b[0m" : "";
            console.log(`  • \x1b[90m[${item.id}]\x1b[0m ${item.content}${srcTag}`);
          }
        }
        console.log("");
      });
      return { handled: true };
    }

    case "remember": {
      if (!args) {
        terminalUI.renderWarning("Usage: /remember <fact or preference to remember>");
        return { handled: true };
      }
      const memService =
        context.memoryService ??
        new MemoryService({ projectContext: context.projectContext });

      const entry = await memService.remember({
        content: args,
        source: "user-explicit",
        confidence: 1.0,
      });

      if (entry) {
        if (context.cliPresenter?.isInteractiveTTY()) {
          context.cliPresenter.getProjection("main").addSystemNotice(
            `\x1b[32m✓\x1b[0m \x1b[1mRemembered:\x1b[0m "${entry.content}" \x1b[90m(${entry.id} · ${entry.scope})\x1b[0m`
          );
          context.cliPresenter.showSteerFeedback(`✓ Remembered: "${entry.content.slice(0, 25)}..."`);
          context.cliPresenter.requestRender({ immediate: true });
        } else {
          terminalUI.renderInfo(
            `\n\x1b[32m✓ Remembered:\x1b[0m "${entry.content}" \x1b[90m(${entry.id} · ${entry.scope})\x1b[0m\n`
          );
        }
      } else {
        if (context.cliPresenter?.isInteractiveTTY()) {
          context.cliPresenter.showSteerFeedback("Failed to save memory (subsystem disabled or error)");
        } else {
          terminalUI.renderError("\nFailed to save memory (Memory subsystem disabled or error).\n");
        }
      }
      return { handled: true };
    }

    case "skills":
    case "skill": {
      const skillService =
        context.skillService ??
        new SkillService({ projectContext: context.projectContext });

      const subParts = args.split(/\s+/).filter(Boolean);
      const subCmd = (subParts[0] || "").toLowerCase();
      const subArgs = subParts.slice(1).join(" ").trim();

      if (subCmd === "show" || subCmd === "open" || subCmd === "view") {
        if (!subArgs) {
          terminalUI.renderWarning("Usage: /skills show <skill-name>");
          return { handled: true };
        }
        await runDirectOutput(async () => {
          try {
            const def = await skillService.openSkill(subArgs);
            terminalUI.renderInfo(`\n\x1b[1m\x1b[36mSkill: ${def.metadata.name} [${def.metadata.scope}]\x1b[0m`);
            console.log(`\x1b[90m${def.metadata.description}\x1b[0m\n`);
            if (def.whenToUse) {
              console.log(`\x1b[1mWhen to use:\x1b[0m\n${def.whenToUse}\n`);
            }
            console.log(`\x1b[1mProcedure:\x1b[0m\n${def.procedure}\n`);
            if (def.verification) {
              console.log(`\x1b[1mVerification:\x1b[0m\n${def.verification}\n`);
            }
            if (def.referenceFiles && def.referenceFiles.length > 0) {
              console.log(`References: ${def.referenceFiles.join(", ")}`);
            }
            if (def.scriptFiles && def.scriptFiles.length > 0) {
              console.log(`Scripts: ${def.scriptFiles.join(", ")}`);
            }
            console.log("");
          } catch (err: unknown) {
            terminalUI.renderError(`\n${err instanceof Error ? err.message : String(err)}\n`);
          }
        });
        return { handled: true };
      }

      // 若处于交互式 TTY 界面且无子命令，直接弹出交互式 Skills 管理器 (/skills)
      if (subParts.length === 0 && context.cliPresenter?.isInteractiveTTY()) {
        await context.cliPresenter.openSkillsPicker(skillService);
        return { handled: true };
      }

      await runDirectOutput(async () => {
        const all = await skillService.getAllSkillsWithModes();
        if (all.length === 0) {
          terminalUI.renderInfo("\n\x1b[90m(No skills available in global or project scope)\x1b[0m\n");
          return;
        }

        terminalUI.renderInfo(`\n\x1b[1m\x1b[36mAvailable Skills (${all.length})\x1b[0m`);
        const projectSkills = all.filter((s) => s.metadata.scope === "project");
        const globalSkills = all.filter((s) => s.metadata.scope === "global");

        if (projectSkills.length > 0) {
          console.log(`\n\x1b[1mProject Skills\x1b[0m`);
          for (const s of projectSkills) {
            const modeTag = s.mode === "on" ? "\x1b[32m[on]\x1b[0m" : `\x1b[90m[${s.mode}]\x1b[0m`;
            console.log(`  ${modeTag} \x1b[32m${s.metadata.name.padEnd(26)}\x1b[0m ${s.metadata.description}`);
          }
        }

        if (globalSkills.length > 0) {
          console.log(`\n\x1b[1mGlobal Skills\x1b[0m`);
          for (const s of globalSkills) {
            const modeTag = s.mode === "on" ? "\x1b[32m[on]\x1b[0m" : `\x1b[90m[${s.mode}]\x1b[0m`;
            console.log(`  ${modeTag} \x1b[36m${s.metadata.name.padEnd(26)}\x1b[0m ${s.metadata.description}`);
          }
        }
        console.log(`\n\x1b[90mTip: Type '/skills' to open interactive picker, or '/skills show <name>' to view full procedure.\x1b[0m\n`);
      });
      return { handled: true };
    }

    case "context": {
      await runDirectOutput(async () => {
        terminalUI.renderInfo("\n\x1b[1m\x1b[36mActive Context Audit & Hierarchy\x1b[0m\n");

        // 1. Repository Instructions
        const repoRoot = projectContext?.projectRoot ?? baseDir ?? process.cwd();
        const repoIns = await loadRepositoryInstructions(repoRoot);
        console.log(`\x1b[1m1. Repository Instructions:\x1b[0m ${repoIns.hasInstructions ? `\x1b[32mLoaded (${repoIns.sourceFile}, ${repoIns.content.length} chars)\x1b[0m` : "\x1b[90mNone (No AGENTS.md / CLAUDE.md)\x1b[0m"}`);

        // 2. Memory Subsystem
        const memService = context.memoryService ?? new MemoryService({ projectContext: context.projectContext });
        const memEntries = await memService.getAll();
        const activeMem = memEntries.filter((e) => !e.deprecated);
        console.log(`\x1b[1m2. Memory Store:\x1b[0m \x1b[32m${activeMem.length} active entries\x1b[0m (${activeMem.filter((e) => e.scope === "project").length} project, ${activeMem.filter((e) => e.scope === "global").length} global)`);

        // 3. Skills Subsystem
        const skillService = context.skillService ?? new SkillService({ projectContext: context.projectContext });
        const skills = await skillService.listAllSkills();
        console.log(`\x1b[1m3. Available Skills:\x1b[0m \x1b[32m${skills.length} discovered\x1b[0m (${skills.filter((s) => s.scope === "project").length} project, ${skills.filter((s) => s.scope === "global").length} global)`);

        // 4. Current Session State
        const summary = await contextManager.getSession().getSummary();
        console.log(`\x1b[1m4. Active Session:\x1b[0m ID: ${contextManager.sessionId}`);
        console.log(`   Messages: ${summary.messageCount} | Compaction: ${summary.hasCompaction ? "\x1b[33mYes\x1b[0m" : "No"}`);
        console.log("");
      });
      return { handled: true };
    }

    case "help": {
      await runDirectOutput(() => {
        terminalUI.renderHelp();
      });
      return { handled: true };
    }

    case "exit":
    case "quit": {
      return { handled: true, shouldExit: true };
    }

    default: {
      terminalUI.renderWarning(
        `Unknown command: "/${command}". Type /help for a list of available commands.\n`
      );
      return { handled: true };
    }
  }
}

/**
 * 根据用户输入的数字序号、完整 UUID 或 ID 前缀在会话列表中定位目标
 */
function findMatchingSession<T extends { sessionId: string }>(
  sessions: T[],
  query: string
): T | undefined {
  const normalized = query.trim().toLowerCase();

  // 1. 尝试数字序号匹配 (1-based index)
  const num = /^\d+$/.test(normalized) ? Number(normalized) : NaN;
  if (Number.isInteger(num) && num >= 1 && num <= sessions.length) {
    return sessions[num - 1];
  }

  // 2. 尝试完整 Session ID 严格匹配
  const exact = sessions.find((s) => s.sessionId.toLowerCase() === normalized);
  if (exact) return exact;

  // 3. 尝试 Session ID 前缀匹配
  const prefixMatches = sessions.filter((s) =>
    s.sessionId.toLowerCase().startsWith(normalized)
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  return undefined;
}
