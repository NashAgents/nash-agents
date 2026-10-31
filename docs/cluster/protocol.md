# Nash Cluster 通信协议规范 (Protocol v1.0)

## 1. 统一信封模型 (Envelope Specification)

所有通过 WebSocket 传输的数据载荷必须严格封装在标准 `ClusterEnvelope` 结构中：

```typescript
export interface ClusterEnvelope<T = unknown> {
  protocolVersion: "1.0";
  messageId: string;         // 唯一消息 ID，如 msg-xxxx
  correlationId?: string;    // 关联的请求消息 ID
  sourceNodeId: string;      // 消息发送方节点 ID
  targetNodeId: string;      // 消息目标节点 ID
  timestamp: number;         // 毫秒级时间戳
  type: ClusterMessageType;  // 消息类型标识
  payload: T;                // 具体业务载荷
}
```

### 安全与防洪保护：
- **最大消息上限**：硬编码限制单条报文不得超出 `1,048,576 字节 (1MB)`。超大结果通过 `SpillStore` 落盘，协议中仅传递定位引用；
- **防篡改与注入**：严格校验 `JSON.parse` 结果，拦截原型链污染与字段缺失，非法结构坚决抛出强类型 `ProtocolError`。

---

## 2. 协议消息类型全景

| 消息类型 | 方向 | 职责描述 |
| :--- | :--- | :--- |
| `node.hello` | Worker $\to$ Coord | 客户端连接建立后发起身份握手与能力元数据上报 |
| `node.authenticated` | Coord $\to$ Worker | 握手验证通过，返回代际（Generation）与心跳周期参数 |
| `node.rejected` | Coord $\to$ Worker | 握手失败，通知拒绝原因（Token 无效、邀请码失效等） |
| `node.heartbeat` | Worker $\to$ Coord | 定时心跳保活上报（默认 10s） |
| `node.heartbeat_ack` | Coord $\to$ Worker | 心跳回执，校准集群物理时间 |
| `task.dispatch` | Coord $\to$ Worker | 可靠任务派发指令，附带目标项目 ID 与目标 Prompt |
| `task.accepted` | Worker $\to$ Coord | Worker 确认接收任务，准备拉起 AgentLoop |
| `task.rejected` | Worker $\to$ Coord | Worker 拒绝任务（项目未授权、沙箱不可用等） |
| `task.started` | Worker $\to$ Coord | AgentLoop 启动事件 |
| `task.progress` | Worker $\to$ Coord | 步骤与活动摘要进度上报 |
| `task.completed` | Worker $\to$ Coord | 任务终态完成，回传最终结论与产物清单 |
| `task.failed` | Worker $\to$ Coord | 任务失败，回传错误详情与耗时 |
| `task.cancelled` | Worker $\to$ Coord | 任务取消完成通知 |
| `task.control` | Coord $\to$ Worker | 运行时控制下发：`steer` / `interrupt` / `cancel` |
| `task.control_ack` | Worker $\to$ Coord | 控制指令执行回执 |
| `approval.requested` | Worker $\to$ Coord | 远程提权审批挂起请求 |
| `approval.resolved` | Coord $\to$ Worker | 审批决议下发：`allow-once` 或 `deny` |
| `event.batch` | Worker $\to$ Coord | 批量上报带单调递增序号（seq）的执行事件 |
| `event.ack` | Coord $\to$ Worker | 事件接收确认回执（更新 `lastAckedSeq`） |

---

## 3. 连接代际与重连状态机

每个节点在 Coordinator 处维护递增的 `connectionGeneration`：
1. **连接建立**：Worker 发起 WSS 连接并提交 Token；
2. **代际递增**：Coordinator 判定合法后，`generation += 1`。若发现该节点已存在旧 WebSocket 连接，立即向旧连接发送 `4001 Superseded` 并平滑关闭，彻底杜绝两个连接并发争抢同一 Node ID；
3. **心跳探查**：连续 30 秒（3 个心跳周期）未收到心跳，标记节点状态为 `offline`；
4. **断线退避**：Worker 侧检测到连接断开，自动启动指数退避重连（1s $\to$ 2s $\to$ 4s $\to$ 8s $\to$ 15s），附带 $\pm 20\%$ 随机 Jitter，复用原 Node ID 恢复上线。
