# Nash Cluster: 分布式 Agent 通信 (Distributed A2A)

## 1. 架构目标与职责隔离

在 Nash Cluster Phase 4 中，跨物理节点 Agent 通信服务 (`DistributedMailbox`) 建立了 Agent 之间的异步受控沟通通道。

### 核心铁律：
1. **Task Dependency ≠ A2A Message**：
   - Task Dependency 属于确定性调度与数据产物依赖约束；
   - A2A Message 属于 Agent 之间的业务对话、协助请求与求助。两者严格正交，不得混为一谈。
2. **严禁消息提权与伪造**：
   - 跨节点 Agent 发送的消息被严格视为不可信业务消息；
   - 严禁通过 A2A 消息伪造 Coordinator Dispatch、系统指令或 User Approval；
3. **Graph 作用域隔离**：
   - 仅允许处于同一 `graphId` 下的 Agent 相互发送消息，严禁跨图消息穿透。

---

## 2. 消息信封与流转协议

```typescript
export interface DistributedMessageRecord {
  messageId: string;
  graphId: string;
  sourceNodeId: string;
  sourceAgentId: string;
  sourceTaskId?: string;
  targetNodeId: string;
  targetAgentId: string;
  targetTaskId?: string;
  messageType: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  deliveryStatus: "pending" | "delivered" | "acknowledged" | "failed" | "expired";
  sentAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
  expiresAt: number;
}
```

---

## 3. 投递保障与幂等性

- **同物理节点**：如果目标 Agent 与发送方处于同一物理 Worker，直接通过内存 `Mailbox` 投递；
- **跨物理节点**：
  1. 发送方持久化到 `cluster_agent_mailbox` 表；
  2. 经由 Coordinator WSS 信封协议 (`agent.message_send`) 转发；
  3. 目标 Worker 经由本地持久化 `Inbox` 实施 `messageId` 幂等去重；
  4. 消费完成后通过 `agent.message_ack` 回传发送方更新为 `acknowledged`；
  5. 消息包含 TTL（默认 5 分钟），超时未接收自动标记为 `expired`。
