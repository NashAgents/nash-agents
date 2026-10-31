import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureRuntimeRelease } from "../../runtime/release-info.js";
import { redactDiagnosticText } from "./service-preflight.js";
import {
  checkWorkingDirectory,
  checkEntrypoint,
  checkNodeRuntime,
  checkDatabaseConnectivity,
  sanitizeSecret,
} from "./service-preflight.js";

export interface ServiceDiagnostic {
  name: string;
  loaded: boolean;
  activeState: string;
  subState: string;
  unitFileState: string;
  workingDirectory?: string;
  mainPid?: number;
  environmentFiles?: string;
  credentialsInArguments?: boolean;
  execStart?: string;
  restartPolicy?: string;
  restartSec?: string;
  startLimitIntervalSec?: number;
  startLimitBurst?: number;
  restartPreventExitStatus?: number[];
  isDeprecated?: boolean;
  hasInfiniteRestartRisk: boolean;
  riskReason?: string;
  lastFailureResult?: string;
}

export interface DeploymentDiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  nodePath: string;
  deploymentPath: string;
  entrypoint: string;
  deploymentSource?: string;
  serviceName?: string;
  selectionError?: string;
  diskBuild?: { commit: string | null; dirty: boolean; artifactVerified?: boolean; artifactSha256?: string; artifactScope?: string; artifactFileCount?: number };
  releaseHealth?: "VERIFIED" | "DEGRADED" | "UNVERIFIED" | "STALE" | "BLOCKED";
  serviceRuntime?: "UNVERIFIED";
  entrypointExists: boolean;
  gitCommit?: string;
  systemdAvailable: boolean;
  services: ServiceDiagnostic[];
  database?: {
    configured: boolean;
    reachable: boolean;
    sanitizedUrl?: string;
    isTransient?: boolean;
    detail?: string;
    error?: string;
  };
  verdict: "READY" | "CONFIG_ERROR" | "DEPENDENCY_UNAVAILABLE" | "DEPLOYMENT_REQUIRED";
  verdictReason: string;
}

/**
 * 安全执行只读 shell 命令
 */
function safeExec(command: string, args: string[] = []): string {
  try {
    return execFileSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    return "";
  }
}

function systemdDurationSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) / 1_000_000;
  const factors: Record<string, number> = { us: 1e-6, "µs": 1e-6, ms: 1e-3, s: 1, min: 60, h: 3600, d: 86400, w: 604800 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(us|µs|ms|min|s|h|d|w)/g)];
  if (!parts.length) return undefined;
  return parts.reduce((total, match) => total + Number(match[1]) * factors[match[2]!]!, 0);
}

/**
 * 解析 systemctl show 输出为结构化服务属性
 */
