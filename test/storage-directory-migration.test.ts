import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateProjectId,
  getProjectDisplayName,
  generateProjectDirectoryName,
  assertSafeProjectDir,
  normalizeProjectRoot,
  resolveProjectContext,
  ProjectStore,
} from "../src/project/index.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { SpillGc } from "../src/context/spill/spill-gc.js";
import { ContextManager } from "../src/context/context-manager.js";
import { migrateLegacySessions } from "../src/context/session/legacy-migration.js";

describe("Storage Directory Presentation & Legacy Convergence Subsystem", () => {
  let tempDir: string;
  let nashHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-storage-test-"));
    nashHome = path.join(tempDir, ".nash");
  });

  afterEach(async () => {
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // 1. projectRoot basename 正确生成 displayName
  it("1. projectRoot basename 正确生成 displayName", () => {
    const p1 = "/Users/test/Documents/project/nash-agents";
    const name1 = getProjectDisplayName(p1);
    assert.strictEqual(name1, "nash-agents");

    const p2 = "/var/repos/my-awesome-service";
    const name2 = getProjectDisplayName(p2);
    assert.strictEqual(name2, "my-awesome-service");
  });

  // 2. readable directoryName: <project-name>__<short-project-id>
  it("2. readable directoryName 格式为 <name>__<8位短Hash>", () => {
    const projectPath = "/Users/test/Documents/project/nash-agents";
    const pid = generateProjectId(projectPath);
    const dirName = generateProjectDirectoryName(projectPath, pid);

    assert.strictEqual(dirName, `nash-agents__${pid.slice(0, 8)}`);
    assert.strictEqual(pid.slice(0, 8).length, 8);
  });

  // 3. projectId 算法保持不变
  it("3. projectId 算法保持不变 (16位SHA-256截取)", () => {
    const projectPath = "/Users/test/Documents/project/nash-agents";
    const pid1 = generateProjectId(projectPath);
    const pid2 = generateProjectId(projectPath);

    assert.strictEqual(pid1, pid2);
    assert.strictEqual(pid1.length, 16);
    assert.match(pid1, /^[0-9a-f]{16}$/);
  });

  // 4. 两个同 basename 不同路径项目得到不同目录与不同 projectId
  it("4. 两个同 basename 不同路径项目得到不同目录与不同 projectId", () => {
    const pathA = path.join(tempDir, "work", "nash-agents");
    const pathB = path.join(tempDir, "backup", "nash-agents");
    fsSync.mkdirSync(pathA, { recursive: true });
    fsSync.mkdirSync(pathB, { recursive: true });

    const idA = generateProjectId(pathA);
    const idB = generateProjectId(pathB);
    const dirA = generateProjectDirectoryName(pathA, idA);
    const dirB = generateProjectDirectoryName(pathB, idB);

    assert.notStrictEqual(idA, idB);
    assert.notStrictEqual(dirA, dirB);
    assert.ok(dirA.startsWith("nash-agents__"));
    assert.ok(dirB.startsWith("nash-agents__"));
  });

  // 5. Unicode 项目名可用 (如“地铁智能助手__abcd1234”)
  it("5. Unicode 项目名完整保留可读字符", () => {
    const unicodePath = path.join(tempDir, "地铁智能助手");
    fsSync.mkdirSync(unicodePath, { recursive: true });

    const name = getProjectDisplayName(unicodePath);
    assert.strictEqual(name, "地铁智能助手");

    const pid = generateProjectId(unicodePath);
    const dirName = generateProjectDirectoryName(unicodePath, pid);
    assert.strictEqual(dirName, `地铁智能助手__${pid.slice(0, 8)}`);
  });

  // 6. 特殊字符 sanitize
  it("6. 特殊字符与控制字符被安全 sanitize", () => {
    const weirdPath = "/Users/test/my project :*?\"<>| test";
    const name = getProjectDisplayName(weirdPath);
    assert.strictEqual(name, "my_project_test");
    assert.doesNotMatch(name, /[:*?"<>|\s]/);

    const rootFallback = getProjectDisplayName("/");
    assert.strictEqual(rootFallback, "project");
  });

  // 7. path traversal 防护
  it("7. assertSafeProjectDir 拦截路径穿越", () => {
    const projectsRoot = path.join(nashHome, "projects");
    const safeDir = path.join(projectsRoot, "my-app__12345678");
    const dangerousDir = path.join(projectsRoot, "..", "..", "etc");

    assert.doesNotThrow(() => assertSafeProjectDir(projectsRoot, safeDir));
    assert.throws(
      () => assertSafeProjectDir(projectsRoot, dangerousDir),
      /PathTraversalSecurityError/
    );
  });

  // 8. symlink canonical realpath 保证身份一致
  it("8. 符号链接与真实路径生成相同的 projectId 与 directoryName", async () => {
    const realDir = path.join(tempDir, "real-app");
    const symlinkDir = path.join(tempDir, "symlink-app");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, symlinkDir, "dir");

    const realId = generateProjectId(realDir);
    const symId = generateProjectId(symlinkDir);
    assert.strictEqual(symId, realId);

    const realDirName = generateProjectDirectoryName(realDir, realId);
    const symDirName = generateProjectDirectoryName(symlinkDir, symId);
    assert.strictEqual(symDirName, realDirName);
  });

  // 9. 新项目自动创建到可读目录
  it("9. 新项目初始化创建至可读格式目录", async () => {
    const projectDir = path.join(tempDir, "awesome-project");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });

    assert.ok(ctx.directoryName.startsWith("awesome-project__"));
    assert.ok(fsSync.existsSync(ctx.projectDir));
    assert.ok(fsSync.existsSync(ctx.sessionsDir));
    assert.ok(fsSync.existsSync(ctx.spillDir));
    assert.ok(fsSync.existsSync(ctx.metadataPath));

    const meta = await ctx.getMetadata();
    assert.strictEqual(meta.projectId, ctx.projectId);
    assert.strictEqual(meta.displayName, "awesome-project");
    assert.strictEqual(meta.directoryName, ctx.directoryName);
  });

  // 10-14. 旧纯 Hash project dir 自动安全幂等迁移
  it("10-14. 旧纯 Hash 目录自动迁移、数据保留、元数据更新且幂等", async () => {
    const projectDir = path.join(tempDir, "legacy-hash-app");
    await fs.mkdir(projectDir, { recursive: true });

    const canonicalRoot = normalizeProjectRoot(projectDir);
    const projectId = generateProjectId(canonicalRoot);

    // 1. 模拟旧版创建的纯 Hash 目录结构
    const oldProjectDir = path.join(nashHome, "projects", projectId);
    const oldSessionsDir = path.join(oldProjectDir, "sessions", "sess-old-001");
    const oldSpillDir = path.join(oldProjectDir, "spill", "sess-old-001");
    await fs.mkdir(oldSessionsDir, { recursive: true });
    await fs.mkdir(oldSpillDir, { recursive: true });

    // 写入旧 metadata
    const oldMeta = {
      projectId,
      projectRoot: canonicalRoot,
      createdAt: "2026-09-20T00:00:00.000Z",
      lastUsedAt: "2026-09-20T00:00:00.000Z",
    };
    await fs.writeFile(
      path.join(oldProjectDir, "metadata.json"),
      JSON.stringify(oldMeta, null, 2),
      "utf-8"
    );

    // 写入旧 session
    const oldSessionLine =
      JSON.stringify({
        type: "user",
        id: "rec-1",
        content: "Important old history message",
        createdAt: 1790000000000,
      }) + "\n";
    await fs.writeFile(
      path.join(oldSessionsDir, "session.jsonl"),
      oldSessionLine,
      "utf-8"
    );

    // 写入旧 spill
    await fs.writeFile(
      path.join(oldSpillDir, "art-1.txt"),
      "Old spilled content",
      "utf-8"
    );
    await fs.writeFile(
      path.join(oldSpillDir, "art-1.meta.json"),
      JSON.stringify({ id: "art-1", chars: 19 }),
      "utf-8"
    );

    // 2. 执行 resolveProjectContext 触发自动迁移
    const ctx = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });

    // 验证新目录生成
    assert.ok(ctx.directoryName.startsWith("legacy-hash-app__"));
    assert.strictEqual(
      ctx.projectDir,
      path.join(nashHome, "projects", `legacy-hash-app__${projectId.slice(0, 8)}`)
    );
    assert.ok(fsSync.existsSync(ctx.projectDir));

    // 验证旧纯 Hash 目录已被重命名/移走
    assert.strictEqual(fsSync.existsSync(oldProjectDir), false);

    // 验证历史 session 完整保留
    const newSessionFile = path.join(
      ctx.sessionsDir,
      "sess-old-001",
      "session.jsonl"
    );
    assert.ok(fsSync.existsSync(newSessionFile));
    const sessionContent = await fs.readFile(newSessionFile, "utf-8");
    assert.ok(sessionContent.includes("Important old history message"));

    // 验证历史 spill 完整保留
    const newSpillTxt = path.join(ctx.spillDir, "sess-old-001", "art-1.txt");
    assert.ok(fsSync.existsSync(newSpillTxt));
    const spillContent = await fs.readFile(newSpillTxt, "utf-8");
    assert.strictEqual(spillContent, "Old spilled content");

    // 验证 metadata 正确升级
    const meta = await ctx.getMetadata();
    assert.strictEqual(meta.projectId, projectId);
    assert.strictEqual(meta.displayName, "legacy-hash-app");
    assert.strictEqual(meta.directoryName, ctx.directoryName);
    assert.strictEqual(meta.createdAt, "2026-09-20T00:00:00.000Z");

    // 3. 验证幂等性：再次调用 resolveProjectContext 不报错且内容一致
    const ctx2 = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });
    assert.strictEqual(ctx2.projectDir, ctx.projectDir);
    assert.ok(fsSync.existsSync(newSessionFile));
  });

  // 15. 目标目录冲突不覆盖
  it("15. 目标可读目录若发生 hash 碰撞，自动延长后缀防止覆盖已有项目", async () => {
    const projectDir = path.join(tempDir, "conflict-app");
    await fs.mkdir(projectDir, { recursive: true });

    const canonicalRoot = normalizeProjectRoot(projectDir);
    const projectId = generateProjectId(canonicalRoot);
    const shortHash = projectId.slice(0, 8);
    const desiredDirName = `conflict-app__${shortHash}`;

    // 预先制造一个具有相同短名称但不同 projectId 的假项目
    const collisionDir = path.join(nashHome, "projects", desiredDirName);
    await fs.mkdir(collisionDir, { recursive: true });
    await fs.writeFile(
      path.join(collisionDir, "metadata.json"),
      JSON.stringify({
        projectId: "other_different_id_999",
        projectRoot: "/other/path",
      }),
      "utf-8"
    );

    // 启动当前项目
    const ctx = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });

    // 验证：回退到了 16 位完整哈希目录，没有覆盖 collisionDir
    assert.strictEqual(ctx.directoryName, `conflict-app__${projectId}`);
    assert.ok(fsSync.existsSync(ctx.projectDir));

    // 验证原有的碰撞目录未被损坏
    const otherMeta = JSON.parse(
      await fs.readFile(path.join(collisionDir, "metadata.json"), "utf-8")
    );
    assert.strictEqual(otherMeta.projectId, "other_different_id_999");
  });

  // 16. /resume 能读取迁移后的 Session
  it("16. LocalSessionStore 能够发现并恢复迁移后的 Session", async () => {
    const projectDir = path.join(tempDir, "resume-app");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const store = new LocalSessionStore({
      sessionId: "resumable-session-123",
      projectContext: ctx,
    });
    await store.appendUserMessage("Message to be resumed");

    const summaries = await LocalSessionStore.listSessionSummaries(ctx);
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0]?.sessionId, "resumable-session-123");
    assert.strictEqual(summaries[0]?.firstUserPrompt, "Message to be resumed");
  });

  // 17-18. 新 Session / Spill 不再写入 ~/.nash/context
  it("17-18. 新建 Session / Spill 不再写入 ~/.nash/context", async () => {
    const projectDir = path.join(tempDir, "clean-app");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const contextManager = new ContextManager({ projectContext: ctx });

    await contextManager.recordUserMessage("Clean user message");
    await contextManager.processToolResult("bash", "call_1", {
      output: "Result content",
      success: true,
    });

    // 确认写入了 projectDir
    assert.ok(
      fsSync.existsSync(
        path.join(ctx.sessionsDir, contextManager.sessionId, "session.jsonl")
      )
    );

    // 确认 ~/.nash/context 下没有产生任何文件
    const legacyContextDir = path.join(nashHome, "context");
    if (fsSync.existsSync(legacyContextDir)) {
      const entries = await fs.readdir(legacyContextDir);
      assert.strictEqual(entries.length, 0);
    }
  });

  // 19. legacy context 仍可被探测
  it("19. Legacy 全局 Session 能被只读探测", async () => {
    const legacySessionDir = path.join(
      nashHome,
      "context",
      "sessions",
      "legacy-sess-007"
    );
    await fs.mkdir(legacySessionDir, { recursive: true });
    await fs.writeFile(
      path.join(legacySessionDir, "session.jsonl"),
      JSON.stringify({ type: "user", content: "legacy content", createdAt: Date.now() }) + "\n"
    );

    const detected = await LocalSessionStore.detectLegacySessions(nashHome);
    assert.strictEqual(detected.length, 1);
    assert.strictEqual(detected[0], "legacy-sess-007");

    const summaries = await LocalSessionStore.listLegacySessionSummaries(nashHome);
    assert.strictEqual(summaries.length, 1);
    assert.strictEqual(summaries[0]?.sessionId, "legacy-sess-007");
    assert.strictEqual(summaries[0]?.firstUserPrompt, "legacy content");
  });

  // 20-21. Legacy Session 智能迁移与未识别保留
  it("20-21. migrateLegacySessions: 可识别 projectRoot 的迁移，无法识别的保留", async () => {
    const knownAppDir = path.join(tempDir, "known-app");
    await fs.mkdir(knownAppDir, { recursive: true });

    // 1. 创建一个带有可靠 projectRoot 的 legacy session
    const migratableDir = path.join(
      nashHome,
      "context",
      "sessions",
      "migratable-sess-1"
    );
    await fs.mkdir(migratableDir, { recursive: true });
    await fs.writeFile(
      path.join(migratableDir, "session.jsonl"),
      JSON.stringify({
        type: "user",
        id: "u1",
        content: "Hello in known app",
        createdAt: Date.now(),
        metadata: { projectRoot: knownAppDir },
      }) + "\n"
    );

    // 2. 创建一个没有 projectRoot 的 legacy session
    const unidentifiableDir = path.join(
      nashHome,
      "context",
      "sessions",
      "unidentifiable-sess-2"
    );
    await fs.mkdir(unidentifiableDir, { recursive: true });
    await fs.writeFile(
      path.join(unidentifiableDir, "session.jsonl"),
      JSON.stringify({
        type: "user",
        id: "u2",
        content: "Mystery session",
        createdAt: Date.now(),
      }) + "\n"
    );

    // 3. 执行迁移
    const report = await migrateLegacySessions({ nashHome });

    assert.strictEqual(report.total, 2);
    assert.strictEqual(report.migrated, 1);
    assert.strictEqual(report.skipped, 1);
    assert.strictEqual(report.failed, 0);

    // 验证可识别 session 已经移动到对应 project 下
    const knownCtx = await resolveProjectContext({
      projectRoot: knownAppDir,
      nashHome,
    });
    const migratedFile = path.join(
      knownCtx.sessionsDir,
      "migratable-sess-1",
      "session.jsonl"
    );
    assert.ok(fsSync.existsSync(migratedFile));

    // 验证不可识别 session 仍然保留在 legacy 目录下
    const unidentifiableFile = path.join(
      nashHome,
      "context",
      "sessions",
      "unidentifiable-sess-2",
      "session.jsonl"
    );
    assert.ok(fsSync.existsSync(unidentifiableFile));
  });

  // 22. ProjectStore 支持扫描并查找新格式目录
  it("22. ProjectStore 能够按 projectId 找到新格式目录的项目", async () => {
    const projectDir = path.join(tempDir, "store-app");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const store = new ProjectStore(nashHome);

    const list = await store.listProjects();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0]?.projectId, ctx.projectId);
    assert.strictEqual(list[0]?.displayName, "store-app");

    const found = await store.getProject(ctx.projectId);
    assert.ok(found);
    assert.strictEqual(found?.projectId, ctx.projectId);
  });
});
