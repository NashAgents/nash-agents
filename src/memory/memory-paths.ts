import { resolveNashHome } from "../config/data-home.js";
import * as path from "node:path";
import * as os from "node:os";
import type { ProjectContext } from "../project/project-context.js";
import { generateProjectDirectoryName, normalizeProjectRoot } from "../project/project-id.js";

/**
 * 获取全局 Memory 目录路径 (NASH_HOME/memory/，默认 ~/.nash-agents)
 */
export function getGlobalMemoryDir(nashHome?: string): string {
  const home = nashHome ?? resolveNashHome();
  return path.join(home, "memory");
}

/**
 * 获取项目专属 Memory 目录路径 (NASH_HOME/projects/<project-dir>/memory/)
 */
export function getProjectMemoryDir(
  project?: ProjectContext | string,
  nashHome?: string
): string {
  const home = nashHome ?? resolveNashHome();

  if (project && typeof project === "object" && "projectDir" in project) {
    return path.join(project.projectDir, "memory");
  }

  const projectPath = typeof project === "string" ? project : process.cwd();
  const canonicalRoot = normalizeProjectRoot(projectPath);
  const dirName = generateProjectDirectoryName(canonicalRoot);
  return path.join(home, "projects", dirName, "memory");
}

/**
 * 校验指定路径是否安全位于允许的 Memory 根目录内 (防路径遍历)
 */
export function assertSafeMemoryPath(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `安全校验失败：Memory 路径 '${targetPath}' 超出合法基准目录 '${baseDir}' 范围。`
    );
  }
}
