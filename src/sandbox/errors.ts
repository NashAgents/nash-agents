/**
 * 沙箱系统基础错误类型
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * 沙箱底层后端不可用或不可信异常（Fail-Closed 保证）
 */
export class SandboxUnavailableError extends SandboxError {
  constructor(message: string = "Sandbox backend is unavailable on the current platform.") {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/**
 * 沙箱通用拒绝异常
 */
export class SandboxDeniedError extends SandboxError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxDeniedError";
  }
}

/**
 * 文件系统安全策略拒绝异常
 */
export class FilesystemAccessDeniedError extends SandboxDeniedError {
  constructor(
    public readonly path: string,
    public readonly operation: "read" | "write",
    message?: string
  ) {
    const detail =
      message ??
      `拒绝文件系统 ${operation} 操作：路径 '${path}' 超出当前沙箱策略允许范围。`;
    super(detail);
    this.name = "FilesystemAccessDeniedError";
  }
}

/**
 * 网络安全策略拒绝异常（由后端沙箱真实阻断触发）
 */
export class NetworkAccessDeniedError extends SandboxDeniedError {
  constructor(
    public readonly command?: string,
    message: string = "进程网络访问被沙箱策略拒绝 (network: deny)。"
  ) {
    super(message);
    this.name = "NetworkAccessDeniedError";
  }
}

/**
 * 审批未获批准异常（用户拒绝审批或策略配置为 never 不允许审批提权）
 */
export class ApprovalDeniedError extends SandboxError {
  constructor(
    public readonly capability: string,
    public readonly target?: string,
    message?: string
  ) {
    const detail =
      message ??
      `权限请求已被拒绝：未获授权使用能力 '${capability}'${
        target ? `（目标: '${target}'）` : ""
      }。`;
    super(detail);
    this.name = "ApprovalDeniedError";
  }
}

/**
 * 资源限制不可用异常 (cgroup v2 不可用或缺乏 delegated 权限时 Fail-Closed)
 */
export class ResourceLimitUnavailableError extends SandboxError {
  constructor(
    message: string = "Resource limits (cgroup v2) are not available on the current platform or controllers are missing."
  ) {
    super(message);
    this.name = "ResourceLimitUnavailableError";
  }
}