export function parseSystemdUnitProperties(unitName: string, showOutput: string): ServiceDiagnostic {
  const diag: ServiceDiagnostic = {
    name: unitName,
    loaded: Boolean(showOutput),
    activeState: "unknown",
    subState: "unknown",
    unitFileState: "unknown",
    hasInfiniteRestartRisk: false,
  };

  if (unitName.includes("harness-agent")) {
    diag.isDeprecated = true;
    diag.riskReason = "Deprecated legacy Python backend. Should remain disabled.";
  }

  if (!showOutput) {
    diag.loaded = false;
    return diag;
  }

  const lines = showOutput.split("\n");
  const props: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx !== -1) {
      props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  diag.loaded = props.LoadState ? props.LoadState === "loaded" : Boolean(showOutput);
  diag.mainPid = Number(props.MainPID) || undefined;
  diag.environmentFiles = props.EnvironmentFiles || undefined;
  diag.credentialsInArguments = /postgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/i.test(props.ExecStart ?? "");
  diag.activeState = props.ActiveState || "unknown";
  diag.subState = props.SubState || "unknown";
  diag.unitFileState = props.UnitFileState || "unknown";
  diag.workingDirectory = props.WorkingDirectory || undefined;
  diag.execStart = props.ExecStart ? redactDiagnosticText(props.ExecStart) : undefined;
  diag.restartPolicy = props.Restart || "no";
  diag.restartSec = props.RestartUSec ? `${systemdDurationSeconds(props.RestartUSec) ?? props.RestartUSec}s` : props.RestartSec || undefined;
  diag.lastFailureResult = props.Result || undefined;

  // StartLimit
  diag.startLimitIntervalSec = systemdDurationSeconds(props.StartLimitIntervalUSec);
  if (props.StartLimitBurst) {
    diag.startLimitBurst = Number(props.StartLimitBurst);
  }

  // RestartPreventExitStatus
  if (props.RestartPreventExitStatus) {
    diag.restartPreventExitStatus = props.RestartPreventExitStatus.split(/\s+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  }

  // 若已被标记为废弃，直接返回
  if (diag.isDeprecated) {
    return diag;
  }

  // 评估无限重启风险
  const restarts = diag.restartPolicy === "always" || diag.restartPolicy === "on-failure";
  if (restarts) {
    const hasExitGuard = (diag.restartPreventExitStatus || []).includes(78);
    const hasCustomLimit = Boolean(diag.startLimitIntervalSec && diag.startLimitIntervalSec >= 30);

    if (!hasExitGuard && !hasCustomLimit) {
      diag.hasInfiniteRestartRisk = true;
      diag.riskReason =
        "Service restarts on failure without EX_CONFIG (78) guard and without extended rate limiting (StartLimitIntervalSec >= 30s). High risk of infinite crash loops.";
    }
  }

  return diag;
}

/**
 * 诊断单个 systemd 服务单元
 */
export function inspectSystemdUnit(unitName: string, mockOutput?: string): ServiceDiagnostic {
  const showOutput =
    mockOutput !== undefined
      ? mockOutput
      : safeExec(
          "systemctl", ["show", "-p", "LoadState,Description,ActiveState,SubState,UnitFileState,WorkingDirectory,ExecStart,MainPID,EnvironmentFiles,Restart,RestartUSec,StartLimitIntervalUSec,StartLimitBurst,RestartPreventExitStatus,Result,NRestarts", "--", unitName]
        );

  return parseSystemdUnitProperties(unitName, showOutput);
}

/**
 * Select the Nash-owned systemd units that the doctor should inspect.
 *
 * `systemctl list-unit-files` is authoritative for custom unit names (for
 * example a product unit installed as `nash-node1.service`). Keep the historical
 * names as fallbacks so the doctor still works on hosts where listing units is
 * unavailable or the unit is not yet enabled.
 */
export function selectNashServiceUnits(listUnitFilesOutput: string, explicitServiceName?: string): string[] {
  const discovered = listUnitFilesOutput
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s+/)[0])
    .filter((name): name is string =>
      Boolean(name && name.endsWith(".service") && (name.startsWith("nash-") || name === "harness-agent.service")));
  return [...new Set([
    ...(explicitServiceName ? [explicitServiceName] : []),
    ...discovered,
    "nash-cluster.service",
    "nash-worker.service",
    "nash-product.service",
    "harness-agent.service",
  ])];
}

export function resolveDeploymentTarget(options: { deploymentDir?: string; serviceName?: string }, services: ServiceDiagnostic[], cwd = process.cwd()) {
  const candidates = services.filter(service => service.loaded && !service.isDeprecated && service.activeState === "active");
  const service = options.serviceName ? services.find(service => service.name === options.serviceName && service.loaded)
    : candidates.length === 1 ? candidates[0] : undefined;
  const error = options.serviceName && !service ? `Service ${options.serviceName} is not loaded`
    : !options.serviceName && !options.deploymentDir && candidates.length > 1 ? "Multiple active Nash services; specify --service or --deployment-dir" : undefined;
  const directory = path.resolve(options.deploymentDir ?? service?.workingDirectory ?? cwd);
  const match = service?.execStart?.match(/(?:^|[\s"'=])([^\s"';{}]+[\/]dist[\/]index\.js)(?=[\s"';}]|$)/);
  const entrypoint = !options.deploymentDir && match ? path.resolve(service?.workingDirectory ?? directory, match[1]!) : path.join(directory, "dist", "index.js");
  return { directory, entrypoint, service, source: options.deploymentDir ? "explicit" : service?.workingDirectory ? "systemd" : "cwd", error };
}

/**
 * 运行全面的 Linux 部署与环境诊断
 */
