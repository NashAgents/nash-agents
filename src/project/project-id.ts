import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 将项目路径规范化为物理真实绝对路径 (解析符号链接并转为标准格式)
 */
export function normalizeProjectRoot(projectPath?: string): string {
  const targetPath = projectPath ? path.resolve(projectPath) : process.cwd();
  try {
    if (fs.existsSync(targetPath)) {
      return fs.realpathSync(targetPath);
    }
  } catch {
    // 若路径不存在或无法解析 realpath，回退到绝对路径
  }
  return targetPath;
}

/**
 * 根据项目物理路径生成人类可读的 DisplayName（基于 basename，保留合法 Unicode，做安全轻量过滤）
 */
export function getProjectDisplayName(projectPath?: string): string {
  const canonicalRoot = normalizeProjectRoot(projectPath);
  const baseName = path.basename(canonicalRoot);

  if (!baseName || baseName === "/" || baseName === "." || baseName === "..") {
    return "project";
  }

  // 移除非法文件系统控制字符与路径分隔符，保留常用 Unicode (中文/日文等)、字母、数字、短横线、下划线、点号
  // 非法字符：/ \ : * ? " < > | \x00-\x1f
  const sanitized = baseName
    .replace(/[/\s\\:*?"<>|\x00-\x1f]+/g, "_")
    .replace(/^_+|_+$/g, "");

  // 防御全是点号或下划线的边缘情况
  if (!sanitized || /^[\._]+$/.test(sanitized)) {
    return "project";
  }

  return sanitized;
}

/**
 * 根据规范化后的项目物理路径生成稳定的 Project ID
 * 算法：SHA-256(canonicalProjectRoot) 取前 16 位十六进制字符
 * 保证同一物理路径产生完全一致的 ID，不同路径极低碰撞
 */
export function generateProjectId(projectPath?: string): string {
  const canonicalRoot = normalizeProjectRoot(projectPath);
  return crypto.createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
}

/**
 * 生成人类可读的项目持久化目录名
 * 格式：<sanitized-display-name>__<short-project-id>
 * 例如：example-project__7d6b2ebd
 */
export function generateProjectDirectoryName(
  projectPath?: string,
  projectId?: string
): string {
  const canonicalRoot = normalizeProjectRoot(projectPath);
  const resolvedProjectId = projectId ?? generateProjectId(canonicalRoot);
  const displayName = getProjectDisplayName(canonicalRoot);
  const shortHash = resolvedProjectId.slice(0, 8);
  return `${displayName}__${shortHash}`;
}

/**
 * 校验生成的 projectDir 严格位于 projectsDir 内部，杜绝路径穿越
 */
export function assertSafeProjectDir(
  projectsRoot: string,
  projectDir: string
): void {
  const resolvedRoot = path.resolve(projectsRoot);
  const resolvedDir = path.resolve(projectDir);
  const relative = path.relative(resolvedRoot, resolvedDir);

  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep + ".." + path.sep)
  ) {
    throw new Error(
      `PathTraversalSecurityError: 项目目录 '${projectDir}' 超出了安全根目录 '${projectsRoot}'。`
    );
  }
}
