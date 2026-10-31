import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { SkillDefinition, SkillMetadata } from "./types.js";
import { parseSkillMarkdown } from "./frontmatter.js";
import { assertSafeSkillPath } from "./skill-paths.js";

/**
 * 按需加载 Skill 完整内容与参考资源的 Loader (Level 2 & Level 3)
 */
export class SkillLoader {
  /**
   * 按需加载完整的 SKILL.md 定义 (Level 2)
   */
  async loadSkillDefinition(metadata: SkillMetadata): Promise<SkillDefinition> {
    assertSafeSkillPath(metadata.directoryPath, metadata.skillFilePath);

    if (!fsSync.existsSync(metadata.skillFilePath)) {
      throw new Error(`Skill 文件不存在: ${metadata.skillFilePath}`);
    }

    const raw = await fs.readFile(metadata.skillFilePath, "utf-8");

    // 探测 references/ 与 scripts/
    const refDir = path.join(metadata.directoryPath, "references");
    const scriptDir = path.join(metadata.directoryPath, "scripts");

    let referenceFiles: string[] = [];
    if (fsSync.existsSync(refDir)) {
      try {
        const files = await fs.readdir(refDir);
        referenceFiles = files.filter((f) => !f.startsWith("."));
      } catch {}
    }

    let scriptFiles: string[] = [];
    if (fsSync.existsSync(scriptDir)) {
      try {
        const files = await fs.readdir(scriptDir);
        scriptFiles = files.filter((f) => !f.startsWith("."));
      } catch {}
    }

    const definition = parseSkillMarkdown(raw, {
      name: metadata.name,
      scope: metadata.scope,
      directoryPath: metadata.directoryPath,
      skillFilePath: metadata.skillFilePath,
      hasReferences: referenceFiles.length > 0,
      hasScripts: scriptFiles.length > 0,
    });

    definition.referenceFiles = referenceFiles;
    definition.scriptFiles = scriptFiles;

    return definition;
  }

  /**
   * 按需读取 references/ 目录下的特定参考文档 (Level 3)
   */
  async loadReferenceDocument(
    metadata: SkillMetadata,
    referenceFileName: string
  ): Promise<string> {
    const refDir = path.join(metadata.directoryPath, "references");
    const targetFile = path.join(refDir, referenceFileName);

    assertSafeSkillPath(refDir, targetFile);

    if (!fsSync.existsSync(targetFile)) {
      throw new Error(
        `Skill '${metadata.name}' 的参考文档 '${referenceFileName}' 不存在。`
      );
    }

    return await fs.readFile(targetFile, "utf-8");
  }
}
