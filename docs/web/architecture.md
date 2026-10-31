# Nash Web Control Plane: 架构设计

## 1. 概述与核心定位

Nash Web Control Plane (Nash 跨设备 Web 控制台与分布式 Agent 交互平台) 作为 Nash Cluster 分布式多智能体生态的统一 Web 客户端，负责将分布式节点管理、联邦记忆、语义任务路由、任务图 (DAG) 编排以及跨节点 A2A 协同能力具象化为现代 Web 应用。

系统支持：
- 桌面端 (Desktop, 1280px - 1920px+): 专业三栏工程工作台。
- 平板端 (Tablet, 768px - 1024px): 触控自适应双栏与滑动抽屉。
- 移动端 (Mobile, 320px - 430px): 单栏自适应主视图、沉底导航栏与阶段任务卡片。

---

## 2. 系统整体分层架构

```text
                  用户终端设备 (Desktop / Tablet / Mobile)
                                    │
                                    ▼
                          Vue 3 + Vite SPA 客户端
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
      Pinia 状态中枢           Vue Flow DAG 引擎        SSE 实时流订阅器
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    │ (HTTPS / WSS / SSE)
                                    ▼
                         Nginx 反向代理 (SSL 卸载)
                           (203.0.113.10:18443)
                                    │
                                    ▼
                     Nash Cluster Coordinator (Node.js)
                 (ClusterApiHandler + WssGateway : 18444)
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
      Auth & Session           ArtifactService         Global SSE Broadcaster
   (HttpOnly + CSRF)         (SHA-256 + Stream)          (Last-Event-ID)
           │                        │                        │
           └────────────────────────┼────────────────────────┘
                                    │
                                    ▼
                     PostgreSQL Cluster Store (PG 16)
               (cluster_nodes, cluster_tasks, cluster_graphs,
             cluster_artifacts, cluster_web_conversations, ...)
                                    │
                                    ▼
           ┌────────────────────────┼────────────────────────┐
           │                        │                        │
    Tencent Linux Node          Mac Worker Node         WSL2 Linux Node
  (Coordinator + Worker)      (Darwin / Seatbelt)     (Linux / Bubblewrap)
```

---

## 3. 前后端通信契约

### 3.1 REST API 规范
- 统一前缀：`/api/cluster/` 与 `/api/auth/`
- 标准响应格式：
  ```json
  {
    "success": true,
    "data": { ... }
  }
  ```
- 错误响应格式：
  ```json
  {
    "error": "Error description message"
  }
  ```
  HTTP 状态码严格映射语义：`400 Bad Request`、`401 Unauthorized`、`403 Forbidden`、`404 Not Found`、`500 Internal Error`。

### 3.2 鉴权与安全
- **Cookie 机制**：采用 `HttpOnly; SameSite=Lax; Secure` Session Cookie (`nash_session`)。
- **CSRF 防护**：登录成功时签发随机 CSRF Token，写操作必须携带 `x-csrf-token` 请求头。
- **防止计时攻击**：密码核验采用 `crypto.timingSafeEqual`。

### 3.3 全局 SSE 事件流
- 端点：`GET /api/cluster/events/stream`
- 支持 `Last-Event-ID` 续传与断线指数退避重连。
- 事件类型：
  - `cluster.snapshot`：集群全局快照（在线节点数、运行中任务、待审批数、活跃 DAG）。
  - `node.connected` / `node.heartbeat` / `node.disconnected`：节点拓扑变化。
  - `task.status` / `task.output`：任务流式输出与状态跃迁。
  - `graph.status` / `graph.node_status`：任务图执行与 Join Barrier 汇聚。
  - `approval.requested` / `approval.resolved`：安全审批生命周期。

---

## 4. 前端状态中枢 (Pinia Stores)

1. **`useAuthStore`**：用户登录凭据、CSRF Token、角色权限（admin / operator / viewer）。
2. **`useUiStore`**：响应式视口检测 (`isDesktop` / `isTablet` / `isMobile`)、暗色/亮色主题切换、侧边栏折叠状态。
3. **`useClusterStore`**：集群物理节点列表、在线状态、硬件能力、网络拓扑。
4. **`useWorkspaceStore`**：多轮会话管理、消息列表、当前活跃任务与 DAG 关联。
5. **`useTasksStore`**：任务全量列表、执行过滤、任务详情与流式日志投影。
6. **`useGraphsStore`**：分布式 DAG 数据、拓扑节点、边依赖、阶段快照与 Join Barrier 状态。
7. **`useApprovalsStore`**：待处理审批、单次放行与历史审批追溯。
8. **`useArtifactsStore`**：交付产物资产中心、SHA-256 校验、内容预览与安全流式下载。
