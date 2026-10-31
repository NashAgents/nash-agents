import type { SkillMetadata, SkillDefinition, SkillScope } from "./types.js";

/**
 * 解析 SKILL.md 中的 Frontmatter 与 Markdown 主体
 */
export function parseSkillMarkdown(
  rawContent: string,
  options: {
    name: string;
    scope: SkillScope;
    directoryPath: string;
    skillFilePath: string;
    hasReferences?: boolean;
    hasScripts?: boolean;
  }
): SkillDefinition {
  let frontmatter: Record<string, string> = {};
  let body = rawContent;

  // 匹配开头的 --- frontmatter ---
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    const yamlLines = match[1].split("\n");
    for (const line of yamlLines) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
        if (key && value) {
          frontmatter[key] = value;
        }
      }
    }
    body = match[2];
  }

  const name = frontmatter.name || options.name;
  const description = frontmatter.description || "No description provided.";

  // 从正文中提取各核心段落 (When to use, Procedure, Verification)
  const extractSection = (headerPattern: RegExp): string => {
    const lines = body.split("\n");
    let capturing = false;
    const captured: string[] = [];

    for (const line of lines) {
      if (/^##\s+/.test(line)) {
        if (headerPattern.test(line)) {
          capturing = true;
          continue;
        } else if (capturing) {
          break;
        }
      }
      if (capturing) {
        captured.push(line);
      }
    }

    return captured.join("\n").trim();
  };

  const whenToUse =
    extractSection(/when\s+to\s+use|适用场景|何时使用/i) ||
    frontmatter.whenToUse ||
    "";
  const procedure =
    extractSection(/procedure|steps|执行步骤|操作规程/i) || body.trim();
  const verification =
    extractSection(/verification|verify|验证与验收|验证步骤/i) || "";

  const metadata: SkillMetadata = {
    name,
    description,
    scope: options.scope,
    directoryPath: options.directoryPath,
    skillFilePath: options.skillFilePath,
    whenToUse: whenToUse || undefined,
    hasReferences: options.hasReferences,
    hasScripts: options.hasScripts,
  };

  return {
    metadata,
    fullContent: rawContent,
    whenToUse,
    procedure,
    verification,
  };
}

/**
 * 将结构化定义序列化为标准的 SKILL.md 字符串
 */
export function formatSkillMarkdown(options: {
  name: string;
  description: string;
  whenToUse: string;
  procedure: string;
  verification: string;
}): string {
  const frontmatter = `---
name: ${options.name}
description: "${options.description.replace(/"/g, '\\"')}"
---

# ${options.name}

## When to use

${options.whenToUse.trim()}

## Procedure

${options.procedure.trim()}

## Verification

${options.verification.trim()}
`;

  return frontmatter.trim() + "\n";
}
