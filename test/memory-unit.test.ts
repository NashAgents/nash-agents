import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  MemoryStore,
  MemoryRetriever,
  MemoryWriter,
  MemoryService,
  getGlobalMemoryDir,
  getProjectMemoryDir,
  assertSafeMemoryPath,
  containsSecret,
  sanitizeSecretText,
  type MemoryEntry,
} from "../src/memory/index.js";
import { MemoryDistiller } from "../src/learning/memory-distiller.js";
import { resolveProjectContext } from "../src/project/project-context.js";

describe("Memory Unit & Retrieval & Learning Tests", () => {
  let tmpHome: string;
  let tmpRepo: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "nash-test-home-"));
    tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "nash-test-repo-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(tmpRepo, { recursive: true, force: true });
  });

  // 1. project memory path 正确
  test("1. project memory path 应正确解析至 ~/.nash/projects/<dir>/memory", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });
    const memDir = getProjectMemoryDir(projectCtx, tmpHome);
    assert.match(memDir, /projects[/\\].+__\w+[/\\](Shared[/\\])?memory/);
    assert.ok(memDir.startsWith(tmpHome));
  });

  // 2. global memory path 正确
  test("2. global memory path 应正确解析至 ~/.nash/memory", () => {
    const memDir = getGlobalMemoryDir(tmpHome);
    assert.strictEqual(memDir, path.join(tmpHome, "memory"));
  });

  // 3. canonical project path 映射同一个 memory dir
  test("3. 软链接路径与真实物理路径应映射至同一个 Memory 目录", async () => {
    const realDir = path.join(tmpRepo, "real-project");
    const linkDir = path.join(tmpRepo, "link-project");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir, "dir");

    const ctx1 = await resolveProjectContext({ projectRoot: realDir, nashHome: tmpHome });
    const ctx2 = await resolveProjectContext({ projectRoot: linkDir, nashHome: tmpHome });

    assert.strictEqual(ctx1.projectId, ctx2.projectId);
    assert.strictEqual(ctx1.memoryDir, ctx2.memoryDir);
  });

  // 4. create memory
  test("4. create memory 应同时正确写入 index.json 与人类可读 MEMORY.md", async () => {
    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    const result = await writer.addMemory({
      content: "Linux sandbox primary backend is Bubblewrap.",
      kind: "architecture",
      source: "verified-runtime",
    });

    assert.strictEqual(result.action, "created");
    assert.ok(result.entry.id.startsWith("mem-"));

    const entries = await store.loadEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].content, "Linux sandbox primary backend is Bubblewrap.");

    // 检查 MEMORY.md 存在且包含该条目
    const mdPath = path.join(storeDir, "MEMORY.md");
    assert.ok(fsSync.existsSync(mdPath));
    const mdContent = await fs.readFile(mdPath, "utf-8");
    assert.ok(mdContent.includes("Linux sandbox primary backend is Bubblewrap."));
    assert.ok(mdContent.includes("Architecture & System Design"));
  });

  // 5 & 6. update existing equivalent memory & reinforcement count
  test("5 & 6. 同义或重复知识应强化已有条目并增加 reinforcementCount，而不产生重复条目", async () => {
    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    await writer.addMemory({
      content: "Linux sandbox primary backend is Bubblewrap.",
      kind: "architecture",
      source: "verified-runtime",
      confidence: 0.8,
    });

    // 再次写入高度相似知识
    const res2 = await writer.addMemory({
      content: "Linux sandbox primary backend is Bubblewrap",
      kind: "architecture",
      source: "verified-runtime",
      confidence: 0.9,
    });

    assert.strictEqual(res2.action, "reinforced");
    const entries = await store.loadEntries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].reinforcementCount, 2);
    assert.strictEqual(entries[0].confidence, 0.9);
  });

  // 7 & 8. supersede conflicting memory & deprecated filtering
  test("7 & 8. 冲突新事实应废弃旧事实 (supersede)，且 deprecated 事实不被活跃检索召回", async () => {
    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    // 初始旧知识：Node 22
    const res1 = await writer.addMemory({
      content: "Node.js version is 22.0.",
      kind: "environment",
      source: "agent-learned",
    });

    // 用户显式纠正：Node 24
    const res2 = await writer.addMemory({
      content: "Node.js version is 24.14.",
      kind: "environment",
      source: "user-explicit",
    });

    assert.strictEqual(res2.action, "superseded");
    assert.deepStrictEqual(res2.supersededIds, [res1.entry.id]);

    const all = await store.loadEntries();
    assert.strictEqual(all.length, 2);

    const oldEntry = all.find((e) => e.id === res1.entry.id);
    const newEntry = all.find((e) => e.id === res2.entry.id);
    assert.strictEqual(oldEntry?.deprecated, true);
    assert.strictEqual(newEntry?.deprecated, undefined);

    // 检索验证：只召回未废弃的 Node 24.14
    const retriever = new MemoryRetriever();
    const retrieved = retriever.retrieve(all, { query: "Node.js version" });
    assert.strictEqual(retrieved.entries.length, 1);
    assert.strictEqual(retrieved.entries[0].content, "Node.js version is 24.14.");
  });

  // 9. project overrides global
  test("9. 作用域评分：Project Memory 优先级高于 Global Memory", async () => {
    const retriever = new MemoryRetriever();
    const candidates: MemoryEntry[] = [
      {
        id: "global-1",
        scope: "global",
        kind: "preference",
        content: "Package manager is npm.",
        confidence: 0.8,
        source: "agent-learned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 1,
      },
      {
        id: "project-1",
        scope: "project",
        kind: "preference",
        content: "Package manager is pnpm.",
        confidence: 0.8,
        source: "agent-learned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 1,
      },
    ];

    const result = retriever.retrieve(candidates, { query: "package manager", maxEntries: 1 });
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].id, "project-1");
  });

  // 10. user explicit overrides agent learned
  test("10. 来源优先级：user-explicit 优先于 agent-learned", async () => {
    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    await writer.addMemory({
      content: "Sandbox backend is Landlock.",
      source: "agent-learned",
      kind: "architecture",
    });

    const res = await writer.addMemory({
      content: "Sandbox backend is Bubblewrap.",
      source: "user-explicit",
      kind: "architecture",
    });

    assert.strictEqual(res.action, "superseded");
    const entries = await store.loadEntries();
    const active = entries.filter((e) => !e.deprecated);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].content, "Sandbox backend is Bubblewrap.");
    assert.strictEqual(active[0].source, "user-explicit");
  });

  // 11. secret 不持久化
  test("11. Secret 防护：私密 Token 和密码必须被自动拦截净化", async () => {
    const secretText = 'DEEPSEEK_API_KEY = "sk-test-2dfacb4231b34bb49d210787def" and password: "mysecretpassword"';
    assert.ok(containsSecret(secretText));
    const sanitized = sanitizeSecretText(secretText);
    assert.ok(!sanitized.includes("sk-test-2dfacb4231b34bb49d210787def"));
    assert.ok(!sanitized.includes("mysecretpassword"));
    assert.ok(sanitized.includes("[REDACTED_SECRET]"));

    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    const res = await writer.addMemory({
      content: `Use api_key = "sk-test-2dfacb4231b34bb49d210787def" for deployment.`,
    });

    assert.ok(!res.entry.content.includes("sk-test-2dfacb4231b34bb49d210787def"));
    assert.ok(res.entry.content.includes("[REDACTED_SECRET]"));
  });

  // 12. path traversal 防御
  test("12. Path Traversal 防御：越界访问必须被拦截", () => {
    const baseDir = path.join(tmpHome, "memory");
    assert.throws(() => {
      assertSafeMemoryPath(baseDir, path.join(baseDir, "../../etc/passwd"));
    }, /超出合法基准目录/);
  });

  // 13. concurrent write 不丢数据
  test("13. 并发写入：多个并发写入任务必须安全串行化合并，不丢失数据", async () => {
    const storeDir = path.join(tmpHome, "projects", "demo", "memory");
    const store = new MemoryStore({ storageDir: storeDir, scope: "project" });
    const writer = new MemoryWriter(store);

    // 10 个并发写入
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writer.addMemory({
          content: `Distinct independent fact item #${i}`,
          kind: "fact",
          source: "agent-learned",
        })
      )
    );

    const entries = await store.loadEntries();
    assert.strictEqual(entries.length, 10);
  });

  // 14 & 15. disabled mode
  test("14 & 15. disabled 模式下不读取也不写入 Memory", async () => {
    const projectCtx = await resolveProjectContext({
      projectRoot: tmpRepo,
      nashHome: tmpHome,
    });
    const service = new MemoryService({
      projectContext: projectCtx,
      nashHome: tmpHome,
      config: { enabled: false },
    });

    const rememberRes = await service.remember({
      content: "This should not be saved",
    });
    assert.strictEqual(rememberRes, null);

    const retrieveRes = await service.retrieveRelevant("test");
    assert.strictEqual(retrieveRes.entries.length, 0);
  });

  // 16 ~ 22. Retrieval query, budget & scoring
  test("16 ~ 22. Retrieval 精准召回、不相关过滤与 Token / 条目预算控制", async () => {
    const retriever = new MemoryRetriever();
    const candidates: MemoryEntry[] = [
      {
        id: "m-sandbox",
        scope: "project",
        kind: "architecture",
        content: "Linux sandbox primary backend is Bubblewrap with Landlock fallback.",
        confidence: 0.9,
        source: "verified-runtime",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 3,
      },
      {
        id: "m-node",
        scope: "project",
        kind: "environment",
        content: "Project requires Node.js >=24.14.0.",
        confidence: 0.95,
        source: "user-explicit",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 2,
      },
      {
        id: "m-frontend",
        scope: "global",
        kind: "preference",
        content: "User prefers React with Tailwind CSS on web frontends.",
        confidence: 0.7,
        source: "agent-learned",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        reinforcementCount: 1,
      },
    ];

    // 查询 Linux Sandbox
    const res1 = retriever.retrieve(candidates, { query: "修 Linux Sandbox 沙箱问题" });
    assert.ok(res1.entries.some((e) => e.id === "m-sandbox"));
    // 不相关的前端偏好不应该被排在前面
    assert.strictEqual(res1.entries[0].id, "m-sandbox");

    // 条目预算限制
    const res2 = retriever.retrieve(candidates, { query: "project", maxEntries: 1 });
    assert.strictEqual(res2.entries.length, 1);

    // Token 预算限制
    const res3 = retriever.retrieve(candidates, { query: "sandbox node frontend", maxTokens: 10 });
    assert.ok(res3.entries.length <= 1);
  });

  // 23 ~ 30. Memory Distiller Learning Tests
  test("23 ~ 30. MemoryDistiller 自动提炼规则与严格边界测试", () => {
    const distiller = new MemoryDistiller();

    // 23. 用户显式 remember
    const res1 = distiller.distill({
      sessionId: "s1",
      userInput: "请记住这个项目必须使用 Node 24.14。",
    });
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res1[0].source, "user-explicit");
    assert.strictEqual(res1[0].confidence, 1.0);
    assert.ok(res1[0].content.includes("Node 24.14"));

    // 24. 用户纠正
    const res2 = distiller.distill({
      sessionId: "s1",
      userInput: "不对，这个项目应该使用 pnpm 而不是 npm。",
    });
    assert.strictEqual(res2.length, 1);
    assert.strictEqual(res2[0].source, "user-correction");
    assert.strictEqual(res2[0].confidence, 0.95);

    // 25. 回归测试通过
    const res3 = distiller.distill({
      sessionId: "s1",
      userInput: "运行测试",
      testResults: {
        command: "npm test",
        passed: true,
        redToGreen: true,
      },
    });
    assert.strictEqual(res3.length, 1);
    assert.strictEqual(res3[0].kind, "lesson");

    // 26. 包含猜测词的不写入
    const res4 = distiller.distill({
      sessionId: "s1",
      userInput: "记住这个模块可能存在性能问题。",
    });
    assert.strictEqual(res4.length, 0);

    // 27. 临时 PID / 进度不写入
    const res5 = distiller.distill({
      sessionId: "s1",
      userInput: "记住当前进程 PID: 12345。",
    });
    assert.strictEqual(res5.length, 0);

    // 28. 普通问候不触发
    const res6 = distiller.distill({
      sessionId: "s1",
      userInput: "你好呀",
    });
    assert.strictEqual(res6.length, 0);

    // 29. Run 失败时不提炼
    const res7 = distiller.distill({
      sessionId: "s1",
      userInput: "记住成功解决问题",
      isError: true,
    });
    assert.strictEqual(res7.length, 0);

    // 30. 扩展规则：成功识别“沉淀一下记忆，以后称呼我为哥哥，你是17岁女高中生”
    const res8 = distiller.distill({
      sessionId: "s1",
      userInput: "沉淀一下记忆，以后称呼我为哥哥，你是17岁女高中生",
    });
    assert.strictEqual(res8.length, 1);
    assert.strictEqual(res8[0]?.kind, "preference");
    assert.strictEqual(res8[0]?.content, "以后称呼我为哥哥，你是17岁女高中生");
    assert.ok(res8[0]?.tags?.includes("persona"));

    // 31. 扩展规则：成功识别单独的人设偏好
    const res9 = distiller.distill({
      sessionId: "s1",
      userInput: "以后称呼我为哥哥",
    });
    assert.strictEqual(res9.length, 1);
    assert.strictEqual(res9[0]?.kind, "preference");
  });

  // 32. 自动兼容并恢复外部散落的 ~/.nash/memory.md
  test("32. loadEntries 应能自动从散落的 ~/.nash/memory.md 导入记忆并持久化为规范 index.json", async () => {
    // 模拟用户或老 Agent 在 ~/.nash/memory.md 写下文件
    const externalMemoryMd = path.join(tmpHome, "memory.md");
    await fs.writeFile(
      externalMemoryMd,
      "# 用户偏好与交互人设\n\n- 用户称谓：哥哥\n- 助手人设：17岁女高中生（聪明、贴心）\n",
      "utf-8"
    );

    const store = new MemoryStore({
      storageDir: path.join(tmpHome, "memory"),
      scope: "global",
    });

    // 首次加载，index.json 不存在，应自动探测上级 memory.md 并完成导入
    const entries = await store.loadEntries();
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].kind, "preference");
    assert.strictEqual(entries[0].content, "用户称谓：哥哥");
    assert.strictEqual(entries[1].content, "助手人设：17岁女高中生（聪明、贴心）");

    // 校验规范文件已自动生成
    assert.ok(fsSync.existsSync(path.join(tmpHome, "memory", "index.json")));
    assert.ok(fsSync.existsSync(path.join(tmpHome, "memory", "MEMORY.md")));
  });

  // 33. 渐进式记忆加载：即使搜索“你好”，偏好与人设 (preference) 也绝不被硬过滤
  test("33. 偏好与人设在问候语或无关键词交集时绝不被丢弃，且 renderProgressiveMemoryPrompt 呈现两层架构", async () => {
    const memoryService = new MemoryService({
      nashHome: tmpHome,
    });

    await memoryService.remember({
      content: "用户称谓：哥哥，助手人设：17岁女高中生",
      kind: "preference",
      scope: "global",
      tags: ["persona", "invariant"],
    });

    await memoryService.remember({
      content: "Seatbelt profile requires absolute path resolution.",
      kind: "architecture",
      scope: "global",
    });

    // 1. 普通问候语查询，偏好由于免除过滤仍可被召回
    const retrieved = await memoryService.retrieveRelevant("你好");
    assert.ok(retrieved.entries.some((e) => e.kind === "preference"));

    // 2. 渐进式提示词生成验证
    const progressivePrompt = await memoryService.renderProgressiveMemoryPrompt("你好");
    assert.ok(progressivePrompt.includes("User Persona & Core Preferences"));
    assert.ok(progressivePrompt.includes("用户称谓：哥哥，助手人设：17岁女高中生"));
    assert.ok(progressivePrompt.includes("Persistent Memory Index"));
  });
});
