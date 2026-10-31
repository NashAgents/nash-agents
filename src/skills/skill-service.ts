import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectContext } from "../project/project-context.js";
import type { EventBus } from "../observability/event-bus.js";
import type {
  SkillConfig,
  SkillDefinition,
  SkillMetadata,
  SkillScope,
  SkillMode,
  SkillItemWithMode,
} from "./types.js";
import { DEFAULT_SKILL_CONFIG } from "./types.js";
import { getGlobalSkillsDir, getProjectSkillsDir } from "./skill-paths.js";
import { SkillRegistry } from "./skill-registry.js";
import { SkillRetriever } from "./skill-retriever.js";
import { SkillLoader } from "./skill-loader.js";
import { SkillWriter, type CreateSkillInput } from "./skill-writer.js";
import { ensureDefaultSkills } from "./default-skills.js";

export interface SkillServiceOptions {
  projectContext?: ProjectContext;
  nashHome?: string;
  config?: Partial<SkillConfig>;
  eventBus?: EventBus;
}

/**
 * 统一 Skill 核心服务
 */
export class SkillService {
  private readonly config: SkillConfig;
  private readonly globalDir: string;
  private readonly projectDir?: string;
  private readonly registry: SkillRegistry;
  private readonly retriever: SkillRetriever;
  private readonly loader: SkillLoader;
  private readonly writer: SkillWriter;
  private readonly eventBus?: EventBus;
  private readonly projectId: string;
  private readonly nashHomeProvided: boolean;

  constructor(options?: SkillServiceOptions) {
    this.config = {
      ...DEFAULT_SKILL_CONFIG,
      ...options?.config,
    };
    this.eventBus = options?.eventBus;
    this.projectId = options?.projectContext?.projectId ?? "global";
    this.nashHomeProvided = Boolean(options?.nashHome);

    const nashHome = options?.nashHome;
    this.globalDir = getGlobalSkillsDir(nashHome);
    if (options?.projectContext) {
      this.projectDir = getProjectSkillsDir(options.projectContext, nashHome);
    }

    this.registry = new SkillRegistry({
      globalDir: this.globalDir,
      projectDir: this.projectDir,
    });
    this.retriever = new SkillRetriever();
    this.loader = new SkillLoader();
    this.writer = new SkillWriter(this.globalDir, this.projectDir);
    this.modesFilePath = path.join(this.globalDir, ".modes.json");
  }

  private readonly modesFilePath: string;
  private modesCache: Record<string, SkillMode> | null = null;

  private loadModes(): Record<string, SkillMode> {
    if (this.modesCache) return this.modesCache;
    try {
      if (fsSync.existsSync(this.modesFilePath)) {
        const raw = fsSync.readFileSync(this.modesFilePath, "utf-8");
        this.modesCache = JSON.parse(raw);
        return this.modesCache || {};
      }
    } catch {}
    this.modesCache = {};
    return this.modesCache;
  }

  getSkillMode(name: string): SkillMode {
    const modes = this.loadModes();
    return modes[name] ?? "on";
  }

  async setSkillMode(name: string, mode: SkillMode): Promise<void> {
    const modes = this.loadModes();
    modes[name] = mode;
    this.modesCache = modes;
    try {
      if (!fsSync.existsSync(this.globalDir)) {
        await fs.mkdir(this.globalDir, { recursive: true });
      }
      await fs.writeFile(this.modesFilePath, JSON.stringify(modes, null, 2), "utf-8");
    } catch {}
  }

  async getAllSkillsWithModes(): Promise<SkillItemWithMode[]> {
    const all = await this.listAllSkills();
    return all.map((meta) => {
      const mode = this.getSkillMode(meta.name);
      const estTokens = Math.ceil(
        (meta.name.length + meta.description.length + (meta.whenToUse?.length || 0)) * 0.4
      );
      return {
        metadata: meta,
        mode,
        estimatedTokens: Math.max(40, Math.min(250, estTokens)),
      };
    });
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    if (this.eventBus) {
      this.eventBus.emit({
        id: crypto.randomUUID(),
        type: type as any,
        timestamp: new Date().toISOString(),
        projectId: this.projectId,
        sessionId: "skill-session",
        data,
      });
    }
  }

