import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import pg from "pg";

/**
 * 标准 POSIX 退出码规范 (RFC 遵循 sysexits.h)
 */
export const PREFLIGHT_EXIT_CODES = {
  SUCCESS: 0,
  /** EX_CONFIG (78): 配置错误、文件缺失、不可恢复环境问题 (systemd 绝不重试) */
  CONFIG_ERROR: 78,
  /** EX_TEMPFAIL (75): 暂时性外部依赖故障 (如 DB 启动中，systemd 可受控重试) */
  DEPENDENCY_ERROR: 75,
  /** 通用运行时异常 */
  RUNTIME_ERROR: 1,
} as const;

export type PreflightFailureKind = "PERMANENT_CONFIG_ERROR" | "TRANSIENT_DEPENDENCY_ERROR";

export interface PreflightCheckResult {
  name: string;
  passed: boolean;
  isTransient?: boolean;
  detail?: string;
  error?: string;
}

export interface PreflightReport {
  ok: boolean;
  classification?: PreflightFailureKind;
  exitCode: number;
  summary: string;
  checks: PreflightCheckResult[];
}

export interface PreflightOptions {
  workingDirectory?: string;
  entrypoint?: string;
  requiredNodeVersion?: string;
  listenHost?: string;
  listenPort?: number;
  checkPort?: boolean;
  databaseUrl?: string;
  checkDatabase?: boolean;
  dbProbeTimeoutMs?: number;
  dbProbeRetries?: number;
  requiredEnvVars?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * 敏感字段脱敏工具
 */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, raw => {
      try {
        const url = new URL(raw);
        if (url.password) url.password = "***";
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "***");
        return url.toString().replaceAll("%2A", "*");
      } catch { return "postgresql://[REDACTED]"; }
    })
    .replace(/((?:--)?(?:password|passwd|token|api[_-]?key|secret)\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;]+)/gi, "$1***");
}

