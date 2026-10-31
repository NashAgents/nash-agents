# Nash Web Control Plane: 实时事件流与 SSE 协议 (Realtime Events)

## 1. 协议选型与架构决策

为了确保在复杂网络、代理中转（Nginx / Cloudflare）以及弱网移动设备下的长连接稳定性，Nash 选用 **Server-Sent Events (SSE)** 作为从集群 Coordinator 向 Web 控制台的实时事件通道：

- **单向只读流**：服务端推送到客户端，避免无意义的客户端 Ping-Pong 开销。
- **天然文本协议**：无缝穿透企业级防火墙与 HTTP/2 多路复用。
- **自动重连与续传**：基于浏览器原生的 `Last-Event-ID` 机制。

---

## 2. SSE 端点规范

- **URL**：`GET /api/cluster/events/stream`
- **请求头**：
  - `Accept: text/event-stream`
  - `Cookie: nash_session=...`
  - `Last-Event-ID: [seq]` (可选，断线重连时携带)
- **响应头**：
  - `Content-Type: text/event-stream`
  - `Cache-Control: no-cache`
  - `Connection: keep-alive`
  - `X-Accel-Buffering: no` (禁用 Nginx 缓冲区，确保事件实时吐出)

---

## 3. 标准事件序列规范

### 3.1 集群快照 (cluster.snapshot)
连接刚建立或节点状态发生重大变化时下发：
```text
event: cluster.snapshot
data: {"onlineNodes":3,"totalNodes":4,"runningTasks":2,"pendingApprovals":0,"activeGraphs":1,"timestamp":1792122626163}
```

### 3.2 节点拓扑事件
- `node.connected`：新节点上线。
- `node.heartbeat`：节点周期心跳上报。
- `node.disconnected`：节点超时离线。

### 3.3 任务执行流事件
- `task.status`：任务状态跃迁 (`running` / `completed` / `failed` / `cancelled`)。
- `task.output`：任务流式输出增量。

### 3.4 任务图事件
- `graph.status`：任务图全局状态变化。
- `graph.node_status`：DAG 内部某个节点状态变更。
- `graph.artifact_published`：上游节点成功发布新产物。

### 3.5 心跳保活
服务端每隔 15 秒发送一次注释行心跳，防止连接被中间网关挂断：
```text
: heartbeat
```

---

## 4. 前端 SSE 客户端管理器 (`src/services/sse.ts`)

- 单例模式，随登录成功自动激活，随用户登出主动断开。
- 提供订阅总线：`on(event, handler)`、`off(event, handler)`。
- 内置指数退避重连算法（初始 1 秒，每次翻倍，上限 30 秒，附加随机抖动 Jitter）。
- 将接收到的事件无缝分发至 Pinia 状态中枢，驱动各视图 UI 响应式自更新。
