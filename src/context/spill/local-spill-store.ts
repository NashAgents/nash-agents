import { resolveNashHome } from "../../config/data-home.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { SpillRef, SpillPolicy } from "../types.js";
import type {
  SpillStore,
  SpillReadOptions,
  SpillReadResult,
  SpillArtifactInfo,
} from "./spill-store.js";
import {
  DEFAULT_SPILL_POLICY,
  SpillArtifactQuotaError,
  SpillSessionQuotaError,
  SpillGlobalQuotaError,
} from "./spill-policy.js";
import type { ProjectContext } from "../../project/project-context.js";
import { generateProjectDirectoryName, normalizeProjectRoot } from "../../project/project-id.js";

export interface LocalSpillStoreOptions {
  projectContext?: ProjectContext;
  spillDir?: string;
  baseDir?: string;
  policy?: Partial<SpillPolicy>;
}

export class LocalSpillStore implements SpillStore {
  readonly spillDir: string;
  private readonly policy: SpillPolicy;

  constructor(options?: LocalSpillStoreOptions) {
    if (options?.spillDir) {
      this.spillDir = options.spillDir;
    } else if (options?.projectContext) {
      this.spillDir = options.projectContext.spillDir;
    } else if (options?.baseDir) {
      this.spillDir =
        options.baseDir.endsWith(path.sep + "spill") ||
        path.basename(options.baseDir) === "spill"
          ? options.baseDir
          : path.join(options.baseDir, "spill");
    } else {
      // 绝不写入 ~/.nash/context/spill (Legacy Storage Only)
      const canonicalCwd = normalizeProjectRoot(process.cwd());
      const dirName = generateProjectDirectoryName(canonicalCwd);
      this.spillDir = path.join(resolveNashHome(), "projects", dirName, "spill");
    }

    this.policy = {
      ...DEFAULT_SPILL_POLICY,
      ...options?.policy,
    };
  }

  private getSpillRoot(): string {
    return this.spillDir;
  }

  private getSessionDir(sessionId: string): string {
    return path.join(this.getSpillRoot(), sessionId);
  }

  private normalizeId(refOrLocatorOrId: string | SpillRef): string {
    if (typeof refOrLocatorOrId === "object" && refOrLocatorOrId !== null) {
      return refOrLocatorOrId.id;
    }
    const str = refOrLocatorOrId.trim();
    if (str.startsWith("tool-result://")) {
      return str.slice("tool-result://".length);
    }
    return str;
  }

  private async findArtifactPath(
    artifactId: string
  ): Promise<{ txtPath: string; metaPath: string; sessionId: string } | null> {
    const spillRoot = this.getSpillRoot();
    if (!fsSync.existsSync(spillRoot)) {
      return null;
    }

    const sessionDirs = await fs.readdir(spillRoot);
    for (const sDir of sessionDirs) {
      const txtPath = path.join(spillRoot, sDir, `${artifactId}.txt`);
      const metaPath = path.join(spillRoot, sDir, `${artifactId}.meta.json`);
      if (fsSync.existsSync(txtPath)) {
        return { txtPath, metaPath, sessionId: sDir };
      }
    }
    return null;
  }

  async save(
    content: string,
    options?: {
      sessionId?: string;
      toolName?: string;
      toolCallId?: string;
      artifactId?: string;
    }
  ): Promise<SpillRef> {
    const sessionId = options?.sessionId ?? "default";
    const artifactId = options?.artifactId ?? crypto.randomUUID();
    const locator = `tool-result://${artifactId}`;
    const bytes = Buffer.byteLength(content, "utf-8");
    const chars = content.length;
    const createdAt = Date.now();

    // 1. 单个 Artifact 大小限制
    if (bytes > this.policy.maxArtifactBytes) {
      throw new SpillArtifactQuotaError(bytes, this.policy.maxArtifactBytes);
    }

    // 2. Session 级别大小配额检查
    const currentSessionBytes = await this.getSessionBytes(sessionId);
    if (currentSessionBytes + bytes > this.policy.maxSessionBytes) {
      throw new SpillSessionQuotaError(
        sessionId,
        currentSessionBytes + bytes,
        this.policy.maxSessionBytes
      );
    }

    // 3. 全局大小配额检查
    const currentGlobalBytes = await this.getGlobalBytes();
    if (currentGlobalBytes + bytes > this.policy.maxGlobalBytes) {
      throw new SpillGlobalQuotaError(
        currentGlobalBytes + bytes,
        this.policy.maxGlobalBytes
      );
    }

    const sessionDir = this.getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const txtPath = path.join(sessionDir, `${artifactId}.txt`);
    const metaPath = path.join(sessionDir, `${artifactId}.meta.json`);

    await fs.writeFile(txtPath, content, "utf-8");

    const meta: SpillArtifactInfo = {
      id: artifactId,
      locator,
      sessionId,
      bytes,
      chars,
      createdAt,
      toolName: options?.toolName,
      toolCallId: options?.toolCallId,
    };

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

    return {
      id: artifactId,
      locator,
      bytes,
      chars,
      createdAt,
      sessionId,
      toolName: options?.toolName,
      toolCallId: options?.toolCallId,
    };
  }

