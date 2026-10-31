import { resolveNashHome } from "../../config/data-home.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ChatMessage } from "../../model/chat-completions-client.js";
import type {
  SessionRecord,
  UserSessionRecord,
  AssistantSessionRecord,
  ToolResultSessionRecord,
  CompactionSessionRecord,
  DomainEventSessionRecord,
  SessionSummary,
} from "../types.js";
import type { SessionStore } from "./session-store.js";
import type { ProjectContext } from "../../project/project-context.js";
import { generateProjectDirectoryName, normalizeProjectRoot } from "../../project/project-id.js";

export interface LocalSessionStoreOptions {
  sessionId?: string;
  projectContext?: ProjectContext;
  sessionsDir?: string;
  baseDir?: string;
}

export class LocalSessionStore implements SessionStore {
  readonly sessionId: string;
  readonly sessionsDir: string;
  private readonly sessionDir: string;
  private readonly jsonlPath: string;

  constructor(options?: LocalSessionStoreOptions) {
    this.sessionId = options?.sessionId ?? crypto.randomUUID();

    if (options?.sessionsDir) {
      this.sessionsDir = options.sessionsDir;
    } else if (options?.projectContext) {
      this.sessionsDir = options.projectContext.sessionsDir;
    } else if (options?.baseDir) {
      // 兼容 baseDir 既可能是包含 sessions 子目录的父目录，也可能直接被用作根
      this.sessionsDir = options.baseDir.endsWith(path.sep + "sessions") ||
        path.basename(options.baseDir) === "sessions"
        ? options.baseDir
        : path.join(options.baseDir, "sessions");
    } else {
      // 绝不写入 ~/.nash/context (Legacy Storage Only)
      // 默认回退至当前工作区的 Project Namespace 存储路径
      const canonicalCwd = normalizeProjectRoot(process.cwd());
      const dirName = generateProjectDirectoryName(canonicalCwd);
      this.sessionsDir = path.join(resolveNashHome(), "projects", dirName, "sessions");
    }

    this.sessionDir = path.join(this.sessionsDir, this.sessionId);
    this.jsonlPath = path.join(this.sessionDir, "session.jsonl");
  }

  private async ensureSessionFile(): Promise<void> {
    if (!fsSync.existsSync(this.sessionDir)) {
      await fs.mkdir(this.sessionDir, { recursive: true });
    }
  }

  async appendRecord(record: SessionRecord): Promise<void> {
    await this.ensureSessionFile();
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(this.jsonlPath, line, "utf-8");
  }

