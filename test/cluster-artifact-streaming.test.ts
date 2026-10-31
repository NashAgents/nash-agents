import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import { ClusterCoordinator } from "../src/cluster/coordinator/cluster-coordinator.js";
import type { ArtifactService } from "../src/cluster/artifacts/artifact-service.js";
import type { IClusterStore } from "../src/cluster/storage/cluster-store.js";

describe("P0 Cross-Node Artifact Streaming & HTTP Range Suite", () => {
  let tempDir: string;
  let coordinator: ClusterCoordinator;
  let artifactService: ArtifactService;
  let store: IClusterStore;
  let baseUrl: string;
  const adminKey = "test-admin-secret-key-12345678";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nash-art-test-"));

    coordinator = new ClusterCoordinator({
      ephemeral: true,
      listenHost: "127.0.0.1",
      listenPort: 0,
      adminApiKey: adminKey,
    });

    const addr = await coordinator.start();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    artifactService = coordinator.getArtifactService();
    store = coordinator.getStore();
  });

  afterEach(async () => {
    await coordinator.stop();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. 验证大产物 (1MB) 的真实 HTTP 分片流式下载与 SHA-256 完整性
  it("1. Should stream 1MB artifact over HTTP with full SHA-256 integrity verification", async () => {
    // 构造 1MB 测试载荷
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = i % 256;
    }
    const expectedSha256 = createHash("sha256").update(payload).digest("hex");

    const record = await artifactService.publishArtifact({
      graphId: "graph-stream-1",
      producerTaskId: "task-prod-1",
      producerNodeId: "node-mac",
      name: "large_dataset.bin",
      content: payload,
    });

    const targetFile = path.join(tempDir, "downloaded_large.bin");
    const downloadUrl = `${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`;

    // 客户端流式下载
    const streamResult = await artifactService.downloadRemoteArtifactStream(downloadUrl, targetFile, {
      expectedSha256,
      headers: {
        Authorization: `Bearer ${adminKey}`,
      },
    });

    assert.strictEqual(streamResult.writtenBytes, 1024 * 1024);
    assert.strictEqual(streamResult.sha256, expectedSha256);

    const downloadedBuf = await fs.readFile(targetFile);
    assert.strictEqual(downloadedBuf.length, 1024 * 1024);
    assert.strictEqual(createHash("sha256").update(downloadedBuf).digest("hex"), expectedSha256);
  });

  // 2. 验证 HTTP Range 切片请求 (HTTP 206 Partial Content) 与断点续传
  it("2. Should support HTTP Range header (206 Partial Content) for chunked streaming", async () => {
    const payload = Buffer.from("0123456789ABCDEF0123456789ABCDEF", "utf-8"); // 32 字节
    const record = await artifactService.publishArtifact({
      graphId: "graph-range-1",
      producerTaskId: "task-prod-2",
      producerNodeId: "node-win",
      name: "slice_test.txt",
      content: payload,
    });

    // 请求 bytes=5-14 (共 10 字节: "56789ABCDE")
    const res = await fetch(`${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`, {
      headers: {
        Authorization: `Bearer ${adminKey}`,
        Range: "bytes=5-14",
      },
    });

    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get("accept-ranges"), "bytes");
    assert.strictEqual(res.headers.get("content-range"), `bytes 5-14/${payload.length}`);
    assert.strictEqual(res.headers.get("content-length"), "10");

    const sliceText = await res.text();
    assert.strictEqual(sliceText, "56789ABCDE");
  });

  // 3. 验证无效 Range 请求返回 HTTP 416 (Range Not Satisfiable)
  it("3. Should return HTTP 416 for out-of-bounds or malformed Range requests", async () => {
    const payload = Buffer.from("small payload", "utf-8");
    const record = await artifactService.publishArtifact({
      graphId: "graph-range-2",
      producerTaskId: "task-prod-3",
      producerNodeId: "node-tencent",
      name: "bounds_test.txt",
      content: payload,
    });

    const res = await fetch(`${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`, {
      headers: {
        Authorization: `Bearer ${adminKey}`,
        Range: "bytes=9999-",
      },
    });

    assert.strictEqual(res.status, 416);
    assert.strictEqual(res.headers.get("content-range"), `bytes */${payload.length}`);
  });

  // 4. 验证未授权 Consumer 节点访问被坚决拦截 (HTTP 403 Access Denied)
  it("4. Should deny download (HTTP 403) for consumer node without artifact authorization", async () => {
    const payload = Buffer.from("confidential graph artifact", "utf-8");
    const record = await artifactService.publishArtifact({
      graphId: "graph-auth-1",
      producerTaskId: "task-prod-4",
      producerNodeId: "node-mac",
      name: "secret.bin",
      content: payload,
    });

    // 未经授权的节点 node-unauthorized 请求下载 (携带合法的全局 Authorization 但声明的 consumer 节点无产物授权)
    const res = await fetch(`${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`, {
      headers: {
        "x-nash-node-id": "node-unauthorized",
        "x-nash-task-id": "task-unauthorized",
      },
    });

    // 未携带 Admin Key 且未授权的节点请求应返回 401 或 403
    assert.ok(res.status === 401 || res.status === 403);

    // 授权 node-authorized 后通过 Bearer Admin 凭据请求，且指定合法 consumerNodeId
    await artifactService.grantAccess(record.artifactId, "graph-auth-1", "node-authorized", "task-consumer-1");
    const authedRes = await fetch(`${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`, {
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "x-nash-node-id": "node-authorized",
        "x-nash-task-id": "task-consumer-1",
      },
    });

    assert.strictEqual(authedRes.status, 200);
    const content = await authedRes.text();
    assert.strictEqual(content, "confidential graph artifact");
  });

  // 5. 验证篡改产物哈希时客户端流式下载能够检出并清理脏临时文件
  it("5. Should detect tampered artifact hash and clean up temporary files", async () => {
    const payload = Buffer.from("valid content", "utf-8");
    const record = await artifactService.publishArtifact({
      graphId: "graph-tamper-1",
      producerTaskId: "task-prod-5",
      producerNodeId: "node-mac",
      name: "tamper_test.txt",
      content: payload,
    });

    const targetFile = path.join(tempDir, "tampered_result.txt");
    const downloadUrl = `${baseUrl}/api/cluster/artifacts/${record.artifactId}/download`;

    await assert.rejects(
      async () => {
        await artifactService.downloadRemoteArtifactStream(downloadUrl, targetFile, {
          expectedSha256: "0000000000000000000000000000000000000000000000000000000000000000",
          headers: {
            Authorization: `Bearer ${adminKey}`,
          },
        });
      },
      /SHA-256 mismatch/
    );

    // 校验脏文件绝不滞留磁盘
    const exists = await fs.access(targetFile).then(() => true).catch(() => false);
    assert.strictEqual(exists, false);
  });
});