  async read(
    refOrLocatorOrId: string | SpillRef,
    options?: SpillReadOptions
  ): Promise<SpillReadResult> {
    const artifactId = this.normalizeId(refOrLocatorOrId);
    const locator = `tool-result://${artifactId}`;

    const found = await this.findArtifactPath(artifactId);
    if (!found) {
      throw new Error(`ArtifactNotFound: Spill artifact '${artifactId}' 不存在。`);
    }

    const fullContent = await fs.readFile(found.txtPath, "utf-8");
    const totalChars = fullContent.length;

    const lines = fullContent.split("\n");
    const totalLines = lines.length;

    const maxCharsLimit =
      typeof options?.maxChars === "number" && options.maxChars > 0
        ? options.maxChars
        : this.policy.maxInlineChars;

    // 场景 A: 显式指定字符级 charOffset
    if (typeof options?.charOffset === "number" && options.charOffset >= 0) {
      const startChar = Math.min(options.charOffset, totalChars);
      const endChar = Math.min(startChar + maxCharsLimit, totalChars);
      const sliceContent = fullContent.slice(startChar, endChar);
      const hasMore = endChar < totalChars;

      // 计算对应行号
      const startLine =
        fullContent.slice(0, startChar).split("\n").length;
      const endLine =
        fullContent.slice(0, endChar).split("\n").length;

      return {
        content: sliceContent,
        startLine,
        endLine,
        totalLines,
        startChar,
        endChar,
        totalChars,
        hasMore,
        nextCharOffset: hasMore ? endChar : undefined,
        nextLineOffset: hasMore ? endLine : undefined,
        locator,
      };
    }

    // 场景 B: 基于行号 offset 与 limit，同时受到 maxCharsLimit 硬约束
    const offsetLine = Math.max(1, options?.offset ?? 1);
    const lineLimit =
      typeof options?.limit === "number" && options.limit > 0
        ? options.limit
        : totalLines;

    const startLineIndex = offsetLine - 1; // 0-based
    if (startLineIndex >= totalLines) {
      return {
        content: "",
        startLine: offsetLine,
        endLine: offsetLine,
        totalLines,
        startChar: totalChars,
        endChar: totalChars,
        totalChars,
        hasMore: false,
        locator,
      };
    }

    // 计算起始字符位置
    let startChar = 0;
    for (let i = 0; i < startLineIndex; i++) {
      startChar += lines[i].length + 1; // +1 for '\n'
    }

    let accumulatedChars = 0;
    const selectedLines: string[] = [];
    let currentLineIndex = startLineIndex;
    let truncatedInsideLine = false;

    while (
      currentLineIndex < totalLines &&
      selectedLines.length < lineLimit &&
      accumulatedChars < maxCharsLimit
    ) {
      const currentLine = lines[currentLineIndex];
      const remainingBudget = maxCharsLimit - accumulatedChars;

      if (currentLine.length + 1 <= remainingBudget) {
        // 当前行能完整放入
        selectedLines.push(currentLine);
        accumulatedChars += currentLine.length + 1;
        currentLineIndex++;
      } else {
        // 当前行（包含超长单行）超过了剩余预算，必须对单行进行截断
        if (remainingBudget > 0) {
          const partialLine = currentLine.slice(0, remainingBudget);
          selectedLines.push(partialLine);
          accumulatedChars += partialLine.length;
          truncatedInsideLine = true;
        }
        break;
      }
    }

    const sliceContent = selectedLines.join("\n");
    const endChar = Math.min(startChar + sliceContent.length, totalChars);
    const endLine = Math.min(
      startLineIndex + selectedLines.length,
      totalLines
    );

    const hasMore = endChar < totalChars;

    return {
      content: sliceContent,
      startLine: offsetLine,
      endLine: Math.max(offsetLine, endLine),
      totalLines,
      startChar,
      endChar,
      totalChars,
      hasMore,
      nextCharOffset: hasMore ? endChar : undefined,
      nextLineOffset: hasMore && !truncatedInsideLine ? currentLineIndex + 1 : undefined,
      locator,
    };
  }