  async appendUserMessage(
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<UserSessionRecord> {
    const record: UserSessionRecord = {
      type: "user",
      id: crypto.randomUUID(),
      content,
      createdAt: Date.now(),
      metadata,
    };
    await this.appendRecord(record);
    return record;
  }

  async appendAssistantMessage(
    content: string | null,
    toolCalls?: AssistantSessionRecord["toolCalls"],
    metadata?: Record<string, unknown>
  ): Promise<AssistantSessionRecord> {
    const record: AssistantSessionRecord = {
      type: "assistant",
      id: crypto.randomUUID(),
      content,
      toolCalls,
      createdAt: Date.now(),
      metadata,
    };
    await this.appendRecord(record);
    return record;
  }

  async appendToolResult(
    toolCallId: string,
    toolName: string,
    result: {
      content?: string;
      preview?: string;
      spillRef?: string;
      originalChars: number;
      offloaded: boolean;
      success: boolean;
      executionTimeMs?: number;
    },
    metadata?: Record<string, unknown>
  ): Promise<ToolResultSessionRecord> {
    const record: ToolResultSessionRecord = {
      type: "tool_result",
      id: crypto.randomUUID(),
      toolCallId,
      toolName,
      content: result.offloaded ? undefined : result.content,
      preview: result.preview,
      spillRef: result.spillRef,
      originalChars: result.originalChars,
      offloaded: result.offloaded,
      success: result.success,
      executionTimeMs: result.executionTimeMs,
      createdAt: Date.now(),
      metadata,
    };
    await this.appendRecord(record);
    return record;
  }

  async appendCompactionRecord(
    summary: string,
    compactedRange: { startIndex: number; endIndex: number },
    consolidatedCount?: number,
    metadata?: Record<string, unknown>,
    activeMessages?: ChatMessage[]
  ): Promise<CompactionSessionRecord> {
    const record: CompactionSessionRecord = {
      type: "compaction",
      id: crypto.randomUUID(),
      summary,
      compactedRange,
      activeMessages,
      consolidatedCount,
      createdAt: Date.now(),
      metadata,
    };
    await this.appendRecord(record);
    return record;
  }

  async appendDomainEvent(
    eventType: string,
    data: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<DomainEventSessionRecord> {
    const record: DomainEventSessionRecord = {
      type: "domain_event",
      id: crypto.randomUUID(),
      eventType,
      data,
      createdAt: Date.now(),
      metadata,
    };
    await this.appendRecord(record);
    return record;
  }

  async getRecords(): Promise<SessionRecord[]> {
    if (!fsSync.existsSync(this.jsonlPath)) {
      return [];
    }

    const raw = await fs.readFile(this.jsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const records: SessionRecord[] = [];

    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch {
        // ignore malformed lines
      }
    }

    return records;
  }

  async getCompactionHistory(): Promise<CompactionSessionRecord[]> {
    const records = await this.getRecords();
    return records.filter(
      (r): r is CompactionSessionRecord => r.type === "compaction"
    );
  }

  /**
   * 获取当前会话的元信息摘要
   */
  async getSummary(): Promise<SessionSummary> {
    const records = await this.getRecords();
    return this.summarizeRecords(records);
  }

  private async summarizeRecords(records: SessionRecord[]): Promise<SessionSummary> {
    if (records.length === 0) {
      let createdAt = Date.now();
      let updatedAt = Date.now();
      try {
        if (fsSync.existsSync(this.jsonlPath)) {
          const stat = await fs.stat(this.jsonlPath);
          createdAt = stat.birthtimeMs || stat.ctimeMs || Date.now();
          updatedAt = stat.mtimeMs || Date.now();
        }
      } catch {}

      return {
        sessionId: this.sessionId,
        createdAt,
        updatedAt,
        recordCount: 0,
        messageCount: 0,
        hasCompaction: false,
      };
    }

    const firstRecord = records[0];
    const lastRecord = records[records.length - 1];

    let messageCount = 0;
    let firstUserPrompt: string | undefined;
    let lastUserPrompt: string | undefined;
    let hasCompaction = false;
    let title: string | undefined;
    let sessionKind: SessionSummary["sessionKind"];

    for (const rec of records) {
      if (rec.type === "user") {
        messageCount++;
        if (!sessionKind) {
          const agentType = rec.metadata?.agentType;
          if (agentType === "main" || agentType === "subagent" || agentType === "team-lead" || agentType === "team-member") {
            sessionKind = agentType;
          }
        }
        if (!firstUserPrompt) {
          firstUserPrompt = rec.content.slice(0, 120);
        }
        lastUserPrompt = rec.content.slice(0, 120);
        const normalized = rec.content
          .replace(/^\[User guidance \/ steer\]\s*/i, "")
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
          .replace(/[\x00-\x1f\x7f]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const synthetic = rec.metadata?.source === "background-job-notification" || /^\[Background job notification\]/i.test(rec.content);
        const generic = /^(?:你好|您好|hi|hello|hey|nash|开始|继续|ok|好的|test|测试)[!！?.。\s]*$/i.test(normalized);
        if (!title && !synthetic && !generic && normalized) title = normalized.slice(0, 160);
      } else if (rec.type === "assistant") {
        messageCount++;
      } else if (rec.type === "compaction") {
        hasCompaction = true;
      }
    }

    return {
      sessionId: this.sessionId,
      createdAt: firstRecord?.createdAt ?? Date.now(),
      updatedAt: lastRecord?.createdAt ?? Date.now(),
      recordCount: records.length,
      messageCount,
      firstUserPrompt,
      lastUserPrompt,
      title: title ?? "未命名会话",
      sessionKind,
      hasCompaction,
    };
  }

  async toChatMessages(): Promise<ChatMessage[]> {
    return LocalSessionStore.recordsToChatMessages(await this.getRecords());
  }

  static recordsToChatMessages(records: SessionRecord[]): ChatMessage[] {
    const messages: ChatMessage[] = [];

    for (let i = 0; i < records.length; i++) {
      const rec = records[i]!;
      if (rec.type === "user") {
        messages.push({
          role: "user",
          content: rec.content,
        });
      } else if (rec.type === "assistant") {
        messages.push({
          role: "assistant",
          content: rec.content,
          tool_calls: rec.toolCalls,
        });

        if (rec.toolCalls && rec.toolCalls.length > 0) {
          // 查找后续紧邻的所有属于当前步骤的 tool_result 记录
          const expectedCallIds = new Set(rec.toolCalls.map((tc) => tc.id));
          const answeredInRecords = new Map<string, ToolResultSessionRecord>();

          let j = i + 1;
          while (j < records.length && !["assistant", "user"].includes(records[j]!.type)) {
            const tr = records[j] as ToolResultSessionRecord;
            if (tr.type === "tool_result" && expectedCallIds.has(tr.toolCallId)) {
              answeredInRecords.set(tr.toolCallId, tr);
            }
            j++;
          }

          // 按照 toolCalls 声明顺序，依次输出真实的 tool_result 或合成补偿消息
          for (const tc of rec.toolCalls) {
            const tr = answeredInRecords.get(tc.id);
            if (tr) {
              messages.push({
                role: "tool",
                tool_call_id: tr.toolCallId,
                content: tr.offloaded
                  ? `[Spilled Tool Result]\nSpillRef: ${tr.spillRef}\nPreview: ${tr.preview}`
                  : tr.content ?? "",
              });
            } else {
              // 遗留会话防御性修复：为未响应的 tool_call 追加合成取消响应，防止模型 API 报 400
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: "[System] Tool execution was interrupted or cancelled before completion.",
              });
            }
          }

          // 跳过已在此处按顺序处理过的 tool_result 记录
          i = j - 1;
        }
      } else if (rec.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: rec.toolCallId,
          content: rec.offloaded
            ? `[Spilled Tool Result]\nSpillRef: ${rec.spillRef}\nPreview: ${rec.preview}`
            : rec.content ?? "",
        });
      }
    }

