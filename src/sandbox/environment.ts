import os from "node:os";

/**
 * 默认允许子进程继承的安全基础环境变量白名单
 */
const DEFAULT_INHERIT_VARS = new Set<string>([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  "PWD",
  // Windows 平台基础环境支撑变量
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "SYSTEMDRIVE",
  "COMSPEC",
  "ComSpec",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PATHEXT",
  "TEMP",
  "TMP",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/**
 * 敏感凭据、密钥及特权 IPC socket 过滤正则模式
 * 包含各种 API_KEY、TOKEN、SECRET、PASSWORD、CREDENTIALS，以及能够连接宿主 privileged socket 的 IPC 环境变量
 */
const SENSITIVE_KEY_PATTERN =
  /(^DEEPSEEK_API_KEY$|_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS|^AWS_|^GITHUB_TOKEN|^OPENAI_|^ANTHROPIC_|^SSH_AUTH_SOCK$|^GPG_AGENT_INFO$|^DBUS_SESSION_BUS_ADDRESS$|^DOCKER_HOST$|^CONTAINER_HOST$|^XDG_RUNTIME_DIR$)/i;

/**
 * 清理 PATH 环境变量，移除以 '.' 或空字符串等表示当前目录的潜在恶意路径前缀
 */
function sanitizePath(rawPath?: string): string {
  if (!rawPath) {
    return process.platform === "win32"
      ? "C:\\Windows\\system32;C:\\Windows"
      : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = rawPath.split(sep);
  const cleaned = parts.filter((part) => {
    const trimmed = part.trim();
    if (
      !trimmed ||
      trimmed === "." ||
      trimmed.startsWith("./") ||
      trimmed.startsWith(".\\")
    ) {
      return false;
    }
    return true;
  });
  if (cleaned.length === 0) {
    return process.platform === "win32"
      ? "C:\\Windows\\system32;C:\\Windows"
      : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  }
  return cleaned.join(sep);
}

/**
 * 构建沙箱子进程运行所需的纯净、安全的环境变量对象。
 *
 * 核心安全保证：
 * 1. 绝不盲目继承宿主进程 (Harness) 的完整 process.env；
 * 2. 严厉屏蔽 Harness 私密凭据（如各类 API Key、Token 和密码）与特权 Unix Socket 环境变量；
 * 3. 严格清洗 PATH，杜绝相对路径注入；
 * 4. 统一集中管理，杜绝在各工具中分散过滤逻辑。
 *
 * @param overrides - 调用方希望显式注入或覆盖的环境变量
 * @param sourceEnv - 源环境变量字典，默认为 process.env（可用于单测注入）
 * @returns 净化后的环境变量字典
 */
export function buildSandboxEnvironment(
  overrides?: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  // 1. 从源环境变量中严格提取白名单变量
  for (const key of DEFAULT_INHERIT_VARS) {
    const value = sourceEnv[key];
    if (value !== undefined && !SENSITIVE_KEY_PATTERN.test(key)) {
      sanitized[key] = value;
    }
  }

  // 2. 清理与规范化 PATH
  sanitized.PATH = sanitizePath(sanitized.PATH);

  // 3. 确保最基本的 HOME 存在有效值
  if (!sanitized.HOME) {
    try {
      sanitized.HOME = os.homedir();
    } catch {}
  }

  // 4. 合并用户显式指定的 overrides，但仍进行严格的敏感信息二次审查过滤
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!SENSITIVE_KEY_PATTERN.test(key)) {
        if (key === "PATH") {
          sanitized[key] = sanitizePath(value);
        } else {
          sanitized[key] = value;
        }
      }
    }
  }

  return sanitized;
}
