import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveProjectContext } from "../src/project/project-context.js";
import { MemoryService } from "../src/memory/index.js";
import { SkillService } from "../src/skills/index.js";
import { RunLearningHook } from "../src/learning/index.js";
import { SkillOpenTool } from "../src/skills/skill-tool.js";

describe("Live E2E: Memory & Skills Full Lifecycle", () => {
  test("Live E2E: Explicit Memory, Reload, User Correction, Skill Generation, Progressive Disclosure & Zero-Pollution", async () => {
    const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-live-home-"));
    const testRepo = await fs.mkdtemp(path.join(os.tmpdir(), "nash-live-repo-"));

    try {
      const projectCtx = await resolveProjectContext({
        projectRoot: testRepo,
        nashHome: testHome,
      });

      const memoryService = new MemoryService({
        projectContext: projectCtx,
        nashHome: testHome,
      });
      const skillService = new SkillService({
        projectContext: projectCtx,
        nashHome: testHome,
      });
      const learningHook = new RunLearningHook({
        memoryService,
        skillService,
        projectContext: projectCtx,
        nashHome: testHome,
      });

      // 1. Live E2E: Memory 显式学习
      const memRunRes = await learningHook.processRun({
        sessionId: "live-session-1",
        userInput: "记住这个项目必须使用 Node 24.14。",
        response: "已为您记住该配置。",
      });
      assert.strictEqual(memRunRes.memoriesLearned.length, 1);
      assert.strictEqual(memRunRes.memoriesLearned[0].content, "这个项目必须使用 Node 24.14。");

      // 2. Live E2E: 重新加载并检索
      const retrieved = await memoryService.retrieveRelevant("这个项目应该使用哪个 Node 版本？");
      assert.strictEqual(retrieved.entries.length, 1);
      assert.ok(retrieved.entries[0].content.includes("24.14"));

      // 3. Live E2E: User Correction
      await memoryService.remember({
        content: "Package manager is npm.",
        source: "agent-learned",
      });
      await learningHook.processRun({
        sessionId: "live-session-2",
        userInput: "不对，这个项目应该使用 pnpm 而不是 npm。",
        response: "好的，已更正。",
      });
      const corrected = await memoryService.retrieveRelevant("package manager");
      assert.strictEqual(corrected.entries.length, 1);
      assert.ok(corrected.entries[0].content.includes("pnpm"));

      // 4. Live E2E: Skill 显式生成
      const skillRunRes = await learningHook.processRun({
        sessionId: "live-session-3",
        userInput: "把刚才安全 Bug 的 red→green 修复流程保存成 skill，叫 security-regression-fix",
        toolCalls: [
          { name: "read_file", args: { path: "src/auth.ts" } },
          { name: "edit_file", args: { path: "src/auth.ts" } },
          { name: "bash", args: { command: "npm test" } },
        ],
        testResults: { command: "npm test", passed: true },
      });
      assert.ok(skillRunRes.skillsCreated && skillRunRes.skillsCreated.length > 0);
      assert.strictEqual(skillRunRes.skillsCreated[0].name, "security-regression-fix");

      // 5. Level 1 Metadata Context 注入验证 (不应包含 procedure)
      const availablePrompt = await skillService.renderAvailableSkillsPrompt("security");
      assert.ok(availablePrompt.includes("security-regression-fix"));
      assert.ok(!availablePrompt.includes("1. Update file: `src/auth.ts`"));

      // 6. Level 2 On-Demand 加载验证 (skill_open)
      const openTool = new SkillOpenTool(skillService);
      const openRes = await openTool.execute({ name: "security-regression-fix" });
      assert.strictEqual(openRes.success, true);
      assert.ok(openRes.output.includes("Update file: `src/auth.ts`"));
      assert.ok(openRes.output.includes("npm test"));

      // 7. Live E2E: Auto Skill Boundary (普通修改 typo 不生成 Skill)
      const typoRunRes = await learningHook.processRun({
        sessionId: "live-session-4",
        userInput: "修复一个 typo",
        toolCalls: [{ name: "edit_file", args: { path: "readme.md" } }],
      });
      assert.strictEqual(typoRunRes.skillsCreated, undefined);

      // 8. Zero-Pollution 验证
      assert.strictEqual(fsSync.existsSync(path.join(testRepo, ".nash")), false);
      const repoFiles = await fs.readdir(testRepo);
      assert.deepStrictEqual(repoFiles, []);
    } finally {
      await fs.rm(testHome, { recursive: true, force: true });
      await fs.rm(testRepo, { recursive: true, force: true });
    }
  });
});
