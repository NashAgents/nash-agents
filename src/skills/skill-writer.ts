import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { SkillMetadata, SkillScope } from "./types.js";
import { validateSkillName, assertSafeSkillPath } from "./skill-paths.js";
import { formatSkillMarkdown } from "./frontmatter.js";
import { containsSecret, sanitizeSecretText } from "../memory/secret-sanitizer.js";

export interface CreateSkillInput {
  name: string;
  description: string;
  whenToUse: string;
  procedure: string;
  verification: string;
  scope?: SkillScope;
  references?: Record<string, string>; // filename -> content
  scripts?: Record<string, string>; // filename -> script content
}

/**
 * Skill 创建与持久化写入器
 */
export class SkillWriter {
  constructor(
    private readonly globalDir: string,
    private readonly projectDir?: string
  ) {}

  /**
   * 创建或更新一个 Skill
   */
  async createSkill(input: CreateSkillInput): Promise<SkillMetadata> {
    const rawName = input.name.trim();
    validateSkillName(rawName);

    const name = rawName.toLowerCase();
    let description = input.description.trim();
    let whenToUse = input.whenToUse.trim();
    let procedure = input.procedure.trim();
    let verification = input.verification.trim();

    if (!description) {
      throw new Error("Skill 描述 (description) 不能为空。");
    }
    if (!procedure) {
      throw new Error("Skill 执行步骤 (procedure) 不能为空。");
    }
    if (!verification) {
      throw new Error("Skill 验证与验收步骤 (verification) 不能为空。");
    }

    // Secret 扫描与净化
    if (containsSecret(description)) description = sanitizeSecretText(description);
    if (containsSecret(whenToUse)) whenToUse = sanitizeSecretText(whenToUse);
    if (containsSecret(procedure)) procedure = sanitizeSecretText(procedure);
    if (containsSecret(verification)) verification = sanitizeSecretText(verification);

    const scope: SkillScope = input.scope ?? (this.projectDir ? "project" : "global");
    const targetRoot = scope === "project" && this.projectDir ? this.projectDir : this.globalDir;

    const skillDir = path.join(targetRoot, name);
    assertSafeSkillPath(targetRoot, skillDir);

    await fs.mkdir(skillDir, { recursive: true });

    // 1. 生成并写入 SKILL.md
    const skillMdContent = formatSkillMarkdown({
      name,
      description,
      whenToUse: whenToUse || "When performing this verified workflow.",
      procedure,
      verification,
    });

    const skillMdPath = path.join(skillDir, "SKILL.md");
    const tmpPath = `${skillMdPath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, skillMdContent, "utf-8");
    await fs.rename(tmpPath, skillMdPath);

    // 2. 写入可选的 references/
    let hasReferences = false;
    if (input.references && Object.keys(input.references).length > 0) {
      const refDir = path.join(skillDir, "references");
      await fs.mkdir(refDir, { recursive: true });
      for (const [refName, refContent] of Object.entries(input.references)) {
        const refPath = path.join(refDir, refName);
        assertSafeSkillPath(refDir, refPath);
        const cleanRef = containsSecret(refContent) ? sanitizeSecretText(refContent) : refContent;
        await fs.writeFile(refPath, cleanRef, "utf-8");
      }
      hasReferences = true;
    }

    // 3. 写入可选的 scripts/
    let hasScripts = false;
    if (input.scripts && Object.keys(input.scripts).length > 0) {
      const scriptDir = path.join(skillDir, "scripts");
      await fs.mkdir(scriptDir, { recursive: true });
      for (const [scriptName, scriptContent] of Object.entries(input.scripts)) {
        const scriptPath = path.join(scriptDir, scriptName);
        assertSafeSkillPath(scriptDir, scriptPath);
        const cleanScript = containsSecret(scriptContent) ? sanitizeSecretText(scriptContent) : scriptContent;
        await fs.writeFile(scriptPath, cleanScript, "utf-8");
      }
      hasScripts = true;
    }

    return {
      name,
      description,
      scope,
      directoryPath: skillDir,
      skillFilePath: skillMdPath,
      whenToUse: whenToUse || undefined,
      hasReferences,
      hasScripts,
    };
  }

  /**
   * 删除指定 Skill
   */
  async deleteSkill(name: string, scope?: SkillScope): Promise<boolean> {
    validateSkillName(name);
    const targetRoot =
      scope === "project" && this.projectDir
        ? this.projectDir
        : scope === "global"
        ? this.globalDir
        : this.projectDir ?? this.globalDir;

    const skillDir = path.join(targetRoot, name.toLowerCase());
    if (fsSync.existsSync(skillDir)) {
      assertSafeSkillPath(targetRoot, skillDir);
      await fs.rm(skillDir, { recursive: true, force: true });
      return true;
    }

    // 若未指定 scope 且在 project 未找到，尝试在 global 寻找
    if (!scope && fsSync.existsSync(path.join(this.globalDir, name.toLowerCase()))) {
      const gDir = path.join(this.globalDir, name.toLowerCase());
      assertSafeSkillPath(this.globalDir, gDir);
      await fs.rm(gDir, { recursive: true, force: true });
      return true;
    }

    return false;
  }
}
