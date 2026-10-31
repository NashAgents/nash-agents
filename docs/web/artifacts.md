# Nash Web Control Plane: 产物中心与内容预览规范 (Artifacts)

## 1. 产物资产体系 (Artifacts Center)

产物中心 (`/artifacts`) 是 Nash 分布式任务图执行产出的聚合交换与验收空间。每个产物具备唯一的 `artifactId` 与 SHA-256 内容完整性哈希。

---

## 2. API 端点契约

| 方法 | 端点 | 说明 |
| :--- | :--- | :--- |
| `GET` | `/api/cluster/artifacts` | 获取产物全量列表，支持按 `graphId` 与 `nodeId` 筛选 |
| `GET` | `/api/cluster/artifacts/:id` | 获取单个产物的结构化元数据详情 |
| `GET` | `/api/cluster/artifacts/:id/content` | 安全预览产物内容（带文本大小截断保护） |
| `GET` | `/api/cluster/artifacts/:id/download` | 安全流式下载原始文件 |

---

## 3. 安全防护与流式传输

### 3.1 路径逃逸与符号链接防御
所有产物读写统一收口至 Coordinator 的 `ArtifactService`：
- 使用 `fs.realpathSync` 物理递归解析目标路径。
- 校验物理真实路径是否严格闭合在 `storageDir` 白名单内。
- 拦截包含 `../`、空字节或危险符号的恶意请求。

### 3.2 预览溢出保护 (Truncation Defense)
- 对于文本型产物（如 JSON、Markdown、TXT），预览接口在内存中读取上限为 100 KB。
- 超过 100 KB 自动截断并在响应体中标记 `truncated: true`，防止超大文件把前端渲染器撑爆。

### 3.3 安全流式下载
- 响应头配置：
  ```http
  Content-Disposition: attachment; filename="[filename]"
  X-Artifact-Sha256: [sha256]
  Cache-Control: private, no-transform
  ```
- 采用管道流式传输 (`createReadStream.pipe(res)`)，避免大文件一次性常驻 Node.js 堆内存。
- 客户端下载后可通过响应头携带的 `X-Artifact-Sha256` 进行本地哈希二次校对，确保传输零篡改。
