import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateProjectId,
  normalizeProjectRoot,
  resolveProjectContext,
  ProjectStore,
} from "../src/project/index.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { LocalSpillStore } from "../src/context/spill/local-spill-store.js";
import { ContextManager } from "../src/context/context-manager.js";

describe("Project Namespace & Storage Isolation Subsystem", () => {
  let tempDir: string;
  let nashHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-proj-test-"));
    nashHome = path.join(tempDir, ".nash");
  });

  afterEach(async () => {
    if (fsSync.existsSync(tempDir)) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("1. 相同 project root 得到相同 projectId", () => {
    const dirA = path.join(tempDir, "project-a");
    fsSync.mkdirSync(dirA, { recursive: true });

    const id1 = generateProjectId(dirA);
    const id2 = generateProjectId(dirA);

    assert.strictEqual(id1, id2);
    assert.strictEqual(id1.length, 16);
    assert.match(id1, /^[0-9a-f]{16}$/);
  });

  it("2. 不同 project root 得到不同 projectId", () => {
    const dirA = path.join(tempDir, "project-a");
    const dirB = path.join(tempDir, "project-b");
    fsSync.mkdirSync(dirA, { recursive: true });
    fsSync.mkdirSync(dirB, { recursive: true });

    const idA = generateProjectId(dirA);
    const idB = generateProjectId(dirB);

    assert.notStrictEqual(idA, idB);
  });

  it("3. symlink / realpath 规范化正确", async () => {
    const realDir = path.join(tempDir, "real-project");
    const symlinkDir = path.join(tempDir, "symlink-project");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, symlinkDir, "dir");

    const idReal = generateProjectId(realDir);
    const idSymlink = generateProjectId(symlinkDir);

    assert.strictEqual(idSymlink, idReal);
  });

  it("4. metadata.json 正确生成", async () => {
    const projectDir = path.join(tempDir, "my-app");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });

    assert.ok(fsSync.existsSync(ctx.metadataPath));
    const meta = await ctx.getMetadata();

    assert.strictEqual(meta.projectId, ctx.projectId);
    assert.strictEqual(meta.projectRoot, ctx.projectRoot);
    assert.ok(meta.createdAt);
    assert.ok(meta.lastUsedAt);
  });

  it("5. lastUsedAt 更新且复用相同 projectId", async () => {
    const projectDir = path.join(tempDir, "my-app");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx1 = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });
    const meta1 = await ctx1.getMetadata();

    // 稍微等待 20ms
    await new Promise((r) => setTimeout(r, 20));

    const ctx2 = await resolveProjectContext({
      projectRoot: projectDir,
      nashHome,
    });
    const meta2 = await ctx2.getMetadata();

    assert.strictEqual(ctx1.projectId, ctx2.projectId);
    assert.strictEqual(meta1.createdAt, meta2.createdAt);
    assert.ok(new Date(meta2.lastUsedAt).getTime() >= new Date(meta1.lastUsedAt).getTime());
  });

  it("6. Session 写入当前 project namespace", async () => {
    const projectDir = path.join(tempDir, "proj-1");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const sessionStore = new LocalSessionStore({
      sessionId: "session-123",
      projectContext: ctx,
    });

    await sessionStore.appendUserMessage("Hello from Project 1");

    const expectedFile = path.join(ctx.sessionsDir, "session-123", "session.jsonl");
    assert.ok(fsSync.existsSync(expectedFile));

    const records = await sessionStore.getRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0]?.type, "user");
  });

  it("7. Spill 写入当前 project namespace", async () => {
    const projectDir = path.join(tempDir, "proj-1");
    await fs.mkdir(projectDir, { recursive: true });

    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });
    const spillStore = new LocalSpillStore({ projectContext: ctx });

    const spillRef = await spillStore.save("large output content", {
      sessionId: "session-123",
      toolName: "bash",
    });

    const expectedTxt = path.join(
      ctx.spillDir,
      "session-123",
      `${spillRef.id}.txt`
    );
    const expectedMeta = path.join(
      ctx.spillDir,
      "session-123",
      `${spillRef.id}.meta.json`
    );

    assert.ok(fsSync.existsSync(expectedTxt));
    assert.ok(fsSync.existsSync(expectedMeta));

    const readBack = await spillStore.read(spillRef.id);
    assert.strictEqual(readBack.content, "large output content");
  });

  it("8. 不同项目 Session 完全隔离", async () => {
    const projADir = path.join(tempDir, "proj-a");
    const projBDir = path.join(tempDir, "proj-b");
    await fs.mkdir(projADir, { recursive: true });
    await fs.mkdir(projBDir, { recursive: true });

    const ctxA = await resolveProjectContext({ projectRoot: projADir, nashHome });
    const ctxB = await resolveProjectContext({ projectRoot: projBDir, nashHome });

    const storeA = new LocalSessionStore({
      sessionId: "sess-common",
      projectContext: ctxA,
    });
    const storeB = new LocalSessionStore({
      sessionId: "sess-common",
      projectContext: ctxB,
    });

    await storeA.appendUserMessage("Message in Project A");
    await storeB.appendUserMessage("Message in Project B");

    const recordsA = await storeA.getRecords();
    const recordsB = await storeB.getRecords();

    assert.strictEqual((recordsA[0] as any)?.content, "Message in Project A");
    assert.strictEqual((recordsB[0] as any)?.content, "Message in Project B");

    const summariesA = await LocalSessionStore.listSessionSummaries(ctxA);
    const summariesB = await LocalSessionStore.listSessionSummaries(ctxB);

    assert.strictEqual(summariesA.length, 1);
    assert.strictEqual(summariesB.length, 1);
    assert.strictEqual(summariesA[0]?.firstUserPrompt, "Message in Project A");
    assert.strictEqual(summariesB[0]?.firstUserPrompt, "Message in Project B");
  });

  it("9. 不同项目 Spill 完全隔离", async () => {
    const projADir = path.join(tempDir, "proj-a");
    const projBDir = path.join(tempDir, "proj-b");
    await fs.mkdir(projADir, { recursive: true });
    await fs.mkdir(projBDir, { recursive: true });

    const ctxA = await resolveProjectContext({ projectRoot: projADir, nashHome });
    const ctxB = await resolveProjectContext({ projectRoot: projBDir, nashHome });

    const spillA = new LocalSpillStore({ projectContext: ctxA });
    const spillB = new LocalSpillStore({ projectContext: ctxB });

    const refA = await spillA.save("Content A", {
      sessionId: "s1",
      artifactId: "art-fixed",
    });

    // 在 Project B 中读取不应该存在
    await assert.rejects(
      async () => await spillB.read("art-fixed"),
      /ArtifactNotFound/
    );

    // 在 Project A 中读取正常
    const readA = await spillA.read("art-fixed");
    assert.strictEqual(readA.content, "Content A");
  });

  it("10. legacy ~/.nash/context 数据不被删除且能被探测", async () => {
    const legacyDir = path.join(nashHome, "context", "sessions", "legacy-session-999");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyDir, "session.jsonl"),
      JSON.stringify({ type: "user", content: "legacy prompt", createdAt: Date.now() }) + "\n"
    );

    // 启动新的 project namespace
    const projectDir = path.join(tempDir, "new-project");
    await fs.mkdir(projectDir, { recursive: true });
    const ctx = await resolveProjectContext({ projectRoot: projectDir, nashHome });

    const detected = await LocalSessionStore.detectLegacySessions(nashHome);
    assert.strictEqual(detected.length, 1);
    assert.strictEqual(detected[0], "legacy-session-999");

    // 确认旧文件完好无损
    assert.ok(fsSync.existsSync(path.join(legacyDir, "session.jsonl")));
  });
});
