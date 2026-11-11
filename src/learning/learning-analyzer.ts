import type { MemoryEntry, MemoryKind, MemoryScope, MemorySource } from "../memory/types.js";
import type { SkillScope } from "../skills/types.js";
import type { ProjectContext } from "../project/project-context.js";
import { containsSecret } from "../memory/secret-sanitizer.js";
import {
  buildLearningContext,
  detectExplicitLearningSignals,
  type ExistingSkillSummary,
  type BuiltLearningContext,
} from "./learning-context.js";
import type {
  ExplicitLearningSignals,
  LearningDecisionKind,
  LearningFailure,
  LearningMemoryBasis,
  LearningMemoryCandidate,
  LearningRejection,
  LearningSkillCandidate,
  LearningWarning,
  RawLearningDecision,
  RunLearningInput,
} from "./types.js";
import type { LearningModelCaller, LearningModelResponse } from "./learning-model.js";
import { DEFAULT_LEARNING_TIMEOUT_MS } from "./learning-model.js";

const MEMORY_KINDS: ReadonlySet<string> = new Set([
  "fact",
  "preference",
  "architecture",
  "environment",
  "decision",
  "lesson",
]);

const MEMORY_BASES: ReadonlySet<string> = new Set([
  "user-explicit",
  "user-correction",
  "verified-runtime",
  "verified-code",
]);

const DECISIONS: ReadonlySet<string> = new Set(["none", "memory", "skill", "both"]);

const MAX_MEMORIES = 3;
const MAX_MEMORY_CONTENT_CHARS = 400;
const MAX_EVIDENCE_CHARS = 600;
const MAX_SKILL_PROCEDURE_CHARS = 4_000;
const MAX_SKILL_LIMITATIONS_CHARS = 1_000;

const TRANSIENT_PATTERNS: RegExp[] = [
  /\bpid\s*[:=]?\s*\d+/i,
  /\/tmp\//i,
  /\/var\/folders\//i,
  /\\Temp\\/i,
  /\bsession[-_ ]?id\b/i,
  /\brun[-_ ]?id\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/,
  /\blocalhost:\d+\b/i,
  /\b127\.0\.0\.1(?::\d+)?\b/i,
  /\b(?:progress|进度)\s*[:=]?\s*\d+%/i,
];

const SPECULATIVE_PATTERN =
  /(?:可能|似乎|也许|大概|不确定|猜测|推测|貌似|maybe|perhaps|probably|might be|could be|unverified)/i;

export class LearningAnalysisError extends Error {
  constructor(
    readonly stage: LearningFailure["stage"],
    message: string
  ) {
    super(message);
    this.name = "LearningAnalysisError";
  }
}

