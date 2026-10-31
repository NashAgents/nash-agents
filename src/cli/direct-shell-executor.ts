import { redactString } from "../observability/redaction.js";
import { spawn } from "node:child_process";
import type { ContextManager } from "../context/context-manager.js";
import type { CliPresenter } from "../presentation/cli-presenter.js";
import type { InputManager } from "./input-manager.js";
import type { TerminalUI } from "./terminal-ui.js";

export interface DirectShellExecutionOptions {
  command: string;
  cwd: string;
  cliPresenter?: CliPresenter;
  inputManager?: InputManager;
  contextManager: ContextManager;
  terminalUI?: TerminalUI;
  writeToConsole?: boolean;
}

export interface DirectShellExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
  durationMs: number;
}

/**
 * 判断输入是否为直接 Shell 执行命令 (! <command>)
 */
export function isShellCommand(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("!");
}

/**
 * 格式化存入对话会话的命令与输出文本（统一对话记录格式）
 */
export function formatShellConversationBlock(
  command: string,
  output: string,
  exitCode: number,
  durationMs: number
): string {
  const durationStr =
    durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`;
  const cleanOutput = output.trim();
  return (
    `! ${command}\n\n` +
    `[Command Output]\n` +
    `$ ${command}\n` +
    `(exit ${exitCode} · ${durationStr})\n` +
    (cleanOutput ? cleanOutput : "(no output)")
  );
}

/**
 * 在当前工作区执行本地 Shell 命令并将结果直接落地到对话上下文
 */
export async function executeDirectShellCommand(
  options: DirectShellExecutionOptions
): Promise<DirectShellExecutionResult> {
  const {
    command,
    cwd,
    cliPresenter,
    inputManager,
    contextManager,
    writeToConsole,
  } = options;

  const isInteractiveTTY = Boolean(cliPresenter?.isInteractiveTTY());
  // 交互式 TTY 模式下由 Presenter 统一呈现 Transcript 卡片，杜绝裸终端输出与光标错位
  const shouldWriteConsole = writeToConsole ?? !isInteractiveTTY;

  // 1. 交互状态反馈：在执行中向用户呈现即时 Steer 状态
  if (isInteractiveTTY && cliPresenter) {
    cliPresenter.showSteerFeedback(`⚡ Running "! ${command.slice(0, 35)}"...`);
    cliPresenter.requestRender({ immediate: true });
  }

  const startTime = Date.now();
  let stdoutAccumulated = "";
  let stderrAccumulated = "";
  const MAX_RETAINED_CHARS = 50_000;

  const shellExecutable = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  const shellArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `$global:LASTEXITCODE = 0; $ErrorActionPreference = 'Stop'; ${command}; exit $global:LASTEXITCODE`]
    : ["-c", command];

  const exitCode = await new Promise<number>((resolve) => {
    try {
      const child = spawn(shellExecutable, shellArgs, {
        cwd,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (shouldWriteConsole) {
          process.stdout.write(text);
        }
        if (stdoutAccumulated.length < MAX_RETAINED_CHARS) {
          stdoutAccumulated += text.slice(
            0,
            MAX_RETAINED_CHARS - stdoutAccumulated.length
          );
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        if (shouldWriteConsole) {
          process.stderr.write(text);
        }
        if (stderrAccumulated.length < MAX_RETAINED_CHARS) {
          stderrAccumulated += text.slice(
            0,
            MAX_RETAINED_CHARS - stderrAccumulated.length
          );
        }
      });

      child.on("close", (code) => {
        resolve(code ?? 0);
      });

      child.on("error", (err) => {
        if (shouldWriteConsole) {
          process.stderr.write(`\nFailed to start shell process: ${err.message}\n`);
        }
        stderrAccumulated += `\nFailed to start shell process: ${err.message}`;
        resolve(1);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (shouldWriteConsole) {
        process.stderr.write(`\nError: ${msg}\n`);
      }
      stderrAccumulated += `\nError: ${msg}`;
      resolve(1);
    }
  });

  const durationMs = Math.max(1, Date.now() - startTime);

  // 组合完整输出
  let fullOutput = stdoutAccumulated;
  if (stderrAccumulated.trim()) {
    fullOutput += (fullOutput ? "\n" : "") + stderrAccumulated;
  }

  // 2. 将结果结构化追加至 Main Transcript 投影
  if (cliPresenter) {
    cliPresenter
      .getProjection("main")
      .addDirectShellCommand(command, fullOutput, exitCode, durationMs);
  }

  // 3. 构建规范对话文本并持久化至 session.jsonl
  const conversationText = formatShellConversationBlock(
    redactString(command),
    redactString(fullOutput),
    exitCode,
    durationMs
  );

  await contextManager.recordUserMessage(conversationText, {
    source: "direct-shell",
    isShellCommand: true,
    command: redactString(command),
    exitCode,
    durationMs,
    output: redactString(fullOutput),
  });

  // 4. 同步注入活跃 LLM 消息队列，确保后续多轮交互模型能够无缝感知
  await contextManager.appendActiveMessage({
    role: "user",
    content: conversationText,
  });

  // 5. 恢复终端交互式渲染
  if (isInteractiveTTY && cliPresenter) {
    const icon = exitCode === 0 ? "✓" : "✖";
    cliPresenter.showSteerFeedback(
      `${icon} ! ${command.slice(0, 30)} (exit ${exitCode} · ${durationMs}ms)`
    );
    cliPresenter.requestRender({ immediate: true });
  }

  return {
    command,
    exitCode,
    stdout: stdoutAccumulated,
    stderr: stderrAccumulated,
    output: fullOutput,
    durationMs,
  };
}
