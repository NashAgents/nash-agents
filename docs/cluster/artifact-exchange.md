# Nash Cluster: 跨节点产物交换 (Artifact Exchange)

## 1. 架构目标与设计哲学

在分布式多智能体协同场景中，大量中间产物（如 SRT 字幕文件、项目架构分析 JSON、代码补丁、测试报告）需要在不同物理节点的 Agent 之间传递。

**绝对红线**：
- 严禁将跨节点文件内容直接塞进普通 A2A 消息（防止 WSS 信封撑爆导致网络崩溃）；
- 跨节点文件交换必须经由专用的 `ArtifactService` 统一管理。

---

## 2. 核心数据模型与存储接口

```typescript
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
```

---

## 3. 安全防线体系

### 3.1 路径防穿越与字符清洗
- 文件名强制通过 `path.basename` 与正则表达式 `[^a-zA-Z0-9._\-]` 过滤替换为下划线；
- 严禁任何包含 `../` 的相对路径或绝对路径注入；
- 存储路径基于真实路径二次解析 (`fs.realpathSync`)，一旦超出基础存储目录 (`~/.nash-agents/cluster/artifacts/`，可用 `NASH_HOME` 覆盖) 立即抛出安全违规异常。

### 3.2 SHA256 完整性强校验
- 发布产物时落盘并同步计算 SHA-256 哈希；
- 消费者节点读取产物数据时，在内存与磁盘端重新计算校验和；
- 一旦发生位翻转或截断，立即抛出 `Artifact Integrity Error`，拒绝标记为可用。

### 3.3 严格访问授权白名单 (`cluster_artifact_grants`)
- 仅当 Orchestrator 根据依赖图显式颁发授权（`grantArtifactAccess`）后，下游目标节点与任务方可调用 `readArtifactContent`；
- 未授权节点读取立即阻断并记录审计日志。

### 3.4 流式分片传输 (Chunked Transfer)
- 单分片默认 `256 KB`；
- 支持大文件通过文件描述符与偏移量按需读取分片，杜绝高并发大文件将 Coordinator 内存打爆。
