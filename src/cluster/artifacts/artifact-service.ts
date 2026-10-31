import { resolveNashHome } from "../../config/data-home.js";
import { observeGraphPhase } from "../graph/runtime-tracing.js";
import { observeRuntimePhase } from "../../observability/runtime-phase.js";
/**
 * Artifact Exchange Service (Phase 4)
 * 跨节点持久化产物存储、流式安全传输、SHA256 完整性校验与访问控制服务
 * 严格防范 ../ 目录逃逸、软链接注入、大文件内存爆仓与越权访问
 */

import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { IClusterStore } from "../storage/cluster-store.js";
import { GoalTurnFenceError } from "../storage/goal-turn-fence.js";

export interface PublishArtifactInput {
  graphId: string;
  producerTaskId: string;
  producerNodeId: string;
  name: string;
  contentType?: string;
  content: string | Buffer;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
}

export interface ArtifactRecord {
  artifactId: string;
  graphId: string;
  producerTaskId?: string;
  producerNodeId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  status: "pending" | "available" | "consumed" | "expired" | "deleted";
  metadata?: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
}

export class ArtifactStorageError extends Error {
  constructor(message: string) { super(message); this.name = "ArtifactStorageError"; }
}

export class ArtifactService {
  private readonly baseStorageDir: string;
  public static readonly CHUNK_SIZE_BYTES = 256 * 1024; // 256KB 分片

  constructor(
    private readonly store: IClusterStore,
    customBaseDir?: string
  ) {
    this.baseStorageDir = customBaseDir ?? path.join(resolveNashHome(), "cluster", "artifacts");
    if (!fs.existsSync(this.baseStorageDir)) {
      fs.mkdirSync(this.baseStorageDir, { recursive: true, mode: 0o700 });
    }
    this.baseStorageDir = fs.realpathSync.native(this.baseStorageDir);
  }

  /**
   * 安全清理文件名，阻断 ../ 与危险符号
   */
  private sanitizeFilename(rawName: string): string {
    const base = path.basename(rawName.trim());
    const sanitized = base.replace(/[^a-zA-Z0-9._\-]/g, "_");
    if (!sanitized || sanitized === "." || sanitized === "..") {
      return `artifact_${Date.now()}`;
    }
    return sanitized;
  }

  /**
   * 发布/持久化产物
   */
  async publishArtifact(input: PublishArtifactInput): Promise<ArtifactRecord> {
    return observeGraphPhase(this.store, input.graphId, "artifact_publication", async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.graphId)) throw new ArtifactStorageError("Invalid graph ID");
    const safeName = this.sanitizeFilename(input.name);
    const graphDirectory = path.join(this.baseStorageDir, input.graphId);
    if (fs.existsSync(graphDirectory) && fs.lstatSync(graphDirectory).isSymbolicLink()) throw new ArtifactStorageError("Artifact graph directory cannot be a symbolic link");
    fs.mkdirSync(graphDirectory, { recursive: true, mode: 0o700 });
    this.assertStoragePath(graphDirectory);
    const artifactId = `art-${crypto.randomUUID().slice(0, 10)}`;
    const graphArtifactsDir = path.join(this.baseStorageDir, input.graphId, artifactId);

    if (!fs.existsSync(graphArtifactsDir)) {
      fs.mkdirSync(graphArtifactsDir, { recursive: true, mode: 0o700 });
    }

    const targetFilePath = path.join(graphArtifactsDir, safeName);

    // 写入物理文件并计算 SHA256
    const dataBuffer = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : input.content;
    const sha256 = crypto.createHash("sha256").update(dataBuffer).digest("hex");
    fs.writeFileSync(targetFilePath, dataBuffer, { mode: 0o600, flag: "wx" });

    const now = Date.now();
    const expiresAt = input.ttlMs ? now + input.ttlMs : undefined;

    const record: ArtifactRecord = {
      artifactId,
      graphId: input.graphId,
      producerTaskId: input.producerTaskId,
      producerNodeId: input.producerNodeId,
      name: safeName,
      contentType: input.contentType ?? "text/plain",
      sizeBytes: dataBuffer.byteLength,
      sha256,
      storagePath: targetFilePath,
      status: "available",
      metadata: input.metadata,
      createdAt: now,
      expiresAt,
    };