export async function runDeploymentDiagnostics(options: {
  deploymentDir?: string;
  serviceName?: string;
  checkDb?: boolean;
} = {}): Promise<DeploymentDiagnosticReport> {
  const platform = process.platform;
  const arch = process.arch;
  const nodeVersion = process.versions.node;
  const nodePath = process.execPath;

  const systemdAvailable = process.platform === "linux" && Boolean(safeExec("systemctl", ["--version"]));
  const services: ServiceDiagnostic[] = [];
  if (systemdAvailable) {
    const listedUnits = safeExec("systemctl", ["list-unit-files", "--type=service", "--no-legend", "--no-pager"]);
    const knownUnits = selectNashServiceUnits(listedUnits, options.serviceName);
    for (const unit of knownUnits) {
      const diag = inspectSystemdUnit(unit);
      if (diag.loaded) services.push(diag);
    }
  }
  const target = resolveDeploymentTarget(options, services);
  const deploymentDir = target.directory;
  const entrypoint = target.entrypoint;
  const entrypointExists = fs.existsSync(entrypoint);
  const gitCommit = safeExec("git", ["-C", deploymentDir, "rev-parse", "HEAD"]) || undefined;
  const diskBuild = captureRuntimeRelease(path.dirname(entrypoint));
  const releaseHealth = target.error ? "BLOCKED" : !diskBuild.commit ? "UNVERIFIED"
    : diskBuild.dirty || !diskBuild.artifactVerified ? "DEGRADED" : gitCommit && gitCommit !== diskBuild.commit ? "STALE" : "VERIFIED";

  // 数据库诊断
  let databaseInfo: DeploymentDiagnosticReport["database"] = undefined;
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && options.checkDb !== false) {
    const dbCheck = await checkDatabaseConnectivity(dbUrl, { maxRetries: 1, timeoutMs: 2000 });
    databaseInfo = {
      configured: true,
      reachable: dbCheck.passed,
      sanitizedUrl: sanitizeSecret("DATABASE_URL", dbUrl),
      isTransient: dbCheck.isTransient,
      detail: dbCheck.detail,
      error: dbCheck.error,
    };
  }

  // 综合判定结论
  let verdict: DeploymentDiagnosticReport["verdict"] = "READY";
  let verdictReason = "All critical components and deployment assets are valid.";

  const dirCheck = checkWorkingDirectory(deploymentDir);
  const entryCheck = checkEntrypoint(entrypoint);
  const nodeCheck = checkNodeRuntime(24, 14);

  if (target.error) {
    verdict = "CONFIG_ERROR";
    verdictReason = target.error;
  } else if (!dirCheck.passed) {
    verdict = "CONFIG_ERROR";
    verdictReason = `Deployment directory is invalid: ${dirCheck.error}`;
  } else if (!entryCheck.passed) {
    verdict = "DEPLOYMENT_REQUIRED";
    verdictReason = `Entrypoint '${entrypoint}' is missing or not built. Build and sync dist/ to resolve.`;
  } else if (!nodeCheck.passed) {
    verdict = "CONFIG_ERROR";
    verdictReason = nodeCheck.error || "Incompatible Node.js version.";
  } else if (databaseInfo && !databaseInfo.reachable) {
    if (databaseInfo.isTransient) {
      verdict = "DEPENDENCY_UNAVAILABLE";
      verdictReason = `Database is temporarily unreachable: ${databaseInfo.error}`;
    } else {
      verdict = "CONFIG_ERROR";
      verdictReason = `Database configuration error: ${databaseInfo.error}`;
    }
  }

  return {
    platform,
    arch,
    nodeVersion,
    nodePath,
    deploymentPath: deploymentDir,
    deploymentSource: target.source,
    serviceName: target.service?.name,
    selectionError: target.error,
    diskBuild: { commit: diskBuild.commit, dirty: diskBuild.dirty, artifactVerified: diskBuild.artifactVerified, artifactSha256: diskBuild.artifactSha256, artifactScope: diskBuild.artifactScope, artifactFileCount: diskBuild.artifactFileCount },
    releaseHealth,
    serviceRuntime: "UNVERIFIED",
    entrypoint,
    entrypointExists,
    gitCommit,
    systemdAvailable,
    services,
    database: databaseInfo,
    verdict,
    verdictReason,
  };
}

/**
 * 格式化输出部署诊断报告
 */
