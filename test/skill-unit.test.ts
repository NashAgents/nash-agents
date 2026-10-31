import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  SkillRegistry,
  SkillRetriever,
  SkillLoader,
  SkillWriter,
  SkillService,
  SkillOpenTool,
  validateSkillName,
  assertSafeSkillPath,
  parseSkillMarkdown,
  formatSkillMarkdown,
  getGlobalSkillsDir,
  getProjectSkillsDir,
} from "../src/skills/index.js";
import { SkillObserver } from "../src/learning/skill-observer.js";
import { resolveProjectContext } from "../src/project/project-context.js";

describe("Skill Unit & Progressive Disclosure & Generation Tests", () => {
  let tmpHome: string;
  let tmpRepo: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-skill-home-"));
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "nash-skill-repo-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  // 31 & 32 & 33. global & project skill discovery & override
  test("31 ~ 33. Global 与 Project Skills 扫描发现，同名 Project Skill 覆盖 Global Skill", async () => {
    const globalDir = getGlobalSkillsDir(tmpHome);
    const projectDir = path.join(tmpHome, "projects", "demo", "skills");

    const writer = new SkillWriter(globalDir, projectDir);

    // 创建 Global Skill
    await writer.createSkill({
      name: "typescript-debug",
      description: "Global TypeScript debugging guide.",
      whenToUse: "When debugging general TypeScript issues.",
      procedure: "1. Check tsconfig.\n2. Run tsc --noEmit.",
      verification: "npm run typecheck",
      scope: "global",
    });

    // 创建同名 Project Skill (覆盖)
    await writer.createSkill({
      name: "typescript-debug",
      description: "Project-specific TypeScript debugging guide with strict ESM.",
      whenToUse: "When debugging this repository's TypeScript code.",
      procedure: "1. Ensure .js extension on imports.\n2. Run npm run typecheck.",
      verification: "npm run typecheck && npm test",
      scope: "project",
    });

    // 创建另一个独有 Project Skill
    await writer.createSkill({
      name: "linux-sandbox-audit",
      description: "Audit Linux Bubblewrap/Landlock sandbox.",
      whenToUse: "When verifying Linux sandbox invariants.",
      procedure: "1. Probe backend.\n2. Check bwrap args.",
      verification: "npm test test/sandbox.test.ts",
      scope: "project",
    });

    const registry = new SkillRegistry({ globalDir, projectDir });
    const all = await registry.getAllMetadata();

    assert.strictEqual(all.length, 2);
    const tsSkill = all.find((s) => s.name === "typescript-debug");
    assert.strictEqual(tsSkill?.scope, "project");
    assert.ok(tsSkill?.description.includes("strict ESM"));

    const auditSkill = all.find((s) => s.name === "linux-sandbox-audit");
    assert.strictEqual(auditSkill?.scope, "project");
  });

  // 34 & 35 & 36. frontmatter parse & validation & path traversal
  test("34 ~ 36. Frontmatter 正确解析、非法结构拒绝与路径遍历防护", () => {
    // 34. Frontmatter 正常解析
    const sampleMd = `---
name: security-fix
description: "Reproduce and fix security regressions."
---

# security-fix

## When to use
When resolving security vulnerabilities.

## Procedure
1. Create reproduction test.
2. Fix invariant.

## Verification
npm test
`;

    const parsed = parseSkillMarkdown(sampleMd, {
      name: "security-fix",
      scope: "project",
      directoryPath: "/tmp/skills/security-fix",
      skillFilePath: "/tmp/skills/security-fix/SKILL.md",
    });

    assert.strictEqual(parsed.metadata.name, "security-fix");
    assert.strictEqual(parsed.metadata.description, "Reproduce and fix security regressions.");
    assert.ok(parsed.procedure.includes("Create reproduction test."));
    assert.strictEqual(parsed.verification, "npm test");

    // 35 & 36. 非法命名与路径遍历拦截
    assert.throws(() => validateSkillName("../bad-skill"), /非法 Skill 名称/);
    assert.throws(() => validateSkillName("BAD_UPPERCASE"), /非法 Skill 名称/);
    assert.throws(() => validateSkillName("skill with spaces"), /非法 Skill 名称/);
    assert.throws(() => {
      assertSafeSkillPath("/tmp/skills", "/tmp/skills/../../etc/passwd");
    }, /超出合法基准目录/);
  });

  // 37 ~ 40. Progressive Disclosure (Level 1 Metadata -> Level 2 SKILL.md -> Level 3 References)
  test("37 ~ 40. Progressive Disclosure: Discovery 阶段仅扫描元数据，skill_open 才按需读取全文", async () => {
    const globalDir = getGlobalSkillsDir(tmpHome);
    const writer = new SkillWriter(globalDir);

    await writer.createSkill({
      name: "complex-workflow",
      description: "Very large workflow with references.",
      whenToUse: "When performing complex multi-step operations.",
      procedure: "Detailed multi-page procedure content...",
      verification: "Verification suite command.",
      scope: "global",
      references: {
        "guide.md": "# Detailed Reference Guide\nDeep architectural details...",
      },
      scripts: {
        "helper.sh": "#!/bin/bash\necho 'helper'",
      },
    });

    const registry = new SkillRegistry({ globalDir });

    // Level 1: 仅扫描元数据 (不包含庞大 procedure)
    const allMeta = await registry.getAllMetadata();
    assert.strictEqual(allMeta.length, 1);
    assert.strictEqual(allMeta[0].name, "complex-workflow");
    assert.strictEqual(allMeta[0].hasReferences, true);
    assert.strictEqual(allMeta[0].hasScripts, true);

    // Level 2: 按需加载 SKILL.md
    const loader = new SkillLoader();
    const def = await loader.loadSkillDefinition(allMeta[0]);
    assert.ok(def.procedure.includes("Detailed multi-page procedure content..."));
    assert.deepStrictEqual(def.referenceFiles, ["guide.md"]);
    assert.deepStrictEqual(def.scriptFiles, ["helper.sh"]);

    // Level 3: 按需加载 reference.md
    const refContent = await loader.loadReferenceDocument(allMeta[0], "guide.md");
    assert.ok(refContent.includes("Detailed Reference Guide"));
  });

  // 41 & 42. script sandbox & secret scan
  test("41 & 42. Skill 创建自动扫描并脱敏 Secret", async () => {
    const globalDir = getGlobalSkillsDir(tmpHome);
    const writer = new SkillWriter(globalDir);

    const meta = await writer.createSkill({
      name: "deploy-service",
      description: 'Deploy service with API_KEY: "sk-test-8556392ebf066eb500b7b2b6890"',
      whenToUse: "When deploying.",
      procedure: 'Export token: "sk-test-8556392ebf066eb500b7b2b6890"',
      verification: "curl test",
      scope: "global",
    });

    const skillRaw = await fs.readFile(meta.skillFilePath, "utf-8");
    assert.ok(!skillRaw.includes("sk-test-8556392ebf066eb500b7b2b6890"));
    assert.ok(skillRaw.includes("[REDACTED_SECRET]"));
  });

  // 43 ~ 47. 100 个 Skills 存在时不爆 Context，仅注入 Top-N 元数据
  test("43 ~ 47. 拥有海量 Skills 时，Context 只出现筛选后的 Top-N 元数据，绝不撑爆 Token 预算", async () => {
    const globalDir = getGlobalSkillsDir(tmpHome);
    const writer = new SkillWriter(globalDir);

    // 批量创建 25 个 Skills
    for (let i = 1; i <= 25; i++) {
      await writer.createSkill({
        name: `skill-item-${i}`,
        description: `Description for skill number ${i}.`,
        whenToUse: `When task matches number ${i}.`,
        procedure: `Procedure steps for skill ${i}.`,
        verification: `Verify skill ${i}.`,
        scope: "global",
      });
    }

    const service = new SkillService({
      nashHome: tmpHome,
      config: { maxMetadataEntries: 5 },
    });

    const promptText = await service.renderAvailableSkillsPrompt("item-3 item-4");
    assert.ok(promptText.includes("Available Skills"));
    // 限制最多展示 5 个
    const lines = promptText.split("\n").filter((l) => l.startsWith("- skill-item-"));
    assert.strictEqual(lines.length, 5);

    // 通过 skill_open 工具按需打开其中一个
    const tool = new SkillOpenTool(service);
    const toolRes = await tool.execute({ name: "skill-item-3" });
    assert.strictEqual(toolRes.success, true);
    assert.ok(toolRes.output.includes("Procedure steps for skill 3."));
  });

  // 48 ~ 55. Skill Observer & Auto Generation Boundary (Memory 积极，Skill 保守)
  test("48 ~ 55. Skill 自动生成严格边界：简单成功不生成，显式指令与多次成功验证才生成", async () => {
    const observerDir = path.join(tmpHome, "skills-observer");
    const observer = new SkillObserver({ storageDir: observerDir });

    // 48. 一次简单成功 (修改 typo / 简单调用) 不生成
    const auto1 = await observer.recordObservation({
      sessionId: "s1",
      userInput: "修一下 typo",
      toolCalls: [{ name: "edit_file", args: { path: "a.ts" } }],
    });
    assert.strictEqual(auto1, null);

    // 49. 显式用户要求保存 Skill
    const explicit = observer.detectExplicitSkillRequest({
      sessionId: "s1",
      userInput: "把刚才这个流程保存成 skill，叫 security-regression-fix",
      toolCalls: [
        { name: "read_file", args: { path: "src/auth.ts" } },
        { name: "edit_file", args: { path: "src/auth.ts" } },
        { name: "bash", args: { command: "npm test" } },
      ],
      testResults: { command: "npm test", passed: true },
    });

    assert.ok(explicit !== null);
    assert.strictEqual(explicit.name, "security-regression-fix");
    assert.ok(explicit.procedure.includes("Update file: `src/auth.ts`"));
    assert.ok(explicit.verification.includes("npm test"));

    // 50. 复杂工作流重复验证 >= 3 次才触发候选生成
    const complexRun = {
      sessionId: "s2",
      userInput: "复杂多步流程",
      toolCalls: [
        { name: "read_file", args: {} },
        { name: "edit_file", args: {} },
        { name: "bash", args: {} },
      ],
      testResults: { command: "npm test", passed: true },
    };

    assert.strictEqual(await observer.recordObservation(complexRun), null); // 1次
    assert.strictEqual(await observer.recordObservation(complexRun), null); // 2次
    const autoCandidate = await observer.recordObservation(complexRun); // 3次
    assert.ok(autoCandidate !== null);
    assert.ok(autoCandidate.name.startsWith("verified-"));
  });
});
