/**
 * 可选的 systemd 服务管理：渲染、安装（默认 dry-run）与受控重启。
 *
 * 安全边界：
 * - 不写任何文件，除非调用方显式传 `write: true`；
 * - 不覆盖既有 Unit，除非同时传 `force: true`；
 * - `systemctl daemon-reload` / `enable` / `start` 只在 `write: true` 且 `enable: true` 时执行；
 * - 重启前必须通过 `runServicePreflight`；预检失败（78/75）绝不触达 systemd。
 *
 * 所有命令执行均经可注入的 `CommandRunner`，测试不会触达真实系统。
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderCoordinatorUnit,
  renderWorkerUnit,
  renderProductUnit,
  type CoordinatorUnitInput,
  type WorkerUnitInput,
  type ProductUnitInput,
} from "./unit-renderer.js";
import { inspectSystemdUnit, type ServiceDiagnostic } from "../preflight/deployment-doctor.js";
import {
  runServicePreflight,
  redactDiagnosticText,
  type PreflightOptions,
  type PreflightReport,
} from "../preflight/service-preflight.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 命令执行器注入点；默认实现使用 execFile，绝不经过 shell。 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise<CommandResult>((resolve) => {
    execFile(command, args, { encoding: "utf-8", timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ exitCode: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
      resolve({
        exitCode: typeof code === "number" ? code : 127,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? error.message ?? ""),
      });
    });
  });

export const DEFAULT_UNIT_DIRECTORY = "/etc/systemd/system";
export const DEFAULT_UNIT_NAMES: Record<ServiceRole, string> = {
  coordinator: "nash-cluster.service",
  worker: "nash-worker.service",
  product: "nash-product.service",
};

export type ServiceRole = "coordinator" | "worker" | "product";
export type ServiceActionName = "daemon-reload" | "enable" | "start" | "restart";

const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,198}\.service$/;

export class ServiceManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceManagerError";
  }
}

/** 校验 Unit 名称，阻断 `../` 之类的目录穿越与非法字符。 */
export function validateUnitName(name: string): string {
  if (!UNIT_NAME_PATTERN.test(name) || name.includes("..")) {
    throw new ServiceManagerError(`Invalid systemd unit name: ${name}`);
  }
  return name;
}

export function resolveUnitName(role: ServiceRole, unitName?: string): string {
  return validateUnitName(unitName ?? DEFAULT_UNIT_NAMES[role]);
}

/**
 * 从当前模块位置推导包安装根目录（dist/cluster/service -> 包根）。
 * 用于让 WorkingDirectory 和 preflight 的 entrypoint 始终指向同一份产物。
 */
export function resolveDefaultInstallDir(): string {
  return path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
}

export interface ServiceActionReport {
  action: ServiceActionName;
  executed: boolean;
  skippedReason?: string;
  exitCode?: number;
  stderr?: string;
}

export interface InstallServiceUnitsResult {
  role: ServiceRole;
  unitName: string;
  unitPath: string;
  content: string;
  written: boolean;
  refused: boolean;
  dryRun: boolean;
  reason?: string;
  actions: ServiceActionReport[];
}

interface CommonInstallOptions {
  unitName?: string;
  unitDirectory?: string;
  /** 显式写盘；缺省为 dry-run */
  write?: boolean;
  /** 允许覆盖已存在的 Unit */
  force?: boolean;
  /** 显式请求 daemon-reload + enable + start；必须同时 write */
  enable?: boolean;
  /** 强制 dry-run，优先级高于 write */
  dryRun?: boolean;
  runner?: CommandRunner;
}

export type InstallServiceUnitsOptions =
  | ({ role: "coordinator"; input: CoordinatorUnitInput } & CommonInstallOptions)
  | ({ role: "worker"; input: WorkerUnitInput } & CommonInstallOptions)
  | ({ role: "product"; input: ProductUnitInput } & CommonInstallOptions);

function skipped(action: ServiceActionName, reason: string): ServiceActionReport {
  return { action, executed: false, skippedReason: reason };
}

