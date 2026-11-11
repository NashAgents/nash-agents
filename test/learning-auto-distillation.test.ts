import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MemoryService,
  type MemoryConfig,
} from "../src/memory/index.js";
import {
  SkillService,
  type SkillConfig,
} from "../src/skills/index.js";
import {
  RunLearningHook,
  buildLearningContext,
  MAX_LEARNING_PROMPT_CHARS,
  type LearningModelCaller,
  type RunLearningResult,
} from "../src/learning/index.js";
import { RememberTool } from "../src/tools/index.js";
import { resolveProjectContext, type ProjectContext } from "../src/project/project-context.js";
import { EventBus } from "../src/observability/index.js";
import { ContextManager } from "../src/context/context-manager.js";
import { runAgentLoop } from "../src/runtime/agent-loop.js";

function json(value: unknown): string {
  return JSON.stringify(value);
}

function decisionWithMemory(memory: Record<string, unknown>): Record<string, unknown> {
  return { decision: "memory", memories: [memory], skill: null };
}

function decisionWithSkill(skill: Record<string, unknown>): Record<string, unknown> {
  return { decision: "skill", memories: [], skill };
}

const observedToolCalls = [
  {
    name: "read_file",
    args: { path: "src/auth.ts" },
    result: "export function verifyToken(token: string) { return token.length > 0; }",
    success: true,
    toolCallId: "call-1",
  },
  {
    name: "edit_file",
    args: { path: "src/auth.ts" },
    result: "updated verifyToken to reject empty and whitespace-only tokens",
    success: true,
    toolCallId: "call-2",
  },
  {
    name: "bash",
    args: { command: "npm test" },
    result: "12 passing, 0 failing",
    success: true,
    toolCallId: "call-3",
  },
];