  async get(
    refOrLocatorOrId: string | SpillRef
  ): Promise<SpillArtifactInfo | null> {
    const artifactId = this.normalizeId(refOrLocatorOrId);
    const found = await this.findArtifactPath(artifactId);
    if (!found) {
      return null;
    }

    if (fsSync.existsSync(found.metaPath)) {
      try {
        const raw = await fs.readFile(found.metaPath, "utf-8");
        return JSON.parse(raw) as SpillArtifactInfo;
      } catch {
        // fallback to stat
      }
    }

    const stat = await fs.stat(found.txtPath);
    const content = await fs.readFile(found.txtPath, "utf-8");
    return {
      id: artifactId,
      locator: `tool-result://${artifactId}`,
      sessionId: found.sessionId,
      bytes: stat.size,
      chars: content.length,
      createdAt: stat.birthtimeMs || stat.mtimeMs,
    };
  }

  async delete(refOrLocatorOrId: string | SpillRef): Promise<boolean> {
    const artifactId = this.normalizeId(refOrLocatorOrId);
    const found = await this.findArtifactPath(artifactId);
    if (!found) {
      return false;
    }

    try {
      await fs.unlink(found.txtPath);
      if (fsSync.existsSync(found.metaPath)) {
        await fs.unlink(found.metaPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  async list(sessionId?: string): Promise<SpillArtifactInfo[]> {
    const spillRoot = this.getSpillRoot();
    if (!fsSync.existsSync(spillRoot)) {
      return [];
    }

    const result: SpillArtifactInfo[] = [];
    const sessionDirs = sessionId
      ? [sessionId]
      : await fs.readdir(spillRoot);

    for (const sDir of sessionDirs) {
      const sPath = path.join(spillRoot, sDir);
      if (!fsSync.existsSync(sPath)) {
        continue;
      }
      const files = await fs.readdir(sPath);
      for (const file of files) {
        if (file.endsWith(".meta.json")) {
          try {
            const raw = await fs.readFile(path.join(sPath, file), "utf-8");
            result.push(JSON.parse(raw) as SpillArtifactInfo);
          } catch {
            // ignore corrupted meta
          }
        }
      }
    }

    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getSessionBytes(sessionId: string): Promise<number> {
    const sessionDir = this.getSessionDir(sessionId);
    if (!fsSync.existsSync(sessionDir)) {
      return 0;
    }

    let total = 0;
    const files = await fs.readdir(sessionDir);
    for (const f of files) {
      if (f.endsWith(".txt")) {
        const stat = await fs.stat(path.join(sessionDir, f));
        total += stat.size;
      }
    }
    return total;
  }

  async getGlobalBytes(): Promise<number> {
    const spillRoot = this.getSpillRoot();
    if (!fsSync.existsSync(spillRoot)) {
      return 0;
    }

    let total = 0;
    const sessionDirs = await fs.readdir(spillRoot);
    for (const sDir of sessionDirs) {
      const sPath = path.join(spillRoot, sDir);
      const stat = await fs.stat(sPath);
      if (stat.isDirectory()) {
        const files = await fs.readdir(sPath);
        for (const f of files) {
          if (f.endsWith(".txt")) {
            const fileStat = await fs.stat(path.join(sPath, f));
            total += fileStat.size;
          }
        }
      }
    }
    return total;
  }
}
