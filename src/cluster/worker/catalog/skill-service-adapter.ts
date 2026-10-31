import crypto from "node:crypto";
import type { SkillService } from "../../../skills/skill-service.js";
import type { SkillCatalogItem } from "../../protocol/types.js";

export class SkillServiceAdapter {
  constructor(
    private readonly skillService: SkillService,
    private readonly nodeId: string
  ) {}

  /**
   * 导出当前 Worker 允许公开的 Skills 摘要目录 (Level 1)
   * 严格禁止同步完整 markdown 执行脚本或敏感参数
   */
  async exportCatalogItems(): Promise<SkillCatalogItem[]> {
    const list = await this.skillService.getAllSkillsWithModes();
    const items: SkillCatalogItem[] = [];

    for (const item of list) {
      const meta = item.metadata;
      // 若处于禁用状态 (mode === "off")，仍同步元数据但标记 available: false
      const isAvailable = item.mode !== "off";

      // 计算稳定的 Fingerprint (基于名称、描述、作用域与标签)
      const fpRaw = `${meta.name}:${meta.description}:${meta.scope}:${(meta.tags ?? []).join(",")}`;
      const fingerprint = crypto.createHash("sha256").update(fpRaw).digest("hex").slice(0, 16);

      items.push({
        skillId: `skill-${meta.name}`,
        nodeId: this.nodeId,
        projectId: undefined,
        name: meta.name,
        description: meta.description || meta.whenToUse || "No description",
        scope: meta.scope ?? "global",
        tags: meta.tags ?? [],
        fingerprint,
        available: isAvailable,
        updatedAt: Date.now(),
      });
    }

    return items;
  }
}