  getConfig(): SkillConfig {
    return { ...this.config };
  }

  /**
   * 获取所有可用 Skills 元数据列表 (Level 1)
   */
  async listAllSkills(): Promise<SkillMetadata[]> {
    if (!this.config.enabled) return [];
    if (!this.nashHomeProvided) {
      await ensureDefaultSkills(this.globalDir);
    }
    return await this.registry.getAllMetadata();
  }

  /**
   * 获取并筛选适合注入当前 Prompt 的 Available Skills 元数据
   * 遵循模式策略：off 和 user-only 的技能被排除
   */
  async getAvailableSkills(queryText: string = ""): Promise<SkillMetadata[]> {
    if (!this.config.enabled || !this.config.autoDiscover) return [];
    const all = await this.registry.getAllMetadata();
    const enabled = all.filter((s) => {
      const mode = this.getSkillMode(s.name);
      return mode === "on";
    });

    const selected = this.retriever.selectRelevant(
      enabled,
      queryText,
      this.config.maxMetadataEntries
    );

    if (selected.length > 0) {
      this.emitEvent("skill.discovered", {
        count: selected.length,
        names: selected.map((s) => s.name),
      });
    }

    return selected;
  }

  /**
   * 生成注入 System Prompt 或 Active Context 的 Available Skills 文本段落
   * 渐进式披露：
   * 1. mode === "on": Level 1 详细元数据
   * 2. mode === "name-only": 极简名称清单
   */
  async renderAvailableSkillsPrompt(queryText: string = ""): Promise<string> {
    const skills = await this.getAvailableSkills(queryText);
    let prompt = this.retriever.renderAvailableSkillsPrompt(skills);

    // 追加 name-only 模式的极简技能清单
    const all = await this.registry.getAllMetadata();
    const nameOnlySkills = all.filter((s) => this.getSkillMode(s.name) === "name-only");
    if (nameOnlySkills.length > 0) {
      const namesList = nameOnlySkills.map((s) => s.name).join(", ");
      const extraLine = `\n\nAdditional name-only skills (use 'skill_open <name>' to inspect): ${namesList}`;
      prompt = prompt ? `${prompt}${extraLine}` : `Available Skills\n${extraLine}`;
    }

    return prompt;
  }

  /**
   * 按需打开并加载指定的 Skill 完整定义 (Level 2)
   */
  async openSkill(name: string): Promise<SkillDefinition> {
    if (!this.config.enabled) {
      throw new Error("Skills 系统已被禁用。");
    }

    const meta = await this.registry.findMetadata(name);
    if (!meta) {
      throw new Error(`未找到名为 '${name}' 的 Skill。`);
    }

    const definition = await this.loader.loadSkillDefinition(meta);

    this.emitEvent("skill.loaded", {
      name: meta.name,
      scope: meta.scope,
    });

    return definition;
  }

  /**
   * 读取 Skill 附属的参考文档 (Level 3)
   */
  async readReference(name: string, filename: string): Promise<string> {
    const meta = await this.registry.findMetadata(name);
    if (!meta) {
      throw new Error(`未找到名为 '${name}' 的 Skill。`);
    }
    return await this.loader.loadReferenceDocument(meta, filename);
  }

  /**
   * 创建并持久化新 Skill
   */
  async createSkill(input: CreateSkillInput): Promise<SkillMetadata> {
    const meta = await this.writer.createSkill(input);
    this.registry.clearCache();

    this.emitEvent("skill.created", {
      name: meta.name,
      scope: meta.scope,
    });

    return meta;
  }

  /**
   * 删除 Skill
   */
  async deleteSkill(name: string, scope?: SkillScope): Promise<boolean> {
    const ok = await this.writer.deleteSkill(name, scope);
    if (ok) {
      this.registry.clearCache();
    }
    return ok;
  }
}
