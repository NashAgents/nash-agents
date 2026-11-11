import * as crypto from "node:crypto";
import type { MemoryService } from "../memory/memory-service.js";
import type { SkillService } from "../skills/skill-service.js";
import type { MemoryEntry } from "../memory/types.js";
import type { EventBus } from "../observability/event-bus.js";
import type { HarnessEventType } from "../observability/types.js";
import type { ProjectContext } from "../project/project-context.js";
import {
  calculateTextSimilarity,
  getSourcePriority,
  isConflictingTopic,
} from "../memory/memory-writer.js";
import { formatSkillMarkdown } from "../skills/frontmatter.js";
import { LearningAnalyzer, LearningAnalysisError, inferMemorySource } from "./learning-analyzer.js";
import { detectExplicitLearningSignals } from "./learning-context.js";
import {
  createDefaultLearningModelCaller,
  type LearningModelCaller,
} from "./learning-model.js";
import type {
  LearningMemoryCandidate,
  LearningSkillCandidate,
  RunLearningInput,
  RunLearningResult,
} from "./types.js";

export interface RunLearningHookOptions {
  memoryService: MemoryService;
  skillService: SkillService;
  projectContext?: ProjectContext;
  /**
   * 保留旧构造参数以兼容既有调用；学习 Hook 不再依赖观察文件目录。
   */
  nashHome?: string;
  /**
   * 可注入的模型调用器。默认使用项目现有模型配置（product model context / nash settings）。
   */
  modelCaller?: LearningModelCaller;
  eventBus?: EventBus;
  timeoutMs?: number;
}

const GREETING_PATTERN =
  /^(?:你好|您好|hi|hello|hey|nash|开始|继续|ok|好的|test|测试|在吗|在不在)[!！?.。\s]*$/i;

function isTrivialLearningInput(input: RunLearningInput): boolean {
  const text = (input.userInput ?? "").trim();
  if (!text && !input.response && (input.toolCalls?.length ?? 0) === 0) {
    return true;
  }
  return (
    GREETING_PATTERN.test(text) &&
    (input.toolCalls?.length ?? 0) === 0 &&
    !input.testResults
  );
}

function normalizeSkillContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

/**
 * Run 结束时的自动学习与沉淀 Hook。
 *
 * 设计边界：
 * - 模型只做判断与结构化输出；写入统一复用 MemoryService / SkillService。
 * - 所有异常都被收敛为可观察的 failures，绝不改变主 Run 的成功结果。
 * - 同步执行、单次模型调用、有界输入与超时，避免后台 Promise 跨会话泄漏。
 */
export class RunLearningHook {
  private readonly memoryService: MemoryService;
  private readonly skillService: SkillService;
  private readonly projectContext?: ProjectContext;
  private readonly modelCaller: LearningModelCaller;
  private readonly eventBus?: EventBus;
  private readonly timeoutMs: number;
  private readonly analyzer: LearningAnalyzer;
  private readonly callerInjected: boolean;