export function formatDeploymentReport(report: DeploymentDiagnosticReport): string {
  const lines: string[] = [];
  lines.push("\n\x1b[1m\x1b[36m=== Nash Linux Deployment & Service Diagnostic Report ===\x1b[0m\n");

  lines.push("\x1b[1mSystem & Runtime Environment\x1b[0m");
  lines.push(`  Platform / Arch   \x1b[32m✓\x1b[0m ${report.platform} (${report.arch})`);
  lines.push(`  Node.js Binary    \x1b[32m✓\x1b[0m ${report.nodeVersion} (${report.nodePath})`);
  lines.push(`  Deployment Path   \x1b[32m✓\x1b[0m ${report.deploymentPath}`);
  lines.push(
    `  Application Entry ${
      report.entrypointExists ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"
    } ${report.entrypoint}`
  );
  lines.push(`  Deployment Source ${report.deploymentSource ?? "unknown"}${report.serviceName ? ` (${report.serviceName})` : ""}`);
  lines.push(`  Source / Build    [${report.releaseHealth ?? "UNVERIFIED"}] ${report.gitCommit ?? "unknown"} / ${report.diskBuild?.commit ?? "unstamped"}`);
  lines.push("  Service Runtime   [UNVERIFIED] Query the authenticated cluster API for live process identity and capability TTL.");
  if (report.gitCommit) {
    lines.push(`  Git Revision      \x1b[32m✓\x1b[0m commit ${report.gitCommit}`);
  }

  if (report.systemdAvailable) {
    lines.push("\n\x1b[1msystemd Services & Resilience\x1b[0m");
    if (report.services.length === 0) {
      lines.push("  No Nash units registered in systemd.");
    }
    for (const svc of report.services) {
      if (svc.isDeprecated) {
        lines.push(
          `  ${svc.name.padEnd(23)} \x1b[33m[DEPRECATED]\x1b[0m (${svc.activeState}/${svc.subState}, unit: ${svc.unitFileState})`
        );
        lines.push(`    \x1b[2mLegacy Python backend. Maintained disabled to prevent historical 91,552 crash-loop.\x1b[0m`);
        continue;
      }

      const activeColor = svc.activeState === "active" ? "\x1b[32m" : "\x1b[31m";
      lines.push(
        `  ${svc.name.padEnd(23)} ${activeColor}${svc.activeState}/${svc.subState}\x1b[0m (enabled: ${svc.unitFileState})`
      );
      lines.push(`    Working Directory:    ${svc.workingDirectory ?? "unknown"}`);
      lines.push(`    ExecStart:            ${svc.execStart ?? "unknown"}`);
      lines.push(`    Restart Policy:       Restart=${svc.restartPolicy}, RestartSec=${svc.restartSec || "default"}`);
      lines.push(
        `    Rate Limiting:        StartLimitIntervalSec=${svc.startLimitIntervalSec ?? "default (10s)"}, StartLimitBurst=${svc.startLimitBurst ?? "default (5)"}`
      );
      lines.push(
        `    Exit Guard:           RestartPreventExitStatus=${
          svc.restartPreventExitStatus?.length ? svc.restartPreventExitStatus.join(" ") : "none"
        }`
      );

      if (svc.hasInfiniteRestartRisk) {
        lines.push(`    \x1b[33m⚠️ Infinite Restart Risk:\x1b[0m ${svc.riskReason}`);
      } else {
        lines.push(`    \x1b[32m✓ Resilient Restart Configuration:\x1b[0m Protected against runaway restart loops.`);
      }
    }
  }

  if (report.database) {
    lines.push("\n\x1b[1mCluster Storage (PostgreSQL)\x1b[0m");
    if (report.database.reachable) {
      lines.push(`  Connection        \x1b[32m✓\x1b[0m Connected to ${report.database.sanitizedUrl}`);
    } else {
      const tag = report.database.isTransient ? "\x1b[33m[Transient]\x1b[0m" : "\x1b[31m[Permanent]\x1b[0m";
      lines.push(`  Connection        \x1b[31m✗\x1b[0m ${tag} ${report.database.error}`);
    }
  }

  lines.push("\n--------------------------------------------------");
  const verdictColors = {
    READY: "\x1b[1m\x1b[32m",
    CONFIG_ERROR: "\x1b[1m\x1b[31m",
    DEPENDENCY_UNAVAILABLE: "\x1b[1m\x1b[33m",
    DEPLOYMENT_REQUIRED: "\x1b[1m\x1b[35m",
  };
  lines.push(`${verdictColors[report.verdict]}[Verdict: ${report.verdict}]\x1b[0m`);
  lines.push(`  ${report.verdictReason}\n`);
  lines.push("  READY applies to deployment prerequisites only; live runtime and security require separate verification.");

  return lines.join("\n");
}
