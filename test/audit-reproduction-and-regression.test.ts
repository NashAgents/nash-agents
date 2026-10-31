import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileSystemAccess } from "../src/sandbox/filesystem-access.js";
import { createDefaultSandboxPolicy } from "../src/sandbox/policy.js";
import { FilesystemAccessDeniedError } from "../src/sandbox/errors.js";
import { FileLockManager } from "../src/filesystem/file-lock-manager.js";
import { accumulateChatCompletionStream, type ChatCompletionChunk } from "../src/model/chat-completions-client.js";
import { LocalSessionStore } from "../src/context/session/local-session-store.js";
import { ContextManager } from "../src/context/context-manager.js";
import { CompactionEngine } from "../src/context/compaction-engine.js";
import { ConcurrencyController } from "../src/concurrency/concurrency-controller.js";
import { TeamRuntime } from "../src/team/team-runtime.js";
import { TaskManager } from "../src/task/task-manager.js";
import { AgentRegistry } from "../src/agent/agent-registry.js";
import type { ApprovalService } from "../src/approval/approval-service.js";

describe("Audit Reproduction & Verification Test Suite", () => {
  // =========================================================================
  // 1. Symlink Traversal Escape Bug
  // =========================================================================
  describe("1. Symlink Escape Verification", () => {
    it("1.1 软链接指向工作区外目标时，应被判定为越界逃逸并拒绝访问", async () => {
      const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "nash-symlink-test-"));
      const workspaceDir = path.join(tempBase, "workspace");
      const outsideDir = path.join(tempBase, "outside_secret");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, "secret.txt");
      await fs.writeFile(secretFile, "super-secret-key", "utf-8");

      // 在工作区内创建指向外部文件的软链接
      const symlinkInWorkspace = path.join(workspaceDir, "link_to_secret.txt");
      fsSync.symlinkSync(secretFile, symlinkInWorkspace);

      const fsAccess = new FileSystemAccess({
        workspaceRoot: workspaceDir,
        policy: {
          filesystem: { mode: "workspace-write" },
          network: { mode: "deny" },
          approval: { mode: "ask" },
        },
      });

      // 验证读取软链接：必须拦截并识别为越界访问
      await assert.rejects(
        async () => {
          await fsAccess.resolveForRead("link_to_secret.txt");
        },
        FilesystemAccessDeniedError,
        "软链接指向外部时，resolveForRead 应该抛出 FilesystemAccessDeniedError"
      );

      // 验证写入软链接：必须拦截并识别为越界访问
      await assert.rejects(
        async () => {
          await fsAccess.resolveForWrite("link_to_secret.txt");
        },
        FilesystemAccessDeniedError,
        "软链接指向外部时，resolveForWrite 应该抛出 FilesystemAccessDeniedError"
      );

      // 清理
      await fs.rm(tempBase, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 2. Dangling Multi-Tool-Call Session Poisoning Bug
  // =========================================================================
  describe("2. Dangling Multi-Tool-Call Session Poisoning Verification", () => {
    it("2.1 单步多个 tool_calls 中断导致缺少 tool 响应时，toChatMessages 应合成补偿消息避免协议损毁", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-dangling-tool-test-"));
      const sessionStore = new LocalSessionStore({
        sessionId: "test-dangling-session",
        baseDir: tempDir,
      });

      await sessionStore.appendUserMessage("请批量检查三个文件");

      // 模型返回 3 个工具调用
      await sessionStore.appendAssistantMessage(
        "我将分别检查三个文件",
        [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
          { id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
          { id: "call_3", type: "function", function: { name: "read_file", arguments: '{"path":"c.ts"}' } },
        ]
      );

      // 只有 call_1 成功执行并追加了记录，call_2 和 call_3 遭到异常中断未执行
      await sessionStore.appendToolResult("call_1", "read_file", {
        content: "content of a.ts",
        originalChars: 15,
        offloaded: false,
        success: true,
      });

      // 当后续重放该会话并转换为 ChatMessages 时：
      const messages = await sessionStore.toChatMessages();

      // 严格检验协议完整性：每个 tool_call 必须严格有且仅有一个紧随的 tool 响应
      const toolMsgMap = new Map<string, string>();
      for (const m of messages) {
        if (m.role === "tool" && m.tool_call_id) {
          toolMsgMap.set(m.tool_call_id, m.content ?? "");
        }
      }

      assert.equal(toolMsgMap.has("call_1"), true, "call_1 必须有响应");
      assert.equal(toolMsgMap.has("call_2"), true, "call_2 必须被合成补偿消息覆盖");
      assert.equal(toolMsgMap.has("call_3"), true, "call_3 必须被合成补偿消息覆盖");

      // 清理
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 3. Streaming Repeated Tool Name Bug
  // =========================================================================
  describe("3. Streaming Tool Name Concatenation Verification", () => {
    it("3.1 工具名称包含重复子串时，不应被 .includes() 错误截断", async () => {
      // 模拟包含重复子串的工具名: test_case_test
      // 分块为 ["test_case_", "test"]
      const chunks: ChatCompletionChunk[] = [
        {
          id: "chunk-1",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_test",
                    type: "function",
                    function: {
                      name: "test_case_",
                      arguments: '{"foo":',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chunk-2",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: "test", // 这里的 "test" 已经包含在 "test_case_" 中
                      arguments: '"bar"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const result = await accumulateChatCompletionStream(chunks);
      const toolCall = result.response.choices[0]?.message?.tool_calls?.[0];

      assert.ok(toolCall, "应成功提取工具调用");
      assert.equal(
        toolCall.function.name,
        "test_case_test",
        `工具名应完整拼接为 'test_case_test'，实际为 '${toolCall.function.name}'`
      );
    });

    it("3.2 网关发送累计型工具名称前缀时，应正确兼容而不是重复追加", async () => {
      // 模拟反代或网关发送累计块: ["search", "search_files"]
      const chunks: ChatCompletionChunk[] = [
        {
          id: "chunk-1",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_search",
                    type: "function",
                    function: {
                      name: "search",
                      arguments: '{"q":"1"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          id: "chunk-2",
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      name: "search_files", // 累计前缀
                    },
                  },
                ],
              },
            },
          ],
        },
      ];

      const result = await accumulateChatCompletionStream(chunks);
      const toolCall = result.response.choices[0]?.message?.tool_calls?.[0];

      assert.ok(toolCall);
      assert.equal(
        toolCall.function.name,
        "search_files",
        `累计型前缀应收敛为 'search_files'，而非 'searchsearch_files'`
      );
    });
  });

  // =========================================================================
  // 4. Holding Lock While Awaiting Human Approval Anti-Pattern
  // =========================================================================
  describe("4. FileLock While Awaiting Approval Anti-Pattern Verification", () => {
    it("4.1 在等待人工审批期间，物理文件锁绝不应被提前持有", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-lock-approval-test-"));
      const targetFile = path.join(tempDir, "test.txt");
      await fs.writeFile(targetFile, "initial", "utf-8");

      const lockManager = new FileLockManager();
      let isFileLockedDuringApproval = false;

      // 模拟需要用户确认审批的 ApprovalService
      const mockApprovalService = {
        hasProvider: () => true,
        requestApproval: async () => {
          // 在审批决策等待期间，检查目标文件是否被持有互斥锁
          isFileLockedDuringApproval = lockManager.isLocked(targetFile);
          return "allow-once";
        },
      } as unknown as ApprovalService;

      const fsAccess = new FileSystemAccess({
        workspaceRoot: tempDir,
        policy: {
          filesystem: { mode: "read-only" }, // read-only 模式写入需要审批
          network: { mode: "deny" },
          approval: { mode: "ask" },
        },
        approvalService: mockApprovalService,
        lockManager,
      });

      await fsAccess.executeAtomicWrite(
        targetFile,
        async (p) => {
          await fs.writeFile(p, "updated", "utf-8");
        }
      );

      // 核心断言：在等待用户审批时，锁绝不能被持有！
      assert.equal(
        isFileLockedDuringApproval,
        false,
        "在用户审批等待期间持有文件互斥锁，会导致其他 Agent 发生级联死锁"
      );

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 5. TeamRuntime.waitForChange Slot Exhaustion Bug
  // =========================================================================
  describe("5. TeamRuntime.waitForChange Concurrency Slot Verification", () => {
    it("5.1 waitForChange 进入长时间等待时必须主动 yieldSlot 释放并发槽", async () => {
      const concurrency = new ConcurrencyController({
        maxConcurrentAgents: 1, // 设置槽位数为 1
      });

      // 模拟 Agent 已经占有 1 个槽位在运行中
      const release = await concurrency.acquireSlot(undefined, "member-1");
      assert.equal(concurrency.getRunningCount(), 1, "初始应占用 1 个槽位");

      const taskManager = new TaskManager();
      const agentRegistry = new AgentRegistry();
      const team = new TeamRuntime({
        name: "test-team",
        leaderId: "main",
        taskManager,
        agentRegistry,
        concurrencyController: concurrency,
      });

      team.addMember({
        agentId: "member-1",
        name: "Worker 1",
        role: "worker",
        roleDescription: "Worker 1 role",
      });

      // 启动 waitForChange 等待新事件（设置 100ms 超时）
      const waitPromise = team.waitForChange("member-1", { timeoutMs: 100 });

      // 在等待期间，并发槽位应该被归还 (running count 变为 0)，以便其他 Agent 可以运行
      // 若未归还，其他 Agent（如 Lead）无法获取槽位分配任务，系统死锁
      const runningDuringWait = concurrency.getRunningCount();

      await waitPromise;
      release();

      assert.equal(
        runningDuringWait,
        0,
        "在 waitForChange 挂起等待期间未让出并发槽，将导致 maxConcurrentAgents 耗尽与死锁"
      );
    });
  });

  // =========================================================================
  // 6. Compaction Restore Record Index Offset Bug
  // =========================================================================
  describe("6. Compaction Restore Record Index Offset Verification", () => {
    it("6.1 压缩恢复后，最近未压缩的 recentMessages 必须完整保留，不得被错位索引丢弃", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-compaction-restore-test-"));
      const sessionStore = new LocalSessionStore({
        sessionId: "test-compaction-restore",
        baseDir: tempDir,
      });

      const contextManager = new ContextManager({
        sessionStore,
        compactionEngine: new CompactionEngine({
          keepRecentMessages: 2, // 仅保留最近 2 条，压缩更早的消息
          llmInvoker: async () => "这是前 4 条消息的历史压缩摘要",
        }),
      });

      // 写入 6 条消息
      await contextManager.recordUserMessage("Msg 1");
      await contextManager.recordAssistantMessage("Reply 1");
      await contextManager.recordUserMessage("Msg 2");
      await contextManager.recordAssistantMessage("Reply 2");
      await contextManager.recordUserMessage("Msg 3 (Recent 1)");
      await contextManager.recordAssistantMessage("Reply 3 (Recent 2)");

      contextManager.setActiveMessages([
        { role: "user", content: "Msg 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Msg 2" },
        { role: "assistant", content: "Reply 2" },
        { role: "user", content: "Msg 3 (Recent 1)" },
        { role: "assistant", content: "Reply 3 (Recent 2)" },
      ]);

      // 触发压缩
      const record = await contextManager.compactNow();
      assert.ok(record, "压缩应成功生成 record");

      // 模拟重启进程，新建一个全新的 ContextManager 从 SessionStore 恢复 ActiveMessages
      const reloadedContextManager = new ContextManager({
        sessionStore,
      });

      const restoredMessages = await reloadedContextManager.restoreActiveMessages("System Prompt");

      // 恢复后应该包含：
      // 1. System Prompt
      // 2. Summary 消息
      // 3. Msg 3 (Recent 1)
      // 4. Reply 3 (Recent 2)
      const userContents = restoredMessages.filter((m) => m.role === "user").map((m) => m.content);
      const assistantContents = restoredMessages.filter((m) => m.role === "assistant").map((m) => m.content);

      assert.ok(
        userContents.some((c) => c?.includes("Msg 3 (Recent 1)")),
        `恢复的消息中必须包含 Msg 3，实际 user 消息: ${JSON.stringify(userContents)}`
      );
      assert.ok(
        assistantContents.some((c) => c?.includes("Reply 3 (Recent 2)")),
        `恢复的消息中必须包含 Reply 3，实际 assistant 消息: ${JSON.stringify(assistantContents)}`
      );

      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("6.2 当压缩范围不是从首条开始时 (startIndex > 0)，前置与后置未压缩消息均应完整保留", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-compaction-range-test-"));
      const sessionStore = new LocalSessionStore({
        sessionId: "test-compaction-arbitrary-range",
        baseDir: tempDir,
      });

      // 模拟写入 6 条消息
      await sessionStore.appendUserMessage("Prefix User 0");
      await sessionStore.appendAssistantMessage("Prefix Assistant 1");
      await sessionStore.appendUserMessage("Middle User 2 (To Compact)");
      await sessionStore.appendAssistantMessage("Middle Assistant 3 (To Compact)");
      await sessionStore.appendUserMessage("Suffix User 4 (Recent)");
      await sessionStore.appendAssistantMessage("Suffix Assistant 5 (Recent)");

      // 人工追加一条压缩范围为 [2, 3] 的 Compaction 记录（仅压缩中间两条）
      await sessionStore.appendCompactionRecord(
        "中间两条消息的摘要",
        { startIndex: 2, endIndex: 3 }
      );

      const contextManager = new ContextManager({ sessionStore });
      const restored = await contextManager.restoreActiveMessages("System");

      const contents = restored.map((m) => m.content ?? "");
      // 期望：Prefix User 0, Prefix Assistant 1, Summary, Suffix User 4, Suffix Assistant 5 均在
      assert.ok(contents.some((c) => c.includes("Prefix User 0")), "Prefix 消息必须保留");
      assert.ok(contents.some((c) => c.includes("中间两条消息的摘要")), "Summary 必须包含");
      assert.ok(contents.some((c) => c.includes("Suffix User 4")), "Suffix 消息必须保留");
      assert.equal(contents.some((c) => c.includes("Middle User 2")), false, "被压缩的 Middle 消息必须被 Summary 替代");

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 7. Physical FileLock Canonical Resolution Verification
  // =========================================================================
  describe("7. Physical FileLock Canonical Resolution Verification", () => {
    it("7.1 两个不同的词法路径（如真实文件与指向该文件的软链接）必须互斥同一个物理锁", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-canonical-lock-test-"));
      const realFile = path.join(tempDir, "real_target.txt");
      await fs.writeFile(realFile, "content", "utf-8");

      const symlinkFile = path.join(tempDir, "symlink_alias.txt");
      fsSync.symlinkSync(realFile, symlinkFile);

      const lockManager = new FileLockManager();

      let order: string[] = [];
      let symlinkAcquired = false;

      // 在 symlink 上持有锁 50ms
      const promise1 = lockManager.withLock(symlinkFile, async () => {
        symlinkAcquired = true;
        // 关键断言：当通过 symlink 上锁时，检查 realFile 也必须处于锁定状态！
        assert.equal(
          lockManager.isLocked(realFile),
          true,
          "通过软链接上锁后，真实物理文件必须同时被锁定"
        );
        order.push("symlink:start");
        await new Promise((r) => setTimeout(r, 50));
        order.push("symlink:end");
      });

      // 在 realFile 上请求锁，预期必须等待 symlink 释放
      const promise2 = lockManager.withLock(realFile, async () => {
        order.push("real:start");
      });

      await Promise.all([promise1, promise2]);

      // 验证顺序必须是 symlink 先执行完毕，realFile 后进入
      assert.deepEqual(order, ["symlink:start", "symlink:end", "real:start"]);

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  // =========================================================================
  // 8. Synthetic Tool Result Persistence Failure & Defensive Repair Dual-Insurance
  // =========================================================================
  describe("8. Synthetic Tool Result Dual Insurance Verification", () => {
    it("8.1 若运行时写入 synthetic result 发生故障，重载会话时 toChatMessages 仍能防御性修复", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-dual-insurance-test-"));
      const sessionStore = new LocalSessionStore({
        sessionId: "dual-insurance-session",
        baseDir: tempDir,
      });

      await sessionStore.appendUserMessage("User query");
      // 模型返回 2 个工具调用，但由于进程断电或磁盘故障，未写入任何 tool 结果
      await sessionStore.appendAssistantMessage("Plan to call tools", [
        { id: "call_lost_1", type: "function", function: { name: "foo", arguments: "{}" } },
        { id: "call_lost_2", type: "function", function: { name: "bar", arguments: "{}" } },
      ]);

      // 此时 session.jsonl 处于未响应状态。加载会话时：
      const messages = await sessionStore.toChatMessages();

      const toolCalls = messages.filter((m) => m.role === "tool");
      assert.equal(toolCalls.length, 2, "toChatMessages 必须自动防御性补齐 2 个 tool 消息");
      assert.equal(toolCalls[0]?.tool_call_id, "call_lost_1");
      assert.equal(toolCalls[1]?.tool_call_id, "call_lost_2");

      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });
});