export interface AnalyzeLearningOptions {
  input: RunLearningInput;
  existingMemories?: MemoryEntry[];
  existingSkills?: ExistingSkillSummary[];
  projectContext?: ProjectContext;
  memoryProjectScopeAvailable: boolean;
  skillProjectScopeAvailable: boolean;
  memoryEnabled: boolean;
  skillEnabled: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AnalyzedLearning {
  decision: LearningDecisionKind;
  memories: LearningMemoryCandidate[];
  skill: LearningSkillCandidate | null;
  notes?: string;
  warnings: LearningWarning[];
  rejections: LearningRejection[];
  modelUsed?: string;
  promptChars: number;
  contextTruncated: boolean;
  signals: ExplicitLearningSignals;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    throw new LearningAnalysisError("parse", "Learning model returned an empty response.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1] ?? "", trimmed] : [trimmed];

  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    const slice = candidate.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }

  throw new LearningAnalysisError(
    "parse",
    "Learning model output did not contain a valid JSON object."
  );
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？.,;:!?`"'“”‘’()\[\]{}<>《》]/g, "");
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{2,}|[一-鿿]/g) ?? []);
}

function tokenOverlapRatio(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }
  return shared / left.size;
}

function userEvidenceCorpus(input: RunLearningInput): string {
  const recentUserText = (input.recentMessages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  return [input.userInput, recentUserText].filter(Boolean).join("\n");
}

function groundedInUserRequest(
  evidence: string,
  content: string,
  input: RunLearningInput
): boolean {
  const corpus = userEvidenceCorpus(input);
  const normalizedEvidence = normalizeForMatch(evidence);
  const normalizedUser = normalizeForMatch(corpus);
  if (normalizedEvidence.length >= 4 && normalizedUser.includes(normalizedEvidence)) {
    return true;
  }
  return tokenOverlapRatio(`${evidence} ${content}`, corpus) >= 0.5;
}

function evidenceMentionsObserved(evidence: string, input: RunLearningInput): boolean {
  const observedParts: string[] = [];
  if (input.testResults?.command) observedParts.push(input.testResults.command);
  for (const file of input.verifiedFiles ?? []) observedParts.push(file);
  for (const call of input.toolCalls ?? []) {
    observedParts.push(call.name);
    observedParts.push(typeof call.args === "string" ? call.args : JSON.stringify(call.args));
    if (call.result) observedParts.push(call.result);
  }

  const observed = observedParts.join("\n");
  if (!observed) return false;

  const normalizedEvidence = normalizeForMatch(evidence);
  const normalizedObserved = normalizeForMatch(observed);
  if (normalizedEvidence.length >= 4 && normalizedObserved.includes(normalizedEvidence)) {
    return true;
  }
  // 模型通常会自然语言概括结果（例如 “running npm test produced a passing result”），
  // 0.4 的词元重合度足以证明证据来自本轮观察，同时仍能拒绝完全臆造的引用。
  return tokenOverlapRatio(evidence, observed) >= 0.4;
}

function hasCodeVerification(input: RunLearningInput): boolean {
  if ((input.verifiedFiles?.length ?? 0) > 0) return true;
  return (input.toolCalls ?? []).some(
    (call) =>
      call.success !== false &&
      /^(?:read_file|edit_file|write_file|grep_search|list_files|read_tool_result)$/i.test(
        call.name
      )
  );
}

function hasRuntimeVerification(input: RunLearningInput): boolean {
  if (input.testResults) return true;
  return (input.toolCalls ?? []).some(
    (call) =>
      call.success === true &&
      /(?:bash|shell|exec|command|test|pytest|vitest)/i.test(call.name)
  );
}

function hasWorkflowEvidence(input: RunLearningInput): boolean {
  const successfulTools = (input.toolCalls ?? []).filter(
    (call) => call.success === true
  ).length;
  if (successfulTools >= 2) return true;
  if (input.testResults?.passed && successfulTools >= 1) return true;
  if ((input.verifiedFiles?.length ?? 0) >= 2) return true;
  return false;
}

export function hasTransientLearningMarker(text: string): boolean {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeGenericProcedure(procedure: string): boolean {
  const lines = procedure
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
    .filter(Boolean);

  if (lines.length < 2) return true;

  const genericLine =
    /^(?:inspect|check|review|examine|modify|edit|update|apply|run|execute|test|verify|检查|查看|审查|修改|更新|执行|运行|测试|验证)\b/i;

  return lines.every((line) => genericLine.test(line) && line.length < 80);
}

export function inferMemorySource(basis: LearningMemoryBasis): MemorySource {
  return basis;
}

/**
 * 模型驱动的 Run 学习分析器。
 *
 * 只做“构建有界上下文 -> 调用模型 -> 严格解析与校验”，不直接写盘。
 * 任何模型/解析/字段错误都通过 LearningAnalysisError 上抛，由 Hook 记录为可观察失败。
 */
export class LearningAnalyzer {
  constructor(
    private readonly caller: LearningModelCaller,
    private readonly options?: { timeoutMs?: number }
  ) {}

  async analyze(options: AnalyzeLearningOptions): Promise<AnalyzedLearning> {
    let context: BuiltLearningContext;
    try {
      context = buildLearningContext({
        input: options.input,
        existingMemories: options.existingMemories,
        existingSkills: options.existingSkills,
        projectContext: options.projectContext,
        memoryEnabled: options.memoryEnabled,
        skillEnabled: options.skillEnabled,
      });
    } catch (err: unknown) {
      throw new LearningAnalysisError(
        "context",
        `Failed to build bounded learning context: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    let response: LearningModelResponse;
    try {
      response = await this.caller({
        systemPrompt: context.systemPrompt,
        userPrompt: context.userPrompt,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.options?.timeoutMs ?? DEFAULT_LEARNING_TIMEOUT_MS,
      });
    } catch (err: unknown) {
      throw new LearningAnalysisError(
        "model",
        `Learning model call failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const raw = this.parseDecision(response.text);
    const warnings: LearningWarning[] = [];
    const rejections: LearningRejection[] = [];

    const hasMemories = Array.isArray(raw.memories) && raw.memories.length > 0;
    const hasSkill = raw.skill !== null && raw.skill !== undefined;
    if (raw.decision === "none" && (hasMemories || hasSkill)) {
      warnings.push({
        stage: "validation",
        message: "Model returned decision=none together with candidates; candidates were ignored.",
      });
    }

    const memories: LearningMemoryCandidate[] = [];
    if (
      options.memoryEnabled &&
      (raw.decision === "memory" || raw.decision === "both" || raw.decision === "none")
    ) {
      if (raw.decision !== "none" && Array.isArray(raw.memories)) {
        if (raw.memories.length > MAX_MEMORIES) {
          warnings.push({
            stage: "validation",
            message: `Model returned ${raw.memories.length} memories; only the first ${MAX_MEMORIES} were considered.`,
          });
        }
        raw.memories.slice(0, MAX_MEMORIES).forEach((candidate, index) => {
          const verified = this.validateMemoryCandidate(
            candidate,
            index,
            options,
            context.signals,
            warnings,
            rejections
          );
          if (verified) memories.push(verified);
        });
      }
    } else if (hasMemories && raw.decision === "skill") {
      warnings.push({
        stage: "validation",
        message: "Model returned memory candidates with decision=skill; memory candidates were ignored.",
      });
    }

    let skill: LearningSkillCandidate | null = null;
    if (
      options.skillEnabled &&
      (raw.decision === "skill" || raw.decision === "both" || raw.decision === "none")
    ) {
      if (raw.decision !== "none" && raw.skill !== null && raw.skill !== undefined) {
        skill = this.validateSkillCandidate(
          raw.skill,
          options,
          context.signals,
          warnings,
          rejections
        );
      }
    } else if (hasSkill && raw.decision === "memory") {
      warnings.push({
        stage: "validation",
        message: "Model returned a skill with decision=memory; the skill was ignored.",
      });
    }

    if (raw.decision === "both" && memories.length === 0 && skill === null) {
      warnings.push({
        stage: "validation",
        message: "Model decision=both but no candidate passed validation.",
      });
    }

    return {
      decision: raw.decision,
      memories,
      skill,
      notes: raw.notes,
      warnings,
      rejections,
      modelUsed: response.model,
      promptChars: context.promptChars,
      contextTruncated: context.truncated,
      signals: context.signals,
    };
  }

  private parseDecision(text: string): RawLearningDecision {
    const parsed = extractJsonObject(text);

    const decision = parsed.decision;
    if (typeof decision !== "string" || !DECISIONS.has(decision)) {
      throw new LearningAnalysisError(
        "parse",
        `Learning model returned an invalid decision field: ${JSON.stringify(decision)}`
      );
    }

    if (parsed.memories !== undefined && !Array.isArray(parsed.memories)) {
      throw new LearningAnalysisError(
        "parse",
        "Learning model returned a non-array memories field."
      );
    }

    if (
      parsed.skill !== undefined &&
      parsed.skill !== null &&
      !isRecord(parsed.skill)
    ) {
      throw new LearningAnalysisError(
        "parse",
        "Learning model returned an invalid skill field."
      );
    }

    return {
      decision: decision as LearningDecisionKind,
      memories: parsed.memories,
      skill: parsed.skill ?? null,
      notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 500) : undefined,
    };
  }

  private validateMemoryCandidate(
    raw: unknown,
    index: number,
    options: AnalyzeLearningOptions,
    signals: ExplicitLearningSignals,
    warnings: LearningWarning[],
    rejections: LearningRejection[]
  ): LearningMemoryCandidate | null {
    const reject = (reason: string): null => {
      rejections.push({ target: "memory", index, reason });
      return null;
    };

    if (!isRecord(raw)) return reject("memory candidate is not an object");

    const content = stringField(raw, "content");
    if (!content || content.length < 3 || content.length > MAX_MEMORY_CONTENT_CHARS) {
      return reject(
        `content must be a non-empty string of 3-${MAX_MEMORY_CONTENT_CHARS} characters`
      );
    }

    const kind = stringField(raw, "kind");
    if (!kind || !MEMORY_KINDS.has(kind)) {
      return reject(`invalid memory kind: ${JSON.stringify(raw.kind)}`);
    }

    const basis = stringField(raw, "basis");
    if (!basis || !MEMORY_BASES.has(basis)) {
      return reject(`invalid or unsupported memory basis: ${JSON.stringify(raw.basis)}`);
    }

    const evidence = stringField(raw, "evidence");
    if (!evidence || evidence.length < 3 || evidence.length > MAX_EVIDENCE_CHARS) {
      return reject(
        `evidence must be a non-empty string of 3-${MAX_EVIDENCE_CHARS} characters`
      );
    }

    if (
      containsSecret(content) ||
      containsSecret(evidence) ||
      content.includes("[REDACTED_SECRET]") ||
      evidence.includes("[REDACTED_SECRET]")
    ) {
      return reject("candidate contains a detected secret or credential");
    }
    if (hasTransientLearningMarker(content)) {
      return reject("candidate contains transient run state (PID/port/temp path/session id/timestamp)");
    }
    if (SPECULATIVE_PATTERN.test(content)) {
      return reject("candidate contains speculative or unverified language");
    }

    const rawConfidence = raw.confidence;
    if (
      typeof rawConfidence !== "number" ||
      !Number.isFinite(rawConfidence) ||
      rawConfidence < 0 ||
      rawConfidence > 1
    ) {
      return reject("confidence must be a number between 0 and 1");
    }

    const basisValue = basis as LearningMemoryBasis;

    if (basisValue === "user-explicit") {
      if (!groundedInUserRequest(evidence, content, options.input)) {
        return reject(
          "user-explicit basis is not grounded in the user request or recent user messages"
        );
      }
    } else if (basisValue === "user-correction") {
      if (
        !signals.explicitCorrection ||
        !groundedInUserRequest(evidence, content, options.input)
      ) {
        return reject(
          "user-correction basis requires an actual correction grounded in the user request"
        );
      }
    } else if (basisValue === "verified-code") {
      if (!hasCodeVerification(options.input)) {
        return reject(
          "verified-code basis requires inspected/edited files or successful file tool calls"
        );
      }
      if (!evidenceMentionsObserved(evidence, options.input)) {
        return reject(
          "verified-code evidence does not reference any observed file or tool result"
        );
      }
    } else if (basisValue === "verified-runtime") {
      if (!hasRuntimeVerification(options.input)) {
        return reject(
          "verified-runtime basis requires a test result or successful command execution"
        );
      }
      if (!evidenceMentionsObserved(evidence, options.input)) {
        return reject(
          "verified-runtime evidence does not reference any observed command or test result"
        );
      }
    }

    let scope: MemoryScope = raw.scope === "global" || raw.scope === "project"
      ? raw.scope
      : options.memoryProjectScopeAvailable
        ? "project"
        : "global";

    if (raw.scope !== undefined && raw.scope !== "global" && raw.scope !== "project") {
      return reject(`invalid memory scope: ${JSON.stringify(raw.scope)}`);
    }

    const projectSpecific =
      /(?:这个|该|本)\s*(?:项目|仓库|代码库|工程)|this\s+(?:project|repo|repository)/i.test(
        content
      );
    const globalAllowed =
      kind === "preference" &&
      !projectSpecific &&
      (basisValue === "user-explicit" || basisValue === "user-correction");

    if (scope === "global" && !globalAllowed) {
      if (options.memoryProjectScopeAvailable) {
        warnings.push({
          stage: "scope",
          message: `Memory "${content.slice(0, 40)}..." requested global scope for ${kind}; downgraded to project.`,
        });
        scope = "project";
      } else {
        return reject(
          "global scope is only allowed for user-level preferences; no project scope is available to store this fact"
        );
      }
    }

    if (scope === "project" && !options.memoryProjectScopeAvailable) {
      return reject(
        "project scope requested but the learning hook has no project context"
      );
    }

    let confidence = rawConfidence;
    if (basisValue === "user-explicit") confidence = Math.max(confidence, 0.9);
    if (basisValue === "user-correction") confidence = Math.max(confidence, 0.85);
    if (confidence < 0.5) {
      return reject("confidence below the 0.5 auto-learning threshold");
    }

    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((tag): tag is string => typeof tag === "string")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0 && tag.length <= 40)
          .slice(0, 8)
      : undefined;

    return {
      content,
      kind: kind as MemoryKind,
      scope,
      basis: basisValue,
      confidence,
      evidence,
      tags: tags && tags.length > 0 ? tags : undefined,
    };
  }

  private validateSkillCandidate(
    raw: unknown,
    options: AnalyzeLearningOptions,
    signals: ExplicitLearningSignals,
    warnings: LearningWarning[],
    rejections: LearningRejection[]
  ): LearningSkillCandidate | null {
    const reject = (reason: string): null => {
      rejections.push({ target: "skill", reason });
      return null;
    };

    if (!isRecord(raw)) return reject("skill candidate is not an object");

    if (!hasWorkflowEvidence(options.input)) {
      return reject(
        "insufficient workflow evidence: needs at least two successful tool calls, or a passing test with a successful command, or two verified files"
      );
    }

    const requestedName = signals.requestedSkillName;
    const modelName = stringField(raw, "name");
    const name = (requestedName ?? modelName ?? "").toLowerCase();
    if (requestedName && modelName && modelName.toLowerCase() !== requestedName) {
      warnings.push({
        stage: "skill",
        message: `Model proposed skill name '${modelName}', but the user explicitly requested '${requestedName}'; using the requested name.`,
      });
    }
    if (!/^[a-z0-9][a-z0-9-_]{2,63}$/.test(name)) {
      return reject(
        `invalid skill name: ${JSON.stringify(name)}; expected a lowercase slug`
      );
    }

    const description = stringField(raw, "description");
    if (!description || description.length > 300) {
      return reject("description must be a non-empty string of at most 300 characters");
    }

    const whenToUse = stringField(raw, "whenToUse");
    if (!whenToUse || whenToUse.length > 500) {
      return reject("whenToUse must be a non-empty string of at most 500 characters");
    }

    const procedure = stringField(raw, "procedure");
    if (
      !procedure ||
      procedure.length < 20 ||
      procedure.length > MAX_SKILL_PROCEDURE_CHARS
    ) {
      return reject(
        `procedure must be a string of 20-${MAX_SKILL_PROCEDURE_CHARS} characters`
      );
    }
    if (looksLikeGenericProcedure(procedure)) {
      return reject(
        "procedure is a generic template; it needs concrete, reusable steps"
      );
    }

    const verification = stringField(raw, "verification");
    if (!verification || verification.length < 3 || verification.length > 1_000) {
      return reject("verification must be a non-empty string of 3-1000 characters");
    }

    const limitations = stringField(raw, "limitations");
    if (limitations && limitations.length > MAX_SKILL_LIMITATIONS_CHARS) {
      return reject(
        `limitations must be at most ${MAX_SKILL_LIMITATIONS_CHARS} characters`
      );
    }

    const evidence = stringField(raw, "evidence");
    if (!evidence || evidence.length < 3 || evidence.length > 1_000) {
      return reject("evidence must be a non-empty string of 3-1000 characters");
    }

    const allText = [description, whenToUse, procedure, verification, limitations ?? "", evidence].join("\n");
    if (containsSecret(allText) || allText.includes("[REDACTED_SECRET]")) {
      return reject("skill candidate contains a detected secret or credential");
    }
    if (hasTransientLearningMarker(procedure) || hasTransientLearningMarker(verification)) {
      return reject(
        "skill procedure/verification contains transient run state (PID/port/temp path/session id/timestamp)"
      );
    }
    if (!evidenceMentionsObserved(evidence, options.input)) {
      return reject(
        "skill evidence does not reference any actual tool result, file, or test from this run"
      );
    }
    if (SPECULATIVE_PATTERN.test(procedure)) {
      return reject("skill procedure contains speculative language");
    }

    const rawScope = raw.scope;
    if (rawScope !== undefined && rawScope !== "global" && rawScope !== "project") {
      return reject(`invalid skill scope: ${JSON.stringify(rawScope)}`);
    }

    let scope: SkillScope = rawScope === "global" ? "global" : "project";

    if (scope === "global") {
      const globalAllowed =
        signals.explicitSkillRequest && signals.mentionsGlobalScope;
      if (!globalAllowed) {
        if (options.skillProjectScopeAvailable) {
          warnings.push({
            stage: "scope",
            message: "Skill requested global scope without an explicit user request; downgraded to project.",
          });
          scope = "project";
        } else if (signals.explicitSkillRequest) {
          warnings.push({
            stage: "scope",
            message: "No project scope is available; explicit user-requested skill kept at global scope.",
          });
        } else {
          return reject(
            "global skill scope is not allowed for automatic generation without an explicit cross-project request"
          );
        }
      }
    }

    if (scope === "project" && !options.skillProjectScopeAvailable) {
      if (signals.explicitSkillRequest) {
        scope = "global";
        warnings.push({
          stage: "scope",
          message: "No project scope is available; explicit user-requested skill stored at global scope.",
        });
      } else {
        return reject(
          "project skill scope requested but the learning hook has no project context"
        );
      }
    }

    return {
      name,
      description,
      whenToUse,
      procedure,
      verification,
      limitations: limitations || undefined,
      scope,
      evidence,
    };
  }
}

/**
 * 便捷函数：不经过 LearningAnalyzer 实例时，也可以直接检测显式信号。
 */
export function inspectLearningSignals(userInput: string): ExplicitLearningSignals {
  return detectExplicitLearningSignals(userInput);
}
