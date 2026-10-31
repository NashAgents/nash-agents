import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import type { MemoryEntry } from "../memory/types.js";
import type { SkillMetadata } from "../skills/types.js";
import type { RunLearningInput, RunLearningResult } from "./types.js";
import { MemoryDistiller } from "./memory-distiller.js";
import { SkillObserver } from "./skill-observer.js";
import { getProjectSkillsDir } from "../skills/skill-paths.js";
import type { ProjectContext } from "../project/project-context.js";

export interface RunLearningHookOptions {
  memoryService: MemoryService;
  skillService: SkillService;
  projectContext?: ProjectContext;
  nashHome?: string;
}

/**
 * Run 结束时的自动学习与沉淀 Hook
 */
export class RunLearningHook {
  private readonly memoryService: MemoryService;
  private readonly skillService: SkillService;
  private readonly distiller: MemoryDistiller;
  private readonly observer?: SkillObserver;

  constructor(options: RunLearningHookOptions) {
    this.memoryService = options.memoryService;
    this.skillService = options.skillService;
    this.distiller = new MemoryDistiller();

    const skillsDir = getProjectSkillsDir(options.projectContext, options.nashHome);
    this.observer = new SkillObserver({ storageDir: skillsDir });
  }

  /**
   * 在 Run 完成后执行学习提炼 (Fail-Safe 保证：内部捕获一切错误，绝不破坏用户 Run 结果)
   */
  async processRun(input: RunLearningInput): Promise<RunLearningResult> {
    const result: RunLearningResult = {
      memoriesLearned: [],
    };

    try {
      // 1. 提炼并保存 Memory
      if (this.memoryService.getConfig().autoLearn) {
        const memoryItems = this.distiller.distill(input);
        for (const item of memoryItems) {
          const created = await this.memoryService.remember({
            content: item.content,
            kind: item.kind,
            source: item.source,
            confidence: item.confidence,
            evidence: item.evidence,
            tags: item.tags,
            supersedes: item.supersedes,
            projectId: input.metadata?.projectId as string | undefined,
          });
          if (created) {
            result.memoriesLearned.push(created);
          }
        }
      }

      // 2. 检查显式或自动 Skill 提炼
      if (this.observer && this.skillService.getConfig().enabled) {
        // 显式创建 Skill 请求检测 (优先)
        const explicitSkill = this.observer.detectExplicitSkillRequest(input);
        if (explicitSkill) {
          const createdSkill = await this.skillService.createSkill(explicitSkill);
          result.skillsCreated = result.skillsCreated || [];
          result.skillsCreated.push(createdSkill);
        } else if (this.skillService.getConfig().autoGenerate) {
          // 自动保守观察
          const autoCandidate = await this.observer.recordObservation(input);
          if (autoCandidate) {
            const createdSkill = await this.skillService.createSkill(autoCandidate);
            result.skillsCreated = result.skillsCreated || [];
            result.skillsCreated.push(createdSkill);
          }
        }
      }
    } catch (err: unknown) {
      // 学习过程失败静默记录，绝不影响主 Run
      result.skippedReason = `Learning failed gracefully: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    return result;
  }
}