describe("Model-driven auto learning & distillation", () => {
  let tmpHome: string;
  let tmpRepo: string;
  let projectContext: ProjectContext;
  let memoryService: MemoryService;
  let skillService: SkillService;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-learning-home-"));
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "nash-learning-repo-"));
    projectContext = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });
    memoryService = new MemoryService({
      projectContext,
      nashHome: tmpHome,
    });
    skillService = new SkillService({
      projectContext,
      nashHome: tmpHome,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  function createHook(options: {
    output?: unknown;
    rawText?: string;
    throwError?: boolean;
    memory?: MemoryService;
    skill?: SkillService;
    eventBus?: EventBus;
    captured?: string[];
  }): RunLearningHook {
    const caller: LearningModelCaller = async (request) => {
      options.captured?.push(request.systemPrompt + request.userPrompt);
      if (options.throwError) throw new Error("fake learning model is unavailable");
      return {
        text:
          options.rawText ??
          (typeof options.output === "string" ? options.output : json(options.output)),
        model: "fake-learning-model",
      };
    };

    return new RunLearningHook({
      memoryService: options.memory ?? memoryService,
      skillService: options.skill ?? skillService,
      projectContext,
      modelCaller: caller,
      eventBus: options.eventBus,
      timeoutMs: 1_000,
    });
  }

  async function activeMemories(): Promise<Awaited<ReturnType<MemoryService["getAll"]>>> {
    return (await memoryService.getAll("all")).filter((entry) => !entry.deprecated);
  }

  test("用户明确的全局偏好保存为 global preference，且来源标记为 user-explicit", async () => {
    const output = decisionWithMemory({
      content: "用户希望助手始终用中文回答，并称呼用户为哥哥。",
      kind: "preference",
      scope: "global",
      basis: "user-explicit",
      confidence: 1,
      evidence: "以后都用中文回答，叫我哥哥",
      tags: ["persona", "language"],
    });

    const result = await createHook({ output }).processRun({
      sessionId: "session-global-preference",
      runId: "run-1",
      userInput: "以后都用中文回答，叫我哥哥",
      response: "好的哥哥，我会一直用中文回答。",
    });

    assert.equal(result.status, "completed");
    assert.equal(result.memoriesLearned.length, 1);
    const saved = result.memoriesLearned[0]!;
    assert.equal(saved.scope, "global");
    assert.equal(saved.kind, "preference");
    assert.equal(saved.source, "user-explicit");
    assert.ok(saved.tags?.includes("persona"));
    assert.equal((await activeMemories()).length, 1);
  });

  test("仅适用于当前项目的事实保存为 project，不误判为全局偏好", async () => {
    const output = decisionWithMemory({
      content: "该仓库使用 pnpm 作为包管理器。",
      kind: "environment",
      scope: "global",
      basis: "verified-code",
      confidence: 0.9,
      evidence: "package.json: packageManager=pnpm",
      tags: ["package-manager"],
    });

    const result = await createHook({ output }).processRun({
      sessionId: "session-project-fact",
      runId: "run-2",
      userInput: "这个仓库用什么包管理器？",
      response: "该仓库使用 pnpm。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "package.json" },
          result: '{"packageManager":"pnpm@9.0.0"}',
          success: true,
          toolCallId: "call-package",
        },
      ],
    });

    assert.equal(result.status, "completed");
    const saved = result.memoriesLearned[0]!;
    assert.equal(saved.scope, "project");
    assert.equal(saved.source, "verified-code");
    assert.ok(
      result.warnings?.some((warning) => warning.stage === "scope"),
      "global architecture/environment facts must be conservatively downgraded to project"
    );
    assert.equal((await memoryService.getAll("global")).length, 0);
  });

  test("模型把项目专属内容误标为全局偏好时，保守降级为 project", async () => {
    const output = decisionWithMemory({
      content: "这个项目使用 pnpm 作为包管理器。",
      kind: "preference",
      scope: "global",
      basis: "user-explicit",
      confidence: 1,
      evidence: "记住：这个项目使用 pnpm。",
    });

    const result = await createHook({ output }).processRun({
      sessionId: "session-project-specific-preference",
      runId: "run-project-specific",
      userInput: "记住：这个项目使用 pnpm。",
      response: "已记录。",
    });

    assert.equal(result.status, "completed");
    const saved = result.memoriesLearned[0]!;
    assert.equal(saved.scope, "project");
    assert.ok(
      result.warnings?.some((warning) => warning.stage === "scope"),
      "project-specific content must not be promoted to global"
    );
  });

  test("临时状态、不确定推测和敏感凭据都不会写入长期记忆", async () => {
    const output = {
      decision: "memory",
      memories: [
        {
          content: "当前进程 PID: 12345，服务运行在 localhost:3000。",
          kind: "fact",
          scope: "project",
          basis: "verified-runtime",
          confidence: 0.9,
          evidence: "PID: 12345",
        },
        {
          content: "用户可能更喜欢深色主题。",
          kind: "preference",
          scope: "global",
          basis: "user-explicit",
          confidence: 0.9,
          evidence: "用户可能更喜欢深色主题",
        },
        {
          content: 'DEEPSEEK_API_KEY = "sk-test-2dfacb4231b34bb49d210787def" 已配置。',
          kind: "environment",
          scope: "project",
          basis: "verified-code",
          confidence: 0.9,
          evidence: "DEEPSEEK_API_KEY",
        },
      ],
      skill: null,
    };

    const result = await createHook({ output }).processRun({
      sessionId: "session-reject",
      runId: "run-3",
      userInput: "检查当前运行状态和配置",
      response: "检查完成。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: ".env" },
          result: "DEEPSEEK_API_KEY=sk-test-2dfacb4231b34bb49d210787def",
          success: true,
        },
      ],
      testResults: { command: "npm test", passed: true },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.memoriesLearned.length, 0);
    assert.equal((await activeMemories()).length, 0);
    assert.ok((result.rejections?.length ?? 0) >= 3);
  });

  test("有充分证据的可复用流程生成项目 Skill，SKILL.md 含用途、步骤、验证和限制", async () => {
    const output = decisionWithSkill({
      name: "auth-regression-red-green",
      description: "Reproduce and fix an authentication regression with a red-to-green test.",
      whenToUse:
        "When an auth/token regression has a reproducible failing test and the fix must preserve existing behavior.",
      procedure:
        "1. Read `src/auth.ts` and identify the invariant that the failing test expects.\n" +
        "2. Add or confirm a failing regression test before changing production code.\n" +
        "3. Apply the minimal guard fix in the affected auth function.\n" +
        "4. Run `npm test` and confirm the regression test moves from red to green.",
      verification:
        "Run `npm test`; the previously failing auth regression test must pass and the full suite must stay green.",
      limitations:
        "Requires an executable reproduction test. Do not use when the failure is environmental or unreproducible.",
      scope: "project",
      evidence: "Editing src/auth.ts and running npm test produced 12 passing, 0 failing.",
    });

    const result = await createHook({ output }).processRun({
      sessionId: "session-skill",
      runId: "run-4",
      userInput: "修复登录 token 校验回归并验证",
      response: "已修复并通过测试。",
      toolCalls: observedToolCalls,
      testResults: { command: "npm test", passed: true, redToGreen: true },
      verifiedFiles: ["src/auth.ts"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.skillsCreated?.length, 1);
    const created = result.skillsCreated![0]!;
    assert.equal(created.name, "auth-regression-red-green");
    assert.equal(created.scope, "project");

    const skillText = await fs.readFile(created.skillFilePath, "utf-8");
    assert.ok(skillText.includes("## When to use"));
    assert.ok(skillText.includes("## Procedure"));
    assert.ok(skillText.includes("## Verification"));
    assert.ok(skillText.includes("## Limitations"));
    assert.ok(skillText.includes("failing regression test"));
    assert.ok(!skillText.includes("Inspect state"));
  });

  test("工作流证据不足时不生成 Skill，即使 JSON 结构合法", async () => {
    const output = decisionWithSkill({
      name: "no-evidence-flow",
      description: "An unverified workflow.",
      whenToUse: "Whenever something similar happens.",
      procedure: "1. Inspect the code.\n2. Modify the code.\n3. Run the tests.",
      verification: "npm test",
      scope: "project",
      evidence: "The model believes this should work.",
    });

    const result = await createHook({ output }).processRun({
      sessionId: "session-no-skill",
      runId: "run-5",
      userInput: "把这个流程保存成 skill，叫 no-evidence-flow",
      response: "好的。",
      // 显式要求创建 Skill，但本轮没有任何真实工具/测试证据
      toolCalls: [],
    });

    assert.equal(result.skillsCreated, undefined);
    assert.ok(
      result.rejections?.some(
        (rejection) =>
          rejection.target === "skill" &&
          /insufficient workflow evidence/i.test(rejection.reason)
      )
    );
    assert.equal((await skillService.listAllSkills()).length, 0);
  });

  test("同名 Skill 已存在时不静默覆盖；显式请求时创建版本化名称", async () => {
    await skillService.createSkill({
      name: "existing-flow",
      description: "Original project workflow.",
      whenToUse: "When the original workflow applies.",
      procedure: "1. Original step one.\n2. Original step two.",
      verification: "npm test",
      scope: "project",
    });
    const originalPath = path.join(projectContext.skillsDir, "existing-flow", "SKILL.md");
    const originalContent = await fs.readFile(originalPath, "utf-8");

    const output = decisionWithSkill({
      name: "existing-flow",
      description: "Improved project workflow discovered in this run.",
      whenToUse: "When the improved workflow applies.",
      procedure:
        "1. Reproduce the failing auth regression with an isolated test.\n" +
        "2. Apply the minimal guard fix in src/auth.ts.\n" +
        "3. Run `npm test` and confirm red-to-green.",
      verification: "Run `npm test` and confirm the regression test becomes green.",
      scope: "project",
      evidence: "Editing src/auth.ts and running npm test produced 12 passing, 0 failing.",
    });

    // 自动沉淀：同名但内容不同 -> 跳过，绝不覆盖
    const autoResult = await createHook({ output }).processRun({
      sessionId: "session-skill-conflict-auto",
      runId: "run-6",
      userInput: "修复登录校验回归",
      response: "已修复。",
      toolCalls: observedToolCalls,
      testResults: { command: "npm test", passed: true },
      verifiedFiles: ["src/auth.ts"],
    });

    assert.equal(autoResult.skillsCreated, undefined);
    assert.match(autoResult.skillSkippedReason ?? "", /already exists/i);
    assert.equal(await fs.readFile(originalPath, "utf-8"), originalContent);

    // 用户显式要求同名 Skill：版本化写入，原文件保持不变
    const explicitResult = await createHook({ output }).processRun({
      sessionId: "session-skill-conflict-explicit",
      runId: "run-7",
      userInput: "把这个流程保存成 skill，叫 existing-flow",
      response: "已保存。",
      toolCalls: observedToolCalls,
      testResults: { command: "npm test", passed: true },
      verifiedFiles: ["src/auth.ts"],
    });

    assert.equal(explicitResult.skillsCreated?.length, 1);
    assert.equal(explicitResult.skillsCreated![0]!.name, "existing-flow-v2");
    assert.equal(await fs.readFile(originalPath, "utf-8"), originalContent);
    assert.ok(
      fsSync.existsSync(path.join(projectContext.skillsDir, "existing-flow-v2", "SKILL.md"))
    );
  });

  test("模型伪造 user-explicit/verified 依据时拒绝写入", async () => {
    const output = {
      decision: "memory",
      memories: [
        {
          content: "用户喜欢使用 Rust 开发所有项目。",
          kind: "preference",
          scope: "global",
          basis: "user-explicit",
          confidence: 1,
          evidence: "用户说过喜欢 Rust",
        },
        {
          content: "生产环境已经切换到 PostgreSQL 16。",
          kind: "environment",
          scope: "project",
          basis: "verified-runtime",
          confidence: 0.9,
          evidence: "生产环境已切换",
        },
      ],
      skill: null,
    };

    const result = await createHook({ output }).processRun({
      sessionId: "session-hallucinated-evidence",
      runId: "run-hallucinated",
      userInput: "记住：这个项目使用 pnpm。",
      response: "已记录。",
      // 没有测试、没有命令、没有文件；verified-runtime 没有真实依据
      toolCalls: [],
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.memoriesLearned.length, 0);
    assert.equal((await activeMemories()).length, 0);
    assert.ok(
      result.rejections?.some((rejection) =>
        /user-explicit basis is not grounded/i.test(rejection.reason)
      )
    );
    assert.ok(
      result.rejections?.some((rejection) =>
        /verified-runtime basis requires/i.test(rejection.reason)
      )
    );
  });

  test("模型返回空结果时不写入任何内容", async () => {
    const result = await createHook({
      output: { decision: "none", memories: [], skill: null, notes: "no durable value" },
    }).processRun({
      sessionId: "session-none",
      runId: "run-8",
      userInput: "查看一下当前目录",
      response: "目录为空。",
      toolCalls: observedToolCalls,
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.skippedReason, "model-found-nothing-durable");
    assert.equal(result.memoriesLearned.length, 0);
    assert.equal(result.skillsCreated, undefined);
    assert.equal((await activeMemories()).length, 0);
  });

  test("非法 JSON 与非法作用域都不会写入未经验证的内容", async () => {
    const invalidJson = await createHook({
      rawText: "I think this run is useful but here is no JSON.",
    }).processRun({
      sessionId: "session-invalid-json",
      runId: "run-9",
      userInput: "修复一个 bug",
      response: "已修复。",
      toolCalls: observedToolCalls,
    });

    assert.equal(invalidJson.status, "failed");
    assert.equal(invalidJson.failures[0]?.stage, "parse");
    assert.equal((await activeMemories()).length, 0);

    const invalidScope = await createHook({
      output: decisionWithMemory({
        content: "该服务监听 8080 端口。",
        kind: "environment",
        scope: "galaxy",
        basis: "verified-code",
        confidence: 0.9,
        evidence: "config/server.ts: port 8080",
      }),
    }).processRun({
      sessionId: "session-invalid-scope",
      runId: "run-10",
      userInput: "服务监听哪个端口？",
      response: "8080。",
      toolCalls: [
        {
          name: "read_file",
          args: { path: "config/server.ts" },
          result: "export const port = 8080;",
          success: true,
        },
      ],
    });

    assert.equal(invalidScope.status, "skipped");
    assert.equal(invalidScope.memoriesLearned.length, 0);
    assert.ok(
      invalidScope.rejections?.some((rejection) =>
        /invalid memory scope/i.test(rejection.reason)
      )
    );
    assert.equal((await activeMemories()).length, 0);
  });

  test("模型调用失败时记录可观察失败，主任务结果不受影响", async () => {
    const result = await createHook({ throwError: true }).processRun({
      sessionId: "session-model-failure",
      runId: "run-11",
      userInput: "完成一个任务",
      response: "任务完成。",
      toolCalls: observedToolCalls,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failures[0]?.stage, "model");
    assert.equal(result.memoriesLearned.length, 0);
    assert.equal((await activeMemories()).length, 0);
  });

  test("关闭自动学习时不再自动写入，但显式 remember 仍然可用", async () => {
    const disabledMemory = new MemoryService({
      projectContext,
      nashHome: tmpHome,
      config: { autoLearn: false } satisfies Partial<MemoryConfig>,
    });
    const disabledSkill = new SkillService({
      projectContext,
      nashHome: tmpHome,
      config: { autoGenerate: false } satisfies Partial<SkillConfig>,
    });

    const captured: string[] = [];
    const result = await createHook({
      output: decisionWithMemory({
        content: "该假设不应被自动保存。",
        kind: "fact",
        scope: "project",
        basis: "verified-code",
        confidence: 0.9,
        evidence: "package.json",
      }),
      memory: disabledMemory,
      skill: disabledSkill,
      captured,
    }).processRun({
      sessionId: "session-disabled",
      runId: "run-12",
      userInput: "记录一些东西",
      response: "完成。",
      toolCalls: observedToolCalls,
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.skippedReason, "automatic-learning-disabled");
    assert.equal(captured.length, 0, "automatic learning must not call the model when disabled");
    assert.equal((await disabledMemory.getAll("all")).length, 0);

    const rememberResult = await new RememberTool(disabledMemory).execute({
      fact: "用户希望回答保持简洁。",
      kind: "preference",
      scope: "global",
    });
    assert.equal(rememberResult.success, true);
    const all = (await disabledMemory.getAll("all")).filter((entry) => !entry.deprecated);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.source, "user-explicit");
  });

  test("自动 Skill 生成关闭时，用户显式要求创建 Skill 仍然可用", async () => {
    const disabledSkill = new SkillService({
      projectContext,
      nashHome: tmpHome,
      config: { autoGenerate: false } satisfies Partial<SkillConfig>,
    });

    const result = await createHook({
      output: decisionWithSkill({
        name: "explicit-only-skill",
        description: "A workflow explicitly requested by the user.",
        whenToUse: "When the user asks to reuse this verified workflow.",
        procedure:
          "1. Read `src/auth.ts` to locate the token guard.\n" +
          "2. Add a failing regression test for the empty-token case.\n" +
          "3. Apply the guard fix and run `npm test`.",
        verification: "Run `npm test` and confirm the regression test is green.",
        scope: "project",
        evidence: "Editing src/auth.ts and running npm test produced 12 passing, 0 failing.",
      }),
      skill: disabledSkill,
    }).processRun({
      sessionId: "session-explicit-skill",
      runId: "run-13",
      userInput: "把这个流程保存成 skill，叫 explicit-only-skill",
      response: "已保存。",
      toolCalls: observedToolCalls,
      testResults: { command: "npm test", passed: true },
      verifiedFiles: ["src/auth.ts"],
    });

    assert.equal(result.status, "completed");
    assert.equal(result.skillsCreated?.length, 1);
    assert.equal(result.skillsCreated![0]!.name, "explicit-only-skill");
  });

  test("同一轮反复处理保持幂等，不制造重复 Memory 或 Skill", async () => {
    const memoryOutput = decisionWithMemory({
      content: "`npm test` 是该仓库的回归验证命令。",
      kind: "environment",
      scope: "project",
      basis: "verified-runtime",
      confidence: 0.9,
      evidence: "npm test passed",
    });
    const skillOutput = decisionWithSkill({
      name: "auth-red-green-workflow",
      description: "Fix an auth regression via red-to-green testing.",
      whenToUse: "When an auth regression has a reproducible failing test.",
      procedure:
        "1. Reproduce the failing auth regression with a focused test.\n" +
        "2. Apply the minimal guard fix in src/auth.ts.\n" +
        "3. Run `npm test` and confirm red-to-green.",
      verification: "Run `npm test`; the regression test must pass.",
      scope: "project",
      evidence: "Editing src/auth.ts and running npm test produced 12 passing, 0 failing.",
    });

    const combined = {
      decision: "both",
      memories: memoryOutput.memories,
      skill: skillOutput.skill,
    };
    const input = {
      sessionId: "session-idempotent",
      runId: "run-14",
      userInput: "修复登录回归并验证",
      response: "完成。",
      toolCalls: observedToolCalls,
      testResults: { command: "npm test", passed: true },
      verifiedFiles: ["src/auth.ts"],
    };

    const first = await createHook({ output: combined }).processRun(input);
    assert.equal(first.status, "completed");
    assert.equal(first.memoriesLearned.length, 1);
    assert.equal(first.skillsCreated?.length, 1);

    const second = await createHook({ output: combined }).processRun(input);
    assert.equal(second.status, "skipped");
    assert.equal(second.memoriesLearned.length, 0);
    assert.equal(second.skillsCreated, undefined);
    assert.equal((await activeMemories()).length, 1);
    assert.equal((await skillService.listAllSkills()).length, 1);
  });

  test("上下文过长时遵守输入预算，并对工具输出做可追溯裁剪", async () => {
    const hugeOutput = "x".repeat(120_000);
    const longText = "长文本".repeat(20_000);

    const context = buildLearningContext({
      input: {
        sessionId: "session-budget",
        runId: "run-15",
        userInput: "请分析这段超长输出：" + longText,
        response: longText,
        recentMessages: Array.from({ length: 20 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `${index}: ${longText}`,
        })),
        toolCalls: Array.from({ length: 20 }, (_, index) => ({
          name: "bash",
          args: { command: `cat huge-${index}.log` },
          result: hugeOutput,
          success: true,
        })),
        testResults: { command: "npm test", passed: true },
        verifiedFiles: ["src/auth.ts"],
      },
      existingMemories: Array.from({ length: 50 }, (_, index) => ({
        id: `mem-${index}`,
        scope: "project" as const,
        kind: "fact" as const,
        content: `existing memory ${index} ${longText}`,
        confidence: 0.9,
        source: "verified-code" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 1,
      })),
      existingSkills: Array.from({ length: 20 }, (_, index) => ({
        name: `skill-${index}`,
        description: `skill ${index} ${longText}`,
        scope: "project",
      })),
      projectContext,
      memoryEnabled: true,
      skillEnabled: true,
    });

    assert.ok(context.promptChars <= MAX_LEARNING_PROMPT_CHARS);
    assert.equal(
      context.promptChars,
      context.systemPrompt.length + context.userPrompt.length
    );
    assert.equal(context.truncated, true);
    assert.match(context.userPrompt, /truncated/i);
    assert.match(context.userPrompt, /original \d+ chars/);
  });

  test("RunLearningHook 失败不会改变 runAgentLoop 的最终答案，并通过 EventBus 暴露", async (t) => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "mock-learning-integration-key";
    t.after(() => {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = originalKey;
    });

    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      const body = {
        choices: [
          {
            message: { role: "assistant", content: "main task completed" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const isStream = init?.body
        ? Boolean(JSON.parse(String(init.body)).stream)
        : false;
      if (isStream) {
        return new Response(
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "main task completed" },
                finish_reason: "stop",
              },
            ],
            usage: body.usage,
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        );
      }
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const contextManager = new ContextManager({
      projectContext,
      config: { autoCompact: false },
    });
    const eventBus = new EventBus();
    const learningEvents: string[] = [];
    eventBus.subscribe("learning.failed", () => {
      learningEvents.push("learning.failed");
    });

    const answer = await runAgentLoop("say something", {
      projectContext,
      contextManager,
      standaloneSystemPrompt: true,
      systemPrompt: "Test",
      tools: [],
      maxSteps: 1,
      printStats: false,
      eventBus,
      learningModelCaller: async () => {
        throw new Error("learning model unavailable");
      },
    });

    assert.equal(answer, "main task completed");
    assert.ok(
      learningEvents.length > 0,
      "learning failures must be observable without changing the main result"
    );
  });
});