export function sanitizeSecret(key: string, value: string): string {
  if (!value) return "";
  if (!/KEY|PASS|SECRET|TOKEN|CREDENTIAL|AUTH|DATABASE_URL/i.test(key)) return value;
  if (/^postgres(?:ql)?:\/\//i.test(value)) return redactDiagnosticText(value);
  if (value.length <= 8) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

/**
 * 校验工作目录合法性
 */
export function checkWorkingDirectory(targetDir: string): PreflightCheckResult {
  const result: PreflightCheckResult = {
    name: "Working Directory",
    passed: false,
  };

  try {
    if (!fs.existsSync(targetDir)) {
      result.error = `Path does not exist: ${targetDir}`;
      return result;
    }
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      result.error = `Path is not a directory: ${targetDir}`;
      return result;
    }
    // 检查基本读取与执行权限
    fs.accessSync(targetDir, fs.constants.R_OK | fs.constants.X_OK);
    result.passed = true;
    result.detail = targetDir;
  } catch (err) {
    result.error = `Access denied or invalid directory: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

/**
 * 校验应用入口文件合法性
 */
export function checkEntrypoint(entrypointPath: string): PreflightCheckResult {
  const result: PreflightCheckResult = {
    name: "Application Entrypoint",
    passed: false,
  };

  try {
    if (!fs.existsSync(entrypointPath)) {
      result.error = `Entrypoint file not found: ${entrypointPath}. Did you run build?`;
      return result;
    }
    const stat = fs.statSync(entrypointPath);
    if (!stat.isFile()) {
      result.error = `Entrypoint path is not a file: ${entrypointPath}`;
      return result;
    }
    if (stat.size === 0) {
      result.error = `Entrypoint file is empty (0 bytes): ${entrypointPath}`;
      return result;
    }
    fs.accessSync(entrypointPath, fs.constants.R_OK);
    result.passed = true;
    result.detail = `${entrypointPath} (${(stat.size / 1024).toFixed(1)} KB)`;
  } catch (err) {
    result.error = `Cannot access entrypoint: ${err instanceof Error ? err.message : String(err)}`;
  }
  return result;
}

/**
 * 校验 Node.js 运行时版本 (遵循 package.json engines)
 */
export function checkNodeRuntime(minMajor = 24, minMinor = 14): PreflightCheckResult {
  const currentVersion = process.versions.node;
  const result: PreflightCheckResult = {
    name: "Node.js Runtime",
    passed: false,
  };

  try {
    const parts = currentVersion.split(".").map(Number);
    const major = parts[0];
    const minor = parts[1];

    if (major !== minMajor || minor < minMinor) {
      result.error = `Node.js version v${currentVersion} does not satisfy engine requirement >=${minMajor}.${minMinor}.0 <${minMajor + 1}`;
      return result;
    }

    result.passed = true;
    result.detail = `v${currentVersion} (${process.execPath})`;
  } catch (err) {
    result.error = `Failed to parse Node.js version: ${String(err)}`;
  }
  return result;
}

/**
 * 校验监听端口可用性
 */
export async function checkPortAvailability(port: number, host = "127.0.0.1"): Promise<PreflightCheckResult> {
  const result: PreflightCheckResult = {
    name: `Port Availability (${host}:${port})`,
    passed: false,
  };

  return new Promise((resolve) => {
    const tester = net.createServer();

    tester.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        result.error = `Port ${port} is already in use by another process on ${host}`;
      } else if (err.code === "EACCES") {
        result.error = `Permission denied binding to port ${port} on ${host} (privileged port requires root)`;
      } else {
        result.error = `Cannot bind to port ${port}: ${err.message}`;
      }
      resolve(result);
    });

    tester.once("listening", () => {
      tester.close(() => {
        result.passed = true;
        result.detail = `Port ${port} is free and bindable on ${host}`;
        resolve(result);
      });
    });

    tester.listen(port, host);
  });
}

/**
 * 校验环境变量与必需配置
 */
export function checkEnvironmentVariables(
  requiredVars: string[] = [],
  env: NodeJS.ProcessEnv = process.env
): PreflightCheckResult {
  const result: PreflightCheckResult = {
    name: "Environment Variables",
    passed: false,
  };

  const missing: string[] = [];
  const configured: string[] = [];

  for (const v of requiredVars) {
    const val = env[v];
    if (val === undefined || val.trim() === "") {
      missing.push(v);
    } else {
      configured.push(`${v}=${sanitizeSecret(v, val)}`);
    }
  }

  if (missing.length > 0) {
    result.error = `Missing required environment variables: ${missing.join(", ")}`;
    return result;
  }

  result.passed = true;
  result.detail = configured.length > 0 ? `Configured: ${configured.join(", ")}` : "All required variables present";
  return result;
}

/**
 * 校验 PostgreSQL 可达性，支持快速重试探测并严格区分永久错误与暂时性错误
 */
export async function checkDatabaseConnectivity(
  dbUrl: string,
  options: { maxRetries?: number; retryDelayMs?: number; timeoutMs?: number } = {}
): Promise<PreflightCheckResult> {
  const result: PreflightCheckResult = {
    name: "PostgreSQL Connectivity",
    passed: false,
  };

  if (!dbUrl) {
    result.passed = false;
    result.isTransient = false;
    result.error = "DATABASE_URL is not configured";
    return result;
  }

  const sanitizedUrl = sanitizeSecret("DATABASE_URL", dbUrl);
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 3000;

  let lastErrorCode = "UNKNOWN";
  let isTransient = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = new pg.Client({
      connectionString: dbUrl,
      connectionTimeoutMillis: timeoutMs,
    });

    try {
      await client.connect();
      const queryRes = await client.query("SELECT 1 as healthy");
      await client.end();

      if (queryRes.rows?.[0]?.healthy === 1) {
        result.passed = true;
        result.detail = `Connected successfully to ${sanitizedUrl}`;
        return result;
      }
    } catch (err: any) {
      lastErrorCode = typeof err.code === "string" && /^[A-Z0-9_]+$/.test(err.code) ? err.code : "UNKNOWN";
      try {
        await client.end();
      } catch {}

      const code = err.code || "";
      const msg = err.message || "";

      // 分类：致命永久配置错误 vs 暂时性依赖未就绪错误
      if (
        code === "28P01" || // password authentication failed
        code === "3D000" || // database does not exist
        code === "28000" || // invalid authorization specification
        msg.includes("password authentication failed") ||
        msg.includes("database") && msg.includes("does not exist")
      ) {
        // 凭证或库名配置错误，无需重复重试，直接判定为永久错误
        isTransient = false;
        break;
      } else {
        // 网络/服务尚未启动等可能为暂时性错误
        isTransient = true;
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }

  result.passed = false;
  result.isTransient = isTransient;
  const errPrefix = isTransient ? "[Transient Failure] " : "[Permanent Config Error] ";
  result.error = `${errPrefix}Failed to connect to ${sanitizedUrl}: ${lastErrorCode}`;
  return result;
}

/**
 * 执行完整的 Service Startup Preflight 检查
 */
export async function runServicePreflight(options: PreflightOptions = {}): Promise<PreflightReport> {
  const cwd = options.workingDirectory ?? process.cwd();
  const entrypoint = options.entrypoint ?? path.join(cwd, "dist", "index.js");
  const host = options.listenHost ?? "127.0.0.1";
  const port = options.listenPort;
  const dbUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const envVars = options.requiredEnvVars ?? [];
  const checkDb = options.checkDatabase ?? Boolean(dbUrl);

  const checks: PreflightCheckResult[] = [];

  // 1. Working Directory Check
  checks.push(checkWorkingDirectory(cwd));

  // 2. Application Entrypoint Check
  checks.push(checkEntrypoint(entrypoint));

  // 3. Node.js Runtime Check
  checks.push(checkNodeRuntime(24, 14));

  // 4. Environment Variables Check
  if (envVars.length > 0) {
    checks.push(checkEnvironmentVariables(envVars, options.env));
  }

  // 5. Port Availability Check (仅当提供了非 0 端口且未显式关闭端口检查时)
  const shouldCheckPort = options.checkPort ?? true;
  if (shouldCheckPort && port && port > 0) {
    const portResult = await checkPortAvailability(port, host);
    checks.push(portResult);
  }

  // 6. PostgreSQL Connectivity Check (可选或按需)
  if (checkDb && dbUrl) {
    const dbResult = await checkDatabaseConnectivity(dbUrl, {
      maxRetries: options.dbProbeRetries,
      retryDelayMs: 1000,
      timeoutMs: options.dbProbeTimeoutMs,
    });
    checks.push(dbResult);
  }

  const failedChecks = checks.filter((c) => !c.passed);
  if (failedChecks.length === 0) {
    return {
      ok: true,
      exitCode: PREFLIGHT_EXIT_CODES.SUCCESS,
      summary: "All preflight checks passed. Environment is ready for launch.",
      checks,
    };
  }

  // 存在失败，根据失败项判断分类
  const hasPermanentError = failedChecks.some((c) => !c.isTransient);
  const classification: PreflightFailureKind = hasPermanentError
    ? "PERMANENT_CONFIG_ERROR"
    : "TRANSIENT_DEPENDENCY_ERROR";

  const exitCode =
    classification === "PERMANENT_CONFIG_ERROR"
      ? PREFLIGHT_EXIT_CODES.CONFIG_ERROR
      : PREFLIGHT_EXIT_CODES.DEPENDENCY_ERROR;

  const summary =
    classification === "PERMANENT_CONFIG_ERROR"
      ? `Permanent configuration error detected (${failedChecks.length} failed). Service startup blocked to prevent crash looping.`
      : `Transient dependency failure detected (${failedChecks.length} failed). Service may retry under bounded rate limits.`;

  return {
    ok: false,
    classification,
    exitCode,
    summary,
    checks,
  };
}

/**
 * 格式化预检报告用于终端或 systemd journal 日志输出
 */
export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("\n=== Nash Service Startup Preflight ===");

  for (const check of report.checks) {
    const icon = check.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const statusText = check.passed ? check.detail ?? "OK" : check.error ?? "Failed";
    lines.push(`  ${icon} ${check.name.padEnd(28)}: ${statusText}`);
  }

  lines.push("--------------------------------------------------");
  if (report.ok) {
    lines.push(`\x1b[32m[Preflight PASSED]\x1b[0m ${report.summary}\n`);
  } else {
    const color = report.classification === "PERMANENT_CONFIG_ERROR" ? "\x1b[31m" : "\x1b[33m";
    lines.push(`${color}[Preflight FAILED - ${report.classification}]\x1b[0m (Exit Code: ${report.exitCode})`);
    lines.push(`  ${report.summary}\n`);
  }

  return lines.join("\n");
}