    return messages;
  }

  async clear(): Promise<void> {
    if (fsSync.existsSync(this.jsonlPath)) {
      await fs.unlink(this.jsonlPath);
    }
  }

  private static resolveSessionsDir(target?: string | ProjectContext): string {
    if (!target) {
      const canonicalCwd = normalizeProjectRoot(process.cwd());
      const dirName = generateProjectDirectoryName(canonicalCwd);
      return path.join(resolveNashHome(), "projects", dirName, "sessions");
    }
    if (typeof target === "object" && "sessionsDir" in target) {
      return target.sessionsDir;
    }
    const targetStr = String(target);
    if (
      targetStr.endsWith(path.sep + "sessions") ||
      path.basename(targetStr) === "sessions"
    ) {
      return targetStr;
    }
    return path.join(targetStr, "sessions");
  }

  /**
   * 列出所有已持久化的 Session ID 列表
   */
  static async listSessions(target?: string | ProjectContext): Promise<string[]> {
    const root = LocalSessionStore.resolveSessionsDir(target);
    if (!fsSync.existsSync(root)) {
      return [];
    }

    const items = await fs.readdir(root);
    const sessionIds: string[] = [];
    for (const item of items) {
      const p = path.join(root, item);
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        sessionIds.push(item);
      }
    }
    return sessionIds;
  }

  /**
   * 判断指定 Session 是否存在
   */
  static async sessionExists(
    sessionId: string,
    target?: string | ProjectContext
  ): Promise<boolean> {
    const root = LocalSessionStore.resolveSessionsDir(target);
    const targetDir = path.join(root, sessionId);
    return fsSync.existsSync(targetDir);
  }

  /**
   * 获取所有历史会话的元信息摘要列表（按最新更新时间倒序排序）
   */
  static async listSessionSummaries(
    target?: string | ProjectContext
  ): Promise<SessionSummary[]> {
    const sessionsDir = LocalSessionStore.resolveSessionsDir(target);
    const sessionIds = await LocalSessionStore.listSessions(sessionsDir);
    return LocalSessionStore.listMainSessionSummaries(sessionsDir, sessionIds);
  }

  private static async listMainSessionSummaries(sessionsDir: string, sessionIds: string[]): Promise<SessionSummary[]> {
    const snapshots: Array<{ summary: SessionSummary; records: SessionRecord[]; firstPrompt?: string }> = [];
    for (const id of sessionIds) {
      const store = new LocalSessionStore({ sessionId: id, sessionsDir });
      const records = await store.getRecords();
      snapshots.push({
        summary: await store.summarizeRecords(records),
        records,
        firstPrompt: records.find((record) => record.type === "user")?.content,
      });
    }

    // Old child contexts lack an owner marker. Their first prompt is the exact
    // prompt passed to spawn_agent in a parent session, so identify them without
    // moving or deleting any durable records.
    const delegatedPrompts = new Map<string, Set<string>>();
    for (const snapshot of snapshots) {
      for (const record of snapshot.records) {
        if (record.type !== "assistant") continue;
        for (const call of record.toolCalls ?? []) {
          if (call.function?.name !== "spawn_agent") continue;
          try {
            const args = JSON.parse(call.function.arguments);
            if (typeof args.prompt === "string") {
              const parents = delegatedPrompts.get(args.prompt) ?? new Set<string>();
              parents.add(snapshot.summary.sessionId);
              delegatedPrompts.set(args.prompt, parents);
            }
          } catch {}
        }
      }
    }

    return snapshots
      .filter(({ summary, firstPrompt }) =>
        (summary.sessionKind === undefined || summary.sessionKind === "main") &&
        !(summary.sessionKind === undefined && firstPrompt && [...(delegatedPrompts.get(firstPrompt) ?? [])].some((parentId) => parentId !== summary.sessionId))
      )
      .map(({ summary }) => summary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 探测是否存在 Legacy 全局存储中的历史会话 (~/.nash/context/sessions/)
   * 仅用于检测与给出无害提示，绝对不破坏性自动删除
   */
  static async detectLegacySessions(nashHome?: string): Promise<string[]> {
    const legacyRoot = path.join(
      nashHome ?? resolveNashHome(),
      "context",
      "sessions"
    );
    if (!fsSync.existsSync(legacyRoot)) {
      return [];
    }
    try {
      const items = await fs.readdir(legacyRoot);
      const legacies: string[] = [];
      for (const item of items) {
        const p = path.join(legacyRoot, item);
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          legacies.push(item);
        }
      }
      return legacies;
    } catch {
      return [];
    }
  }

  /**
   * 获取 Legacy 全局存储中的历史会话摘要列表 (只读)
   */
  static async listLegacySessionSummaries(
    nashHome?: string
  ): Promise<SessionSummary[]> {
    const legacyRoot = path.join(
      nashHome ?? resolveNashHome(),
      "context",
      "sessions"
    );
    if (!fsSync.existsSync(legacyRoot)) {
      return [];
    }
    const sessionIds = await LocalSessionStore.detectLegacySessions(nashHome);
    return LocalSessionStore.listMainSessionSummaries(legacyRoot, sessionIds);
  }
}
