import { resolveNashHome } from "../config/data-home.js";
import * as path from "node:path";
import * as os from "node:os";
import type { ProjectContext } from "../project/project-context.js";
import { generateProjectDirectoryName, normalizeProjectRoot } from "../project/project-id.js";

const SAFE_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * 校验 Skill 名称是否合法安全 (杜绝特殊字符与路径穿越)
 */
export function validateSkillName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("Skill 名称不能为空。");
  }
  const trimmed = name.trim();
  if (!SAFE_SKILL_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `非法 Skill 名称 '${name}'：Skill 名称仅允许包含小写英文字母、数字、短横线与下划线，且必须以字母或数字开头。`
    );
  }
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`非法 Skill 名称 '${name}'：检测到路径遍历字符。`);
  }
}

/**
 * 获取全局 Skills 根目录 (NASH_HOME/skills/，默认 ~/.nash-agents)
 */
export function getGlobalSkillsDir(nashHome?: string): string {
  const home = nashHome ?? resolveNashHome();
  return path.join(home, "skills");
}

/**
 * 获取项目专属 Skills 根目录 (NASH_HOME/projects/<project-dir>/skills/)
 */
export function getProjectSkillsDir(
  project?: ProjectContext | string,
  nashHome?: string
): string {
  const home = nashHome ?? resolveNashHome();

  if (project && typeof project === "object" && "projectDir" in project) {
    return path.join(project.projectDir, "skills");
  }

  const projectPath = typeof project === "string" ? project : process.cwd();
  const canonicalRoot = normalizeProjectRoot(projectPath);
  const dirName = generateProjectDirectoryName(canonicalRoot);
  return path.join(home, "projects", dirName, "skills");
}

/**
 * 校验指定 Skill 路径是否安全位于允许的根目录下 (防路径穿越)
 */
export function assertSafeSkillPath(baseDir: string, targetPath: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `安全校验失败：Skill 路径 '${targetPath}' 超出合法基准目录 '${baseDir}' 范围。`
    );
  }
}