  constructor(options: RunLearningHookOptions) {
    this.memoryService = options.memoryService;
    this.skillService = options.skillService;
    this.projectContext = options.projectContext;
    this.eventBus = options.eventBus;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.callerInjected = Boolean(options.modelCaller);
    this.modelCaller =
      options.modelCaller ??
      createDefaultLearningModelCaller({ timeoutMs: this.timeoutMs });
    this.analyzer = new LearningAnalyzer(this.modelCaller, {
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * 在 Run 完成后执行学习提炼 (Fail-Safe 保证：内部捕获一切错误，绝不破坏用户 Run 结果)
   */
  async processRun(input: RunLearningInput): Promise<RunLearningResult> {
    const result: RunLearningResult = {
      status: "skipped",
      memoriesLearned: [],
      failures: [],
      warnings: [],
      rejections: [],
    };

    try {
      // 测试/运维紧急关闭开关；显式注入 caller 时仍允许验证学习链路。
      if (
        process.env.NASH_DISABLE_AUTO_LEARNING === "1" &&
        !this.callerInjected
      ) {
        result.skippedReason = "automatic-learning-disabled-by-env";
        this.emitLifecycle("skipped", input, result);
        return result;
      }

      const memoryConfig = this.memoryService.getConfig();
      const skillConfig = this.skillService.getConfig();
      const signals = detectExplicitLearningSignals(input.userInput);

      const memoryEnabled = memoryConfig.enabled && memoryConfig.autoLearn;
      const skillEnabled =
        skillConfig.enabled &&
        (skillConfig.autoGenerate || signals.explicitSkillRequest);

      if (input.isError) {
        result.skippedReason = "run-did-not-complete-successfully";
        this.emitLifecycle("skipped", input, result);
        return result;
      }

      if (!memoryEnabled && !skillEnabled) {
        result.skippedReason = "automatic-learning-disabled";
        this.emitLifecycle("skipped", input, result);
        return result;
      }

      if (isTrivialLearningInput(input)) {
        result.skippedReason = "trivial-input";
        this.emitLifecycle("skipped", input, result);
        return result;
      }

      const existingMemories = memoryEnabled
        ? (await this.memoryService.getAll("all")).filter((entry) => !entry.deprecated)
        : [];
      const existingSkills = skillEnabled
        ? (await this.skillService.listAllSkills()).map((skill) => ({
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
          }))
        : [];

      const analyzed = await this.analyzer.analyze({
        input,
        existingMemories,
        existingSkills,
        projectContext: this.projectContext,
        // 以实际写入服务的项目作用域为准，避免把 project 候选写进 global store。
        memoryProjectScopeAvailable: this.memoryService.hasProjectScope(),
        skillProjectScopeAvailable: this.skillService.hasProjectScope(),
        memoryEnabled,
        skillEnabled,
      });

      result.modelUsed = analyzed.modelUsed;
      result.promptChars = analyzed.promptChars;
      result.warnings = analyzed.warnings;
      result.rejections = analyzed.rejections;
      result.notes = analyzed.notes;
      result.skillsObserved = analyzed.skill ? [analyzed.skill.name] : undefined;

      if (memoryEnabled) {
        for (const candidate of analyzed.memories) {
          await this.persistMemory(candidate, input, existingMemories, result);
        }
      }

      if (skillEnabled && analyzed.skill) {
        await this.persistSkill(analyzed.skill, input, signals.explicitSkillRequest, result);
      } else if (analyzed.skill && !skillEnabled) {
        result.skillSkippedReason = "automatic-skill-generation-disabled";
      }

      const wroteAnything =
        result.memoriesLearned.length > 0 ||
        (result.skillsCreated?.length ?? 0) > 0;
      const hasFailures = result.failures.length > 0;

      if (hasFailures) {
        result.status = wroteAnything ? "partial" : "failed";
      } else if (wroteAnything) {
        result.status = "completed";
      } else {
        result.status = "skipped";
        result.skippedReason =
          analyzed.rejections.length > 0
            ? "no-candidate-passed-validation"
            : result.warnings?.some((warning) => warning.stage === "dedupe")
              ? "candidate-already-covered"
              : "model-found-nothing-durable";
      }

      this.emitLifecycle(
        result.status === "failed" ? "failed" : result.status === "skipped" ? "skipped" : "completed",
        input,
        result
      );
      return result;
    } catch (err: unknown) {
      const failure =
        err instanceof LearningAnalysisError
          ? { stage: err.stage, message: err.message }
          : {
              stage: "context" as const,
              message: err instanceof Error ? err.message : String(err),
            };
      result.failures.push(failure);
      result.status =
        result.memoriesLearned.length > 0 || (result.skillsCreated?.length ?? 0) > 0
          ? "partial"
          : "failed";
      result.skippedReason = "learning-failed";
      this.emitLifecycle("failed", input, result);
      return result;
    }
  }

  private async persistMemory(
    candidate: LearningMemoryCandidate,
    input: RunLearningInput,
    existingMemories: MemoryEntry[],
    result: RunLearningResult
  ): Promise<void> {
    const conflictReason = this.findMemoryConflict(candidate, existingMemories);
    if (conflictReason) {
      result.warnings?.push({ stage: "dedupe", message: conflictReason });
      return;
    }

    try {
      const created = await this.memoryService.remember({
        content: candidate.content,
        kind: candidate.kind,
        source: inferMemorySource(candidate.basis),
        confidence: candidate.confidence,
        evidence: [
          {
            sessionId: input.sessionId,
            runId: input.runId,
            summary: candidate.evidence,
            timestamp: Date.now(),
          },
        ],
        tags: candidate.tags,
        scope: candidate.scope,
        projectId:
          candidate.scope === "project"
            ? this.projectContext?.projectId ??
              (input.metadata?.projectId as string | undefined)
            : undefined,
      });

      if (created) {
        result.memoriesLearned.push(created);
        const existingIndex = existingMemories.findIndex(
          (entry) => entry.id === created.id
        );
        if (existingIndex >= 0) existingMemories[existingIndex] = created;
        else existingMemories.push(created);
      } else {
        result.failures.push({
          stage: "memory-write",
          message: `MemoryService rejected candidate: ${candidate.content.slice(0, 80)}`,
        });
      }
    } catch (err: unknown) {
      result.failures.push({
        stage: "memory-write",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private findMemoryConflict(
    candidate: LearningMemoryCandidate,
    existingMemories: MemoryEntry[]
  ): string | undefined {
    const incomingPriority = getSourcePriority(inferMemorySource(candidate.basis));

    for (const existing of existingMemories) {
      if (existing.deprecated) continue;

      const similarity = calculateTextSimilarity(candidate.content, existing.content);
      if (
        similarity >= 0.95 &&
        getSourcePriority(existing.source) >= incomingPriority
      ) {
        return `Candidate is already covered by memory '${existing.id}' (${existing.source}); skipped to keep repeated runs idempotent.`;
      }

      if (isConflictingTopic(candidate.content, existing.content)) {
        if (getSourcePriority(existing.source) > incomingPriority) {
          return `Candidate would conflict with higher-priority memory '${existing.id}' (${existing.source}); skipped to avoid overriding an explicit user preference.`;
        }
      }
    }

    return undefined;
  }

  private async persistSkill(
    candidate: LearningSkillCandidate,
    input: RunLearningInput,
    explicitRequest: boolean,
    result: RunLearningResult
  ): Promise<void> {
    const newContent = formatSkillMarkdown({
      name: candidate.name,
      description: candidate.description,
      whenToUse: candidate.whenToUse,
      procedure: candidate.procedure,
      verification: candidate.verification,
      limitations: candidate.limitations,
    });

    try {
      const existing = await this.skillService.findExistingSkill(candidate.name);
      if (existing) {
        if (normalizeSkillContent(existing.content) === normalizeSkillContent(newContent)) {
          result.skillSkippedReason = `Skill '${candidate.name}' already exists with identical content; skipped.`;
          return;
        }

        if (explicitRequest) {
          const versionedName = await this.nextAvailableSkillName(candidate.name);
          const created = await this.createSkillCandidate(candidate, versionedName);
          result.skillsCreated = [...(result.skillsCreated ?? []), created];
          result.warnings?.push({
            stage: "skill",
            message: `Skill '${candidate.name}' already exists; created '${versionedName}' instead of overwriting.`,
          });
          return;
        }

        result.skillSkippedReason = `Skill '${candidate.name}' already exists; automatic generation did not overwrite it.`;
        return;
      }

      const created = await this.createSkillCandidate(candidate, candidate.name);
      result.skillsCreated = [...(result.skillsCreated ?? []), created];
    } catch (err: unknown) {
      result.failures.push({
        stage: "skill-write",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async createSkillCandidate(
    candidate: LearningSkillCandidate,
    name: string
  ) {
    return await this.skillService.createSkill({
      name,
      description: candidate.description,
      whenToUse: candidate.whenToUse,
      procedure: candidate.procedure,
      verification: candidate.verification,
      limitations: candidate.limitations,
      scope: candidate.scope,
      overwrite: false,
    });
  }

  private async nextAvailableSkillName(baseName: string): Promise<string> {
    for (let version = 2; version <= 50; version++) {
      const suffix = `-v${version}`;
      const name = `${baseName.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
      if (!(await this.skillService.findExistingSkill(name))) {
        return name;
      }
    }
    throw new Error(
      `Unable to find an available versioned name for skill '${baseName}' (checked v2..v50).`
    );
  }

  private emitLifecycle(
    status: "completed" | "failed" | "skipped",
    input: RunLearningInput,
    result: RunLearningResult
  ): void {
    if (!this.eventBus) return;

    const type =
      status === "completed"
        ? "learning.completed"
        : status === "failed"
          ? "learning.failed"
          : "learning.skipped";

    this.eventBus.emit({
      id: crypto.randomUUID(),
      type: type as HarnessEventType,
      timestamp: new Date().toISOString(),
      projectId: this.projectContext?.projectId ?? "global",
      sessionId: input.sessionId,
      traceId: input.runId,
      data: {
        status,
        memoriesCreated: result.memoriesLearned.length,
        skillsCreated: result.skillsCreated?.length ?? 0,
        failures: result.failures,
        warnings: result.warnings,
        rejections: result.rejections,
        skippedReason: result.skippedReason,
        skillSkippedReason: result.skillSkippedReason,
        modelUsed: result.modelUsed,
        promptChars: result.promptChars,
        notes: result.notes,
      },
    });
  }
}
