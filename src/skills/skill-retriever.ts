import type { SkillMetadata } from "./types.js";

/**
 * Skill 元数据检索与 Context 格式化器
 */
export class SkillRetriever {
  /**
   * 筛选与用户任务最相关的 Skill 元数据列表 (Top N)
   */
  selectRelevant(
    allSkills: SkillMetadata[],
    queryText: string,
    limit: number = 10
  ): SkillMetadata[] {
    if (allSkills.length === 0) return [];
    if (!queryText.trim()) {
      return allSkills.slice(0, limit);
    }

    const normalizedQuery = queryText.toLowerCase();
    const queryWords = normalizedQuery.match(/[\w\d\-_]+|[一-龥]{1,4}/gu) || [];

    const scored: Array<{ skill: SkillMetadata; score: number }> = [];

    for (const skill of allSkills) {
      let score = 0;
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();
      const whenLower = (skill.whenToUse || "").toLowerCase();

      // 作用域权重：Project Skill 略优先
      if (skill.scope === "project") {
        score += 1.0;
      }

      // 精确匹配 skill name
      if (normalizedQuery.includes(nameLower) || nameLower.includes(normalizedQuery)) {
        score += 10.0;
      }

      // 单词匹配
      for (const word of queryWords) {
        if (nameLower.includes(word)) {
          score += 4.0;
        }
        if (descLower.includes(word)) {
          score += 2.0;
        }
        if (whenLower.includes(word)) {
          score += 1.5;
        }
      }

      scored.push({ skill, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.skill);
  }

  /**
   * 将选出的 Skill 元数据列表渲染为 Level 1 Available Skills 提示词段落
   */
  renderAvailableSkillsPrompt(skills: SkillMetadata[]): string {
    if (skills.length === 0) {
      return "";
    }

    const lines: string[] = [
      "Available Skills (use the 'skill_open' tool to view detailed procedures when needed):",
    ];

    for (const skill of skills) {
      const scopeTag = skill.scope === "project" ? " [project]" : "";
      lines.push(`- ${skill.name}${scopeTag}: ${skill.description}`);
    }

    return lines.join("\n");
  }
}
