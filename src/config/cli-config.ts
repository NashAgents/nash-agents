import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureNashSettings,
  FULL_ACCESS_SANDBOX_DEFAULTS,
  RESTRICTED_SANDBOX_DEFAULTS,
  type NashSettingsSchema,
} from "./nash-config.js";
import { loadSandboxPolicyFromSettings } from "./settings.js";

const SECURITY_MODES = ["full-access", "restricted"] as const;
type SecurityMode = (typeof SECURITY_MODES)[number];

function settingsPath(options?: { homeDir?: string }): string {
  return path.join(options?.homeDir ?? os.homedir(), ".nash", "settings.json");
}

function describe(mode: SecurityMode): string {
  return mode === "full-access"
    ? "完全访问自主模式：danger-full-access / network allow / approval auto-grant\n" +
      "  · 安全审查通过后自动执行，不再逐次弹窗\n" +
      "  · 确定性硬拦截仍然生效，安全审查不可用时 Fail-Closed"
    : "受限模式：workspace-write / network deny / approval ask\n" +
      "  · 越界与高风险操作逐次人工审批";
}

export class ConfigCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigCommandError";
  }
}

/**
 * 读取当前生效的安全策略，并说明它来自哪个配置文件。
 */
export function showSecurityConfig(options?: { homeDir?: string; projectRoot?: string }): string {
  const policy = loadSandboxPolicyFromSettings(undefined, options);
  const globalPath = settingsPath(options);
  const projectPath = path.join(options?.projectRoot ?? process.cwd(), "settings.json");
  const source = fs.existsSync(projectPath) && !options?.homeDir
    ? projectPath
    : fs.existsSync(globalPath) ? globalPath : "(内置默认)";
  return [
    `生效安全策略来源: ${source}`,
    `  filesystem: ${policy.filesystem.mode}`,
    `  network   : ${policy.network.mode}`,
    `  approval  : ${policy.approval.mode}`,
  ].join("\n");
}

/**
 * 修改全局 NASH_HOME/settings.json（默认 ~/.nash-agents）中的安全模式。
 *
 * 只改 sandbox 段，保留用户其余配置；既有安装不会被整体覆盖或迁移。
 */
export function setSecurityMode(mode: string, options?: { homeDir?: string }): string {
  if (!SECURITY_MODES.includes(mode as SecurityMode)) {
    throw new ConfigCommandError(`未知安全模式 '${mode}'。可选值: ${SECURITY_MODES.join(" | ")}`);
  }
  const target = mode as SecurityMode;

  // 确保目录与文件存在；首次创建时直接以目标模式初始化。
  ensureNashSettings({ homeDir: options?.homeDir, accessMode: target === "full-access" ? "full-access" : "restricted" });

  const file = settingsPath(options);
  const raw = fs.readFileSync(file, "utf-8");
  let parsed: NashSettingsSchema;
  try {
    parsed = JSON.parse(raw) as NashSettingsSchema;
  } catch (error) {
    throw new ConfigCommandError(`无法解析 ${file}，为避免覆盖损坏配置，已中止：${error instanceof Error ? error.message : String(error)}`);
  }

  parsed.sandbox = target === "full-access"
    ? { ...FULL_ACCESS_SANDBOX_DEFAULTS }
    : { ...RESTRICTED_SANDBOX_DEFAULTS };

  // 原子写入：先写临时文件再 rename，避免中途崩溃留下半个配置文件。
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf-8");
  fs.renameSync(tmp, file);

  return `已切换安全模式为 ${target}（${file}）\n${describe(target)}`;
}

/**
 * `nash config <show|set> ...`
 */
export async function handleConfigCommand(args: string[]): Promise<void> {
  const [sub, key, value] = args;
  try {
    if (!sub || sub === "help" || sub === "show") {
      console.log(showSecurityConfig());
      if (!sub) console.log("\n用法: nash config show | nash config set security <full-access|restricted>");
      return;
    }
    if (sub === "set") {
      if (key !== "security") {
        throw new ConfigCommandError("当前仅支持 `nash config set security <full-access|restricted>`");
      }
      if (!value) throw new ConfigCommandError("缺少安全模式值: full-access | restricted");
      console.log(setSecurityMode(value));
      return;
    }
    throw new ConfigCommandError(`未知子命令 '${sub}'。用法: nash config show | nash config set security <mode>`);
  } catch (error) {
    console.error(`\x1b[31m[config]\x1b[0m ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
