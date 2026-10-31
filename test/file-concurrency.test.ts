import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FileSystemAccess,
  createDefaultSandboxPolicy,
  FilesystemAccessDeniedError,
} from "../src/sandbox/index.js";
import {
  FileObservationStore,
  StaleFileVersionError,
  checkScopeOverlap,
  isPathInScope,
} from "../src/filesystem/index.js";
import { WorktreeManager } from "../src/worktree/index.js";
import { EventBus } from "../src/observability/event-bus.js";

describe("Phase F: Multi-Agent File Concurrency & Stale-Version Protection", () => {
  const testDir = path.join(os.tmpdir(), `nash-file-test-${Date.now()}`);
  const targetFile = path.join(testDir, "test-auth.ts");

  before(async () => {
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(targetFile, "export const token = 'initial-v1';", "utf-8");
  });

  after(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. Agent A 读取文件记录哈希，Agent B 外部修改后，Agent A 写入被拒绝 (StaleFileVersionError)", async () => {
    const observationStore = new FileObservationStore();
    const eventBus = new EventBus();
    const emittedEvents: string[] = [];
    eventBus.subscribe("*", (e) => {
      emittedEvents.push(e.type);
    });

    const fsAccessA = new FileSystemAccess({
      workspaceRoot: testDir,
      policy: createDefaultSandboxPolicy(),
      agentId: "agent-A",
      observationStore,
      eventBus,
    });

    // 1. Agent A 读取文件
    const readPath = await fsAccessA.resolveForRead("test-auth.ts");
    assert.equal(readPath, targetFile);

    const initialHash = observationStore.getLastObservation("agent-A", targetFile);
    assert.ok(initialHash);

    // 2. 模拟 Agent B (或外部进程) 修改了 test-auth.ts
    await fs.writeFile(targetFile, "export const token = 'modified-by-B';", "utf-8");

    // 3. Agent A 尝试写入 -> 触发 StaleFileVersionError
    await assert.rejects(
      async () => {
        await fsAccessA.resolveForWrite("test-auth.ts");
      },
      (err: unknown) => {
        assert(err instanceof StaleFileVersionError);
        assert.equal(err.code, "STALE_FILE_VERSION");
        assert.equal(err.lastObservedHash, initialHash);
        return true;
      }
    );

    assert(emittedEvents.includes("file.stale_version"));

    // 4. Agent A 重新读取最新文件
    await fsAccessA.resolveForRead("test-auth.ts");
    const updatedHash = observationStore.getLastObservation("agent-A", targetFile);
    assert.notEqual(updatedHash, initialHash);

    // 5. Agent A 再次写入成功
    const writePath = await fsAccessA.resolveForWrite("test-auth.ts");
    assert.equal(writePath, targetFile);
  });

  it("2. writeScopes 范围约束检查 (在 scope 内放行，在 scope 外拦截)", async () => {
    const fsAccess = new FileSystemAccess({
      workspaceRoot: testDir,
      policy: createDefaultSandboxPolicy(),
      agentId: "agent-scoped",
      writeScopes: ["src/auth/**", "config/*.json"],
    });

    // 在 scope 内允许写入
    const allowed1 = await fsAccess.resolveForWrite("src/auth/service.ts");
    assert(allowed1.replace(/\\/g, "/").endsWith("src/auth/service.ts"));

    const allowed2 = await fsAccess.resolveForWrite("config/settings.json");
    assert(allowed2.replace(/\\/g, "/").endsWith("config/settings.json"));

    // 超出 scope 抛出 FilesystemAccessDeniedError
    await assert.rejects(
      async () => {
        await fsAccess.resolveForWrite("src/frontend/App.tsx");
      },
      (err: unknown) => {
        assert(err instanceof FilesystemAccessDeniedError);
        assert.equal(err.operation, "write");
        return true;
      }
    );
  });

  it("3. writeScopes 重叠冲突检测 (Overlap Conflict Detection)", () => {
    // 两个不同领域的 scope 无冲突
    const res1 = checkScopeOverlap(["src/auth/**"], ["src/frontend/**"]);
    assert.equal(res1.conflict, false);

    // 存在包含/重叠关系的 scope 报告冲突
    const res2 = checkScopeOverlap(
      ["src/auth/**", "config/*.json"],
      ["src/auth/service.ts", "docs/**"]
    );
    assert.equal(res2.conflict, true);
    assert.equal(res2.overlappingScopes.length, 1);
    assert.equal(res2.overlappingScopes[0].patternA, "src/auth/**");
    assert.equal(res2.overlappingScopes[0].patternB, "src/auth/service.ts");
  });

  it("4. isPathInScope 能够正确匹配多种 Glob 模式", () => {
    assert.equal(isPathInScope("src/auth/service.ts", "src/auth/**"), true);
    assert.equal(isPathInScope("src/auth/sub/util.ts", "src/auth/**"), true);
    assert.equal(isPathInScope("src/auth/service.ts", "src/auth/*"), true);
    assert.equal(isPathInScope("src/auth/sub/util.ts", "src/auth/*"), false);
    assert.equal(isPathInScope("src/auth/service.ts", "src/**/*.ts"), true);
    assert.equal(isPathInScope("src/frontend/index.js", "src/**/*.ts"), false);
  });
});
