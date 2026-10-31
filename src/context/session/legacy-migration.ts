import { resolveNashHome } from "../../config/data-home.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProjectContext } from "../../project/project-context.js";
import type { SessionRecord } from "../types.js";

export interface LegacyMigrationDetail {
  sessionId: string;
  status: "migrated" | "skipped" | "failed";
  projectRoot?: string;
  reason?: string;
}

export interface LegacyMigrationReport {
  total: number;
  migrated: number;
  skipped: number;
  failed: number;
  details: LegacyMigrationDetail[];
}

export interface LegacyMigrationOptions {
  nashHome?: string;
}

/**
 * 分析单个 session.jsonl 文件中是否包含可信且本地真实存在的 projectRoot / cwd
 */
async function extractReliableProjectRoot(
  sessionJsonlPath: string
): Promise<string | null> {
  if (!fsSync.existsSync(sessionJsonlPath)) {
    return null;
  }

  try {
    const raw = await fs.readFile(sessionJsonlPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as SessionRecord;
        const meta =
          "metadata" in record
            ? (record.metadata as Record<string, unknown> | undefined)
            : undefined;
        if (meta) {
          const candidate =
            (typeof meta.projectRoot === "string" && meta.projectRoot) ||
            (typeof meta.workspaceRoot === "string" && meta.workspaceRoot) ||
            (typeof meta.cwd === "string" && meta.cwd);

          if (candidate && path.isAbsolute(candidate) && fsSync.existsSync(candidate)) {
            const stat = await fs.stat(candidate);
            if (stat.isDirectory()) {
              return candidate;
            }
          }
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * 迁移全局 legacy session (~/.nash/context/sessions/) 到各自的 Project Namespace 下
 * 仅迁移具有绝对可靠 projectRoot 的 session，不可靠或无归属的 session 100% 完好保留
 */
export async function migrateLegacySessions(
  options?: LegacyMigrationOptions
): Promise<LegacyMigrationReport> {
  const nashHome = options?.nashHome ?? resolveNashHome();
  const legacySessionsRoot = path.join(nashHome, "context", "sessions");

  const report: LegacyMigrationReport = {
    total: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  if (!fsSync.existsSync(legacySessionsRoot)) {
    return report;
  }

  const entries = await fs.readdir(legacySessionsRoot);
  const sessionDirs: string[] = [];
  for (const entry of entries) {
    const p = path.join(legacySessionsRoot, entry);
    const stat = await fs.stat(p);
    if (stat.isDirectory()) {
      sessionDirs.push(entry);
    }
  }

  report.total = sessionDirs.length;

  for (const sessionId of sessionDirs) {
    const sessionDir = path.join(legacySessionsRoot, sessionId);
    const jsonlPath = path.join(sessionDir, "session.jsonl");

    try {
      const reliableProjectRoot = await extractReliableProjectRoot(jsonlPath);

      if (!reliableProjectRoot) {
        report.skipped++;
        report.details.push({
          sessionId,
          status: "skipped",
          reason: "未在 session 记录中发现可信的 projectRoot 元数据，已作为 legacy 保留",
        });
        continue;
      }

      // 获取目标项目的 ProjectContext
      const targetProjectContext = await resolveProjectContext({
        projectRoot: reliableProjectRoot,
        nashHome,
      });

      const destSessionDir = path.join(
        targetProjectContext.sessionsDir,
        sessionId
      );

      if (fsSync.existsSync(destSessionDir)) {
        report.skipped++;
        report.details.push({
          sessionId,
          status: "skipped",
          projectRoot: reliableProjectRoot,
          reason: "目标 project sessions 目录下已存在同名 session",
        });
        continue;
      }

      // 执行迁移
      try {
        await fs.rename(sessionDir, destSessionDir);
      } catch (err: unknown) {
        const nodeErr = err as { code?: string };
        if (nodeErr && nodeErr.code === "EXDEV") {
          await fs.mkdir(destSessionDir, { recursive: true });
          const files = await fs.readdir(sessionDir);
          for (const file of files) {
            await fs.copyFile(
              path.join(sessionDir, file),
              path.join(destSessionDir, file)
            );
          }
          await fs.rm(sessionDir, { recursive: true, force: true });
        } else {
          throw err;
        }
      }

      report.migrated++;
      report.details.push({
        sessionId,
        status: "migrated",
        projectRoot: reliableProjectRoot,
      });
    } catch (err: unknown) {
      report.failed++;
      report.details.push({
        sessionId,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
