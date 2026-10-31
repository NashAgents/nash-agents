/**
 * Windows 原生沙箱类型与协议定义
 */

export const EXPECTED_WINDOWS_HELPER_PROTOCOL_VERSION = 2;

export type WindowsShellType = "powershell" | "pwsh" | "cmd" | "bash" | "auto";

export type SandboxVerificationStatus =
  | "VERIFIED"
  | "AVAILABLE"
  | "DEGRADED"
  | "UNAVAILABLE"
  | "UNVERIFIED";

export interface WindowsSandboxVerificationResult {
  helperPath?: string;
  helperSha256?: string;
  verifiedAt?: number;
  verificationExpiresAt?: number;
  filesystemIsolationVerified: boolean;
  networkDenyVerified: boolean;
  networkAllowVerified: boolean;
  jobObjectsControlVerified: boolean;
  status: SandboxVerificationStatus;
  details: string[];
}

export interface WindowsHelperVersionInfo {
  protocolVersion: number;
  platform: string;
  arch: string;
  jobObjects: boolean;
  restrictedToken: boolean;
  appContainer: boolean;
  networkIsolation?: boolean;
  filesystemIsolation?: boolean;
  integrityLevels: boolean;
}

export interface WindowsSandboxHelperConfig {
  protocolVersion?: number;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBuffer?: number;
  maxProcesses?: number;
  memoryLimitBytes?: number;
  cpuRateLimitPercent?: number;
  dropAdminPrivileges?: boolean;
  restrictedTokenEnabled?: boolean;
  integrityLevel?: "low" | "medium" | "untrusted";
  appContainerEnabled?: boolean;
  appContainerName?: string;
  networkAllow?: boolean;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
}

export interface WindowsSandboxProbeResult {
  isWindows: boolean;
  osVersion: string;
  buildNumber: number;
  isElevated: boolean;
  jobObjectsAvailable: boolean;
  restrictedTokenAvailable: boolean;
  appContainerAvailable: boolean;
  networkIsolationAvailable: boolean;
  filesystemIsolationAvailable: boolean;
  helperAvailable: boolean;
  helperPath?: string;
  isolationStatus?: SandboxVerificationStatus;
  isolationVerification?: WindowsSandboxVerificationResult;
  availableShells: {
    powershell: boolean;
    pwsh: boolean;
    cmd: boolean;
    bash: boolean;
    gitBashPath?: string;
  };
  reason?: string;
}