    // 保存到集群持久化存储
    try { await this.store.saveArtifact?.(record); }
    catch (error) {
      // A rejected fence is known not to have committed. Other storage errors may
      // have an ambiguous commit outcome, so their files must remain recoverable.
      if (error instanceof GoalTurnFenceError) fs.rmSync(graphArtifactsDir, { recursive: true, force: true });
      throw error;
    }

    return record;
    });
  }

  /**
   * 获取产物元数据
   */
  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const record = await this.store.getArtifact?.(artifactId);
    return record ?? null;
  }

  /**
   * 读取产物完整内容（带权限与哈希二次校验）
   */
  async readArtifactContent(artifactId: string, consumerNodeId: string, consumerTaskId?: string): Promise<{ record: ArtifactRecord; data: Buffer }> {
    const { record, handle } = await this.openVerifiedArtifact(artifactId, consumerNodeId, consumerTaskId);
    try {
      const data = await handle.readFile();
      if (data.length !== record.sizeBytes || crypto.createHash("sha256").update(data).digest("hex") !== record.sha256) throw new ArtifactStorageError("Artifact changed during read");
      return { record, data };
    }
    finally { await handle.close(); }
  }

  async openVerifiedArtifact(artifactId: string, consumerNodeId: string, consumerTaskId?: string): Promise<{ record: ArtifactRecord; handle: FileHandle }> {
    const record = await this.getArtifact(artifactId);
    if (!record) throw new ArtifactStorageError(`Artifact '${artifactId}' not found`);
    if (record.status !== "available" || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) throw new ArtifactStorageError("Artifact is unavailable or expired");
    if (this.store.hasArtifactAccess && record.producerNodeId !== consumerNodeId && !await this.store.hasArtifactAccess(artifactId, consumerNodeId, consumerTaskId)) {
      throw new ArtifactStorageError(`Access denied: node '${consumerNodeId}' is not authorized to access artifact '${artifactId}'`);
    }
    const real = await fs.promises.realpath(record.storagePath);
    this.assertStoragePath(real);
    const handle = await fs.promises.open(real, "r");
    try {
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      if (hash.digest("hex") !== record.sha256 || position !== record.sizeBytes) throw new ArtifactStorageError("Artifact Integrity Error: SHA256 or size mismatch");
      return { record, handle };
    } catch (error) { await handle.close(); throw error; }
  }

  /**
   * 产物分片流式读取
   */
  async readArtifactChunk(
    artifactId: string,
    chunkIndex: number,
    chunkSize = ArtifactService.CHUNK_SIZE_BYTES
  ): Promise<{
    chunkIndex: number;
    totalChunks: number;
    dataBase64: string;
    isLast: boolean;
    sha256Part: string;
  }> {
    const record = await this.getArtifact(artifactId);
    if (!record || !fs.existsSync(record.storagePath)) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 1024 * 1024) throw new ArtifactStorageError("Invalid artifact chunk range");
    const realPath = fs.realpathSync(record.storagePath);
    this.assertStoragePath(realPath);
    const fd = fs.openSync(realPath, "r");
    const buffer = Buffer.alloc(chunkSize);
    const offset = chunkIndex * chunkSize;
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
    fs.closeSync(fd);

    const actualBuffer = buffer.subarray(0, bytesRead);
    const totalChunks = Math.ceil(record.sizeBytes / chunkSize) || 1;
    const isLast = chunkIndex >= totalChunks - 1;
    const sha256Part = crypto.createHash("sha256").update(actualBuffer).digest("hex");

    return {
      chunkIndex,
      totalChunks,
      dataBase64: actualBuffer.toString("base64"),
      isLast,
      sha256Part,
    };
  }

  private assertStoragePath(target: string): void {
    const relative = path.relative(this.baseStorageDir, fs.realpathSync.native(target));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ArtifactStorageError("Artifact path escapes base storage directory");
    }
  }

  /**
   * 按需分片流式下载产物至指定物理文件，带逐块 SHA-256 实时校验
   */
  async streamArtifactToDisk(
    artifactId: string,
    targetFilePath: string,
    chunkSize = ArtifactService.CHUNK_SIZE_BYTES
  ): Promise<{ writtenBytes: number; sha256: string }> {
    const record = await this.getArtifact(artifactId);
    if (!record || !fs.existsSync(record.storagePath)) {
      throw new Error(`Artifact '${artifactId}' not found.`);
    }

    const targetDir = path.dirname(targetFilePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    const realTargetDir = fs.realpathSync(targetDir);
    const resolvedTarget = path.join(realTargetDir, path.basename(targetFilePath));

    const totalChunks = Math.ceil(record.sizeBytes / chunkSize) || 1;
    const outFd = fs.openSync(resolvedTarget, "w", 0o600);
    const hasher = crypto.createHash("sha256");
    let totalWritten = 0;

    try {
      for (let i = 0; i < totalChunks; i++) {
        const chunk = await this.readArtifactChunk(artifactId, i, chunkSize);
        const buf = Buffer.from(chunk.dataBase64, "base64");
        hasher.update(buf);
        fs.writeSync(outFd, buf, 0, buf.length, totalWritten);
        totalWritten += buf.length;
      }
    } finally {
      fs.closeSync(outFd);
    }

    const computedSha = hasher.digest("hex");
    if (computedSha !== record.sha256) {
      fs.unlinkSync(resolvedTarget);
      throw new ArtifactStorageError(`Artifact streaming verification failed: expected ${record.sha256}, got ${computedSha}`);
    }

    return { writtenBytes: totalWritten, sha256: computedSha };
  }

  /**
   * 授权消费者节点/任务读取产物
   */
  async grantAccess(
    artifactId: string,
    graphId: string,
    consumerNodeId: string,
    consumerTaskId?: string
  ): Promise<void> {
    await this.store.grantArtifactAccess?.(artifactId, graphId, consumerNodeId, consumerTaskId);
  }

  /**
   * 通过 HTTP/HTTPS 远程认证流式下载产物至本地磁盘，逐块计算并校验 SHA-256，原子落盘
   */
  async downloadRemoteArtifactStream(
    downloadUrl: string,
    targetFilePath: string,
    options?: {
      expectedSha256?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      rangeStart?: number;
      rangeEnd?: number;
    }
  ): Promise<{ writtenBytes: number; sha256: string }> {
    const targetDir = path.dirname(targetFilePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }

    const tempFile = `${targetFilePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const hasher = crypto.createHash("sha256");
    let totalWritten = 0;

    const reqHeaders: Record<string, string> = {
      ...(options?.headers || {}),
    };

    if (options?.rangeStart !== undefined) {
      const endPart = options.rangeEnd !== undefined ? options.rangeEnd : "";
      reqHeaders["Range"] = `bytes=${options.rangeStart}-${endPart}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeoutMs ?? 60000);

    try {
      const response = await fetch(downloadUrl, {
        method: "GET",
        headers: reqHeaders,
        signal: controller.signal,
      });

      controller.signal.throwIfAborted();

      if (!response.ok && response.status !== 206) {
        throw new ArtifactStorageError(
          `Remote artifact download failed with HTTP ${response.status} ${response.statusText}`
        );
      }

      if (!response.body) {
        throw new ArtifactStorageError("Remote artifact download returned empty response body");
      }

      const reader = response.body.getReader();
      let outFd: number | undefined;
      const cancelReader = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      try {
        outFd = fs.openSync(tempFile, "wx", 0o600);
        controller.signal.throwIfAborted();
        while (true) {
          const { done, value } = await reader.read();
          controller.signal.throwIfAborted();
          if (done) break;
          if (value && value.length > 0) {
            hasher.update(value);
            fs.writeSync(outFd, value, 0, value.length, totalWritten);
            totalWritten += value.length;
          }
        }
      } finally {
        controller.signal.removeEventListener("abort", cancelReader);
        // Cancellation of a broken peer must not extend the transfer deadline.
        cancelReader();
        reader.releaseLock();
        if (outFd !== undefined) fs.closeSync(outFd);
      }

      const computedSha = hasher.digest("hex");
      if (options?.expectedSha256 && computedSha !== options.expectedSha256) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        throw new ArtifactStorageError(
          `Artifact SHA-256 mismatch: expected ${options.expectedSha256}, calculated ${computedSha}`
        );
      }

      // 原子性移动就位
      fs.renameSync(tempFile, targetFilePath);
      return { writtenBytes: totalWritten, sha256: computedSha };
    } catch (err) {
      clearTimeout(timeout);
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
      throw err;
    } finally { clearTimeout(timeout); }
  }

}