async function executeAction(
  runner: CommandRunner,
  action: ServiceActionName,
  args: string[]
): Promise<ServiceActionReport> {
  let result: CommandResult;
  try {
    result = await runner("systemctl", args);
  } catch (error) {
    return {
      action,
      executed: false,
      skippedReason: `command failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    action,
    executed: true,
    exitCode: result.exitCode,
    stderr: result.exitCode === 0 ? undefined : redactDiagnosticText(result.stderr || result.stdout).slice(0, 500),
  };
}

/**
 * 渲染并（可选地）安装 Unit。
 * 缺省 dry-run：只返回渲染文本与目标路径，不创建目录、不写文件、不调用 systemctl。
 */
export async function installServiceUnits(options: InstallServiceUnitsOptions): Promise<InstallServiceUnitsResult> {
  const runner = options.runner ?? defaultCommandRunner;
  const unitName = resolveUnitName(options.role, options.unitName);
  const unitDirectory = options.unitDirectory ?? DEFAULT_UNIT_DIRECTORY;
  if (!path.isAbsolute(unitDirectory)) {
    throw new ServiceManagerError(`Unit directory must be absolute: ${unitDirectory}`);
  }
  const unitPath = path.join(unitDirectory, unitName);
  const content =
    options.role === "coordinator" ? renderCoordinatorUnit(options.input)
      : options.role === "worker" ? renderWorkerUnit(options.input) : renderProductUnit(options.input);

  const explicitDryRun = options.dryRun === true;
  const writeRequested = options.write === true && !explicitDryRun;
  // 默认即 dry-run：未显式请求写盘时，结果始终标记为 dry-run。
  const dryRun = !writeRequested;
  const base: InstallServiceUnitsResult = {
    role: options.role,
    unitName,
    unitPath,
    content,
    written: false,
    refused: false,
    dryRun,
    actions: [skipped("daemon-reload", "not requested"), skipped("enable", "not requested"), skipped("start", "not requested")],
  };

  if (!writeRequested) {
    return {
      ...base,
      reason: explicitDryRun
        ? "dry run: --dry-run requested (nothing written)"
        : "dry run: pass write: true (CLI --write) to install the unit",
    };
  }

  if (fs.existsSync(unitPath) && options.force !== true) {
    return {
      ...base,
      refused: true,
      reason: `Unit already exists: ${unitPath}. Pass --force to overwrite.`,
    };
  }

  try {
    fs.mkdirSync(unitDirectory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(unitPath, content, { encoding: "utf8" });
  } catch (error) {
    return {
      ...base,
      reason: `Failed to write ${unitPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const written: InstallServiceUnitsResult = { ...base, written: true, reason: `Unit written to ${unitPath}` };

  if (options.enable !== true) {
    written.actions = [
      skipped("daemon-reload", "systemctl not requested (pass --enable together with --write)"),
      skipped("enable", "systemctl not requested (pass --enable together with --write)"),
      skipped("start", "systemctl not requested (pass --enable together with --write)"),
    ];
    return written;
  }

  const plan: Array<{ action: ServiceActionName; args: string[] }> = [
    { action: "daemon-reload", args: ["daemon-reload"] },
    { action: "enable", args: ["enable", unitName] },
    { action: "start", args: ["start", unitName] },
  ];
  const actions: ServiceActionReport[] = [];
  for (const [index, step] of plan.entries()) {
    const report = await executeAction(runner, step.action, step.args);
    actions.push(report);
    const failed = !report.executed || report.exitCode !== 0;
    if (!failed) continue;
    for (const remaining of plan.slice(index + 1)) {
      actions.push(skipped(remaining.action, `${step.action} failed`));
    }
    return { ...written, actions, reason: step.action === "daemon-reload" ? "systemctl daemon-reload failed" : `systemctl ${step.action} ${unitName} failed` };
  }
  return { ...written, actions, reason: "Unit installed and started" };
}

export interface ServiceStatusResult {
  unitName: string;
  /** systemctl 是否可用；不可用时绝不抛错，只报告 false */
  available: boolean;
  unavailableReason?: string;
  diagnostic: ServiceDiagnostic;
  hasInfiniteRestartRisk: boolean;
}

const STATUS_SHOW_PROPERTIES = [
  "LoadState",
  "Description",
  "ActiveState",
  "SubState",
  "UnitFileState",
  "WorkingDirectory",
  "ExecStart",
  "MainPID",
  "EnvironmentFiles",
  "Restart",
  "RestartUSec",
  "StartLimitIntervalUSec",
  "StartLimitBurst",
  "RestartPreventExitStatus",
  "Result",
  "NRestarts",
].join(",");

/** 只读查询 Unit 状态与无限重启风险；systemd 缺失时返回 available:false，永不抛错。 */
export async function serviceStatus(
  unitName: string,
  options: { runner?: CommandRunner } = {}
): Promise<ServiceStatusResult> {
  const name = validateUnitName(unitName);
  const runner = options.runner ?? defaultCommandRunner;

  let version: CommandResult;
  try {
    version = await runner("systemctl", ["--version"]);
  } catch (error) {
    return unavailableStatus(name, error instanceof Error ? error.message : String(error));
  }
  if (version.exitCode !== 0) {
    return unavailableStatus(name, `systemctl not available (exit code ${version.exitCode})`);
  }

  let show: CommandResult;
  try {
    show = await runner("systemctl", ["show", "-p", STATUS_SHOW_PROPERTIES, "--", name]);
  } catch (error) {
    return unavailableStatus(name, error instanceof Error ? error.message : String(error));
  }
  if (show.exitCode !== 0) {
    return unavailableStatus(name, `systemctl show failed (exit code ${show.exitCode})`);
  }

  const diagnostic = inspectSystemdUnit(name, show.stdout);
  return {
    unitName: name,
    available: true,
    diagnostic,
    hasInfiniteRestartRisk: diagnostic.hasInfiniteRestartRisk,
  };
}

function unavailableStatus(unitName: string, reason: string): ServiceStatusResult {
  return {
    unitName,
    available: false,
    unavailableReason: reason,
    diagnostic: inspectSystemdUnit(unitName, ""),
    hasInfiniteRestartRisk: false,
  };
}

export interface RestartServiceOptions {
  /** 传给 runServicePreflight 的参数 */
  preflightOptions?: PreflightOptions;
  /** 测试注入点：默认 runServicePreflight */
  preflight?: (options: PreflightOptions) => Promise<PreflightReport>;
  /** 只有显式 confirm 才真正执行 systemctl restart */
  confirm?: boolean;
  runner?: CommandRunner;
}

export interface RestartServiceResult {
  unitName: string;
  restarted: boolean;
  exitCode: number;
  reason: string;
  preflight: PreflightReport;
  action: ServiceActionReport;
}

/**
 * 先预检、再重启。预检失败时保留 78/75 语义并直接返回，绝不触达 systemd。
 * 注意：重启场景下监听端口必然被现有进程占用，因此默认关闭端口可用性检查，
 * 否则任何正常运行的 Coordinator 都会被误判为永久配置错误。
 */
export async function restartService(
  unitName: string,
  options: RestartServiceOptions = {}
): Promise<RestartServiceResult> {
  const name = validateUnitName(unitName);
  const runner = options.runner ?? defaultCommandRunner;
  const preflight = options.preflight ?? runServicePreflight;
  const report = await preflight({
    workingDirectory: resolveDefaultInstallDir(),
    listenHost: "127.0.0.1",
    checkPort: false,
    ...options.preflightOptions,
  });

  if (!report.ok) {
    return {
      unitName: name,
      restarted: false,
      exitCode: report.exitCode,
      reason: report.summary,
      preflight: report,
      action: skipped("restart", "preflight failed"),
    };
  }

  if (options.confirm !== true) {
    return {
      unitName: name,
      restarted: false,
      exitCode: 1,
      reason: "restart requires explicit confirmation (CLI --confirm)",
      preflight: report,
      action: skipped("restart", "confirmation not provided"),
    };
  }

  const action = await executeAction(runner, "restart", ["restart", name]);
  const succeeded = action.executed && action.exitCode === 0;
  return {
    unitName: name,
    restarted: succeeded,
    exitCode: succeeded ? 0 : action.exitCode ?? 1,
    reason: succeeded ? `systemctl restart ${name} requested` : action.skippedReason ?? action.stderr ?? "restart failed",
    preflight: report,
    action,
  };
}
