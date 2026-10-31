import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

export interface RepositoryInstructionsResult {
  hasInstructions: boolean;
  sourceFile?: string;
  content: string;
}

/**
 * 从项目工作区根目录安全加载人类维护的仓库长期规则 (AGENTS.md 优先，CLAUDE.md 兼容)
 */
export async function loadRepositoryInstructions(
  workspaceRoot: string
): Promise<RepositoryInstructionsResult> {
  const root = path.resolve(workspaceRoot);

  // 1. 优先检查 AGENTS.md
  const agentsMdPath = path.join(root, "AGENTS.md");
  if (fsSync.existsSync(agentsMdPath)) {
    try {
      const raw = await fs.readFile(agentsMdPath, "utf-8");
      return {
        hasInstructions: true,
        sourceFile: "AGENTS.md",
        content: raw.trim(),
      };
    } catch {}
  }

  // 2. 其次检查 CLAUDE.md
  const claudeMdPath = path.join(root, "CLAUDE.md");
  if (fsSync.existsSync(claudeMdPath)) {
    try {
      const raw = await fs.readFile(claudeMdPath, "utf-8");
      return {
        hasInstructions: true,
        sourceFile: "CLAUDE.md",
        content: raw.trim(),
      };
    } catch {}
  }

  return {
    hasInstructions: false,
    content: "",
  };
}
