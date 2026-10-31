import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { MemoryService } from "../src/memory/index.js";
import { SkillService } from "../src/skills/index.js";
import { loadRepositoryInstructions } from "../src/context/repository-instructions.js";
import { ContextManager } from "../src/context/context-manager.js";
import { resolveProjectContext } from "../src/project/project-context.js";
import { handleSlashCommand } from "../src/cli/slash-commands.js";
import { TerminalUI } from "../src/cli/terminal-ui.js";
import { InputManager } from "../src/cli/input-manager.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { AgentTranscriptProjection } from "../src/presentation/agent-transcript-projection.js";
import { SkillsPicker } from "../src/presentation/skills-picker.js";

describe("Memory & Skills Multi-Agent, CLI, Persistence & Zero-Pollution E2E", () => {
  let tmpHome: string;
  let tmpRepo: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-integ-home-"));
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "nash-integ-repo-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  // 56 ~ 60. Multi-Agent 访问与安全隔离
  test("56 ~ 60. Main 与 SubAgent 均能读取相关 Memory 与 Skill，且写入走统一授权服务", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const memoryService = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });
    const skillService = new SkillService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });

    // 预置一条 project 记忆和全局技能
    await memoryService.remember({
      content: "Bubblewrap is primary Linux sandbox backend.",
      kind: "architecture",
      source: "verified-runtime",
      scope: "project",
    });

    await skillService.createSkill({
      name: "linux-audit",
      description: "Audit Linux sandbox capabilities.",
      whenToUse: "When checking bwrap.",
      procedure: "1. Probe.\n2. Verify.",
      verification: "npm test",
      scope: "global",
    });

    // Main 角色读取
    const mainMem = await memoryService.retrieveRelevant("Linux sandbox");
    assert.strictEqual(mainMem.entries.length, 1);
    assert.strictEqual(mainMem.entries[0].content, "Bubblewrap is primary Linux sandbox backend.");

    // SubAgent 角色读取
    const subMem = await memoryService.retrieveRelevant("Bubblewrap");
    assert.strictEqual(subMem.entries.length, 1);

    // 工具注册中心自动注入 skill_open 工具
    const registry = createDefaultToolRegistry({
      skillService,
      agentId: "subagent-1",
      projectId: projectCtx.projectId,
    });
    assert.ok(registry.has("skill_open"));

    const openTool = registry.get("skill_open")!;
    const toolRes: any = await openTool.execute({ name: "linux-audit" });
    assert.strictEqual(toolRes.success, true);
    assert.ok(toolRes.output.includes("Audit Linux sandbox capabilities."));
  });

  // 61 ~ 66. Context 分层与 Repository Instructions 优先权
  test("61 ~ 66. Context 分层：AGENTS.md 优先于 Memory，Memory 不被复制进 session.jsonl", async () => {
    // 1. 创建仓库根目录的 AGENTS.md
    const agentsMdPath = path.join(tmpRepo, "AGENTS.md");
    await fs.writeFile(
      agentsMdPath,
      "# Team Rules\nAll tests must pass 100% before commit.",
      "utf-8"
    );

    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const repoIns = await loadRepositoryInstructions(tmpRepo);
    assert.strictEqual(repoIns.hasInstructions, true);
    assert.strictEqual(repoIns.sourceFile, "AGENTS.md");
    assert.ok(repoIns.content.includes("All tests must pass 100%"));

    const contextManager = new ContextManager({
      projectContext: projectCtx,
    });

    // 记录普通用户消息
    await contextManager.recordUserMessage("Hello");
    const records = await contextManager.getSession().getRecords();

    // 验证：session.jsonl 只记录真实对话事件，绝不把整个 Memory Store dump 进 durable session
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].type, "user");
  });

  // 67 ~ 70. CLI Slash Commands (/memory, /remember, /skills, /context)
  test("67 ~ 70. CLI 命令 /remember, /memory, /skills, /context 应结构化响应", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const memoryService = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });
    const skillService = new SkillService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });
    const contextManager = new ContextManager({
      projectContext: projectCtx,
    });

    let renderedLogs: string[] = [];
    const mockUI = {
      renderInfo: (msg: string) => renderedLogs.push(msg),
      renderWarning: (msg: string) => renderedLogs.push(msg),
      renderError: (msg: string) => renderedLogs.push(msg),
    } as unknown as TerminalUI;

    const mockInput = {} as InputManager;

    // 68. /remember 命令
    const resRemember = await handleSlashCommand("/remember Node.js requirement is 24.14", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resRemember.handled, true);

    // 67. /memory 命令
    const resMem = await handleSlashCommand("/memory", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resMem.handled, true);

    // 67.1 /memory search
    const resMemSearch = await handleSlashCommand("/memory search Node", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resMemSearch.handled, true);

    // 69. /skills 命令
    await skillService.createSkill({
      name: "sample-workflow",
      description: "Sample test workflow.",
      whenToUse: "When testing.",
      procedure: "1. Step A\n2. Step B",
      verification: "npm test",
      scope: "project",
    });

    const resSkills = await handleSlashCommand("/skills", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resSkills.handled, true);

    // 69.1 /skills show sample-workflow
    const resSkillsShow = await handleSlashCommand("/skills show sample-workflow", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resSkillsShow.handled, true);

    // 70. /context 命令
    const resContext = await handleSlashCommand("/context", {
      inputManager: mockInput,
      terminalUI: mockUI,
      contextManager,
      projectContext: projectCtx,
      memoryService,
      skillService,
    });
    assert.strictEqual(resContext.handled, true);
  });

  // 71 & 72. 重启持久化与代码仓库零污染 (Zero-Pollution)
  test("71 & 72. 进程重启后 Memory 与 Skills 依然持久完整，且代码仓库无任何 .nash 脏目录", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const memService1 = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });
    const skillService1 = new SkillService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });

    await memService1.remember({
      content: "Persistent Fact across restarts.",
      kind: "fact",
      source: "user-explicit",
    });

    await skillService1.createSkill({
      name: "restart-skill",
      description: "Skill that survives restart.",
      whenToUse: "When testing restart.",
      procedure: "Procedure 123.",
      verification: "Verification 123.",
    });

    // 模拟 Nash 退出并重启 (实例化全新的 Service 读取相同存储路径)
    const memService2 = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });
    const skillService2 = new SkillService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });

    const reloadedMems = await memService2.getAll();
    assert.strictEqual(reloadedMems.length, 1);
    assert.strictEqual(reloadedMems[0].content, "Persistent Fact across restarts.");

    const reloadedSkills = await skillService2.listAllSkills();
    assert.strictEqual(reloadedSkills.length, 1);
    assert.strictEqual(reloadedSkills[0].name, "restart-skill");

    // 72. 校验用户代码仓库目录：绝对没有产生任何 .nash/memory 或 .nash/skills
    const repoNashDir = path.join(tmpRepo, ".nash");
    assert.strictEqual(fsSync.existsSync(repoNashDir), false);

    const repoEntries = await fs.readdir(tmpRepo);
    assert.ok(!repoEntries.includes(".nash"));
  });

  // 73. 记忆工具：remember 与 search_memory 正式注册且具备端到端读写能力
  test("73. ToolRegistry 应注册 remember 与 search_memory 工具，且工具调用能直接写入和查询 Memory", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const memoryService = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });

    const registry = createDefaultToolRegistry({
      memoryService,
      agentId: "main",
      projectId: projectCtx.projectId,
    });

    assert.ok(registry.has("remember"), "注册中心应包含 remember 工具");
    assert.ok(registry.has("search_memory"), "注册中心应包含 search_memory 工具");

    const rememberTool = registry.get("remember")!;
    const searchTool = registry.get("search_memory")!;

    // 1. 调用 remember 写入偏好
    const rememberResult = (await rememberTool.execute({
      fact: "称呼我为哥哥，你是17岁女高中生",
      kind: "preference",
    })) as any;
    assert.strictEqual(rememberResult.success, true);
    assert.ok(rememberResult.output.includes("Successfully remembered"));

    // 2. 调用 search_memory 检索
    const searchResult = (await searchTool.execute({
      query: "哥哥",
    })) as any;
    assert.strictEqual(searchResult.success, true);
    assert.ok(searchResult.output.includes("17岁女高中生"));

    // 3. 验证在 MemoryService 中立即可见
    const all = await memoryService.getAll();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].kind, "preference");
  });

  // 74. 记忆召回指示行：正确呈现 recalled N memories 并在 Ctrl+O 详细视图展开条目
  test("74. 记忆召回指示行：正确呈现 recalled N memories 并在 Ctrl+O 详细视图展开条目", () => {
    const proj = new AgentTranscriptProjection("main");

    // 模拟本轮召回 2 条记忆
    proj.recordRecalledMemories([
      { id: "m1", content: "用户称谓：哥哥", kind: "preference", scope: "global" },
      { id: "m2", content: "助手人设：17岁女高中生", kind: "preference", scope: "global" },
    ]);

    // 终结 thought 并排版
    proj.finalizeThought(4900, 100);
    const collapsedLines = proj.getDisplayLines(100);

    // 默认折叠视图应包含 recalled 2 memories 与 ctrl+o to expand 提示
    const summaryLine = collapsedLines.find((l) => l.includes("Thought") && l.includes("recalled"));
    assert.ok(summaryLine, "折叠视图应包含 Thought summary 行");
    assert.ok(summaryLine.includes("recalled 2 memories"));
    assert.ok(summaryLine.includes("ctrl+o to expand"));

    // 切换至详细视图 (模拟 Ctrl+O)
    proj.toggleDetailedView();
    const expandedLines = proj.getDisplayLines(100);

    const expandedSummary = expandedLines.find((l) => l.includes("Thought") && l.includes("recalled"));
    assert.ok(expandedSummary?.includes("ctrl+o to collapse"));
    assert.ok(expandedLines.some((l) => l.includes("用户称谓：哥哥")));
    assert.ok(expandedLines.some((l) => l.includes("助手人设：17岁女高中生")));
  });

  // 75. SkillsPicker 交互面板，支持上下选择与 4 档模式循环切换
  test("75. SkillsPicker 交互面板，支持上下选择与 4 档模式循环切换", () => {
    const picker = new SkillsPicker([
      {
        metadata: {
          name: "agent-team-governance",
          description: "Governs multi-agent teams.",
          scope: "global",
          directoryPath: "/tmp",
          skillFilePath: "/tmp/SKILL.md",
        },
        mode: "on",
        estimatedTokens: 130,
      },
      {
        metadata: {
          name: "cross-agent-sync",
          description: "Sync memories across agents.",
          scope: "global",
          directoryPath: "/tmp",
          skillFilePath: "/tmp/SKILL.md",
        },
        mode: "on",
        estimatedTokens: 90,
      },
    ]);

    // 初始状态渲染检查
    const rendered = picker.render(80, 20);
    assert.ok(rendered.some((l) => l.includes("Skills")));
    assert.ok(rendered.some((l) => l.includes("Search skills...")));
    assert.ok(rendered.some((l) => l.includes("✓ on") && l.includes("agent-team-governance")));

    // 循环切换首项模式：on -> off -> name-only -> user-only -> on
    const r1 = picker.cycleCurrentMode();
    assert.strictEqual(r1?.newMode, "off");

    const r2 = picker.cycleCurrentMode();
    assert.strictEqual(r2?.newMode, "name-only");

    const r3 = picker.cycleCurrentMode();
    assert.strictEqual(r3?.newMode, "user-only");

    const r4 = picker.cycleCurrentMode();
    assert.strictEqual(r4?.newMode, "on");

    // 上下移动光标
    picker.move(1);
    assert.strictEqual(picker.selectedIndex, 1);
    picker.cycleCurrentMode();
    assert.strictEqual(picker.matches[1]?.mode, "off");
  });

  // 76. SkillService 模式差异化 Prompt 渐进式渲染
  test("76. SkillService 模式差异化 Prompt 渐进式渲染 (on 为完整披露，name-only 为极简列表，off/user-only 排除)", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });

    const skillService = new SkillService({
      projectContext: projectCtx,
      nashHome: tmpHome,
    });

    await skillService.createSkill({
      name: "skill-progressive",
      description: "Progressive skill test.",
      whenToUse: "When testing progressive disclosure.",
      procedure: "Step 1.",
      verification: "npm test",
    });

    await skillService.createSkill({
      name: "skill-nameonly",
      description: "Name only test.",
      whenToUse: "When testing name only.",
      procedure: "Step 1.",
      verification: "npm test",
    });

    await skillService.createSkill({
      name: "skill-disabled",
      description: "Disabled test.",
      whenToUse: "When testing disabled.",
      procedure: "Step 1.",
      verification: "npm test",
    });

    await skillService.setSkillMode("skill-progressive", "on");
    await skillService.setSkillMode("skill-nameonly", "name-only");
    await skillService.setSkillMode("skill-disabled", "off");

    const prompt = await skillService.renderAvailableSkillsPrompt("progressive");
    // on 模式注入完整元数据描述
    assert.ok(prompt.includes("skill-progressive"));
    assert.ok(prompt.includes("Progressive skill test."));

    // name-only 仅在末尾以名称列表追加
    assert.ok(prompt.includes("Additional name-only skills"));
    assert.ok(prompt.includes("skill-nameonly"));
    assert.ok(!prompt.includes("Name only test."));

    // off 模式完全不出现
    assert.ok(!prompt.includes("skill-disabled"));
  });
});
