# Nash Cluster 节点身份与安全配对规范

## 1. 节点身份 (Node Identity)

每个 Nash 节点均具有全局唯一的不可伪造身份标识：
- **Node ID 格式**：`node-<hostname>-<fingerprint>`（如 `node-example-cloud` 或 `node-example-wsl`）；
- **持久化位置**：本地 `~/.nash-agents/cluster-identity.json`，文件权限强制收紧为 `0600`（仅当前系统用户可读写）；
- **节点持久 Token**：配对成功后由 Coordinator 签发的高熵安全令牌（`ntk_<base64url>`），本地明文存储，Coordinator 数据库端仅存储 `SHA-256` 单向哈希摘要，杜绝服务端泄露长期明文。

---

## 2. 一次性安全配对流程 (Invite Pairing Flow)

为避免节点无门槛加入集群，引入短期单次邀请码机制：

```text
  Coordinator (管理员)                     Worker (新节点)
          │                                     │
   1. 创建邀请码                                  │
      nash cluster invite                       │
      (生成 nash-inv-xxxx, TTL 24h, maxUses: 1)  │
          │                                     │
          ├───────────── 分发凭据 ──────────────┤
          │                                     │
          │                                2. 发起配对
          │                                   nash node join <url> <invite>
          │                                     │
          │◀────── node.hello (带 invite) ──────┤
          │                                     │
   3. 校验并消费邀请码                              │
      - 检查未过期 (TTL)                         │
      - 检查未超额 (maxUses)                     │
      - 签发持久 Token                            │
      - 记录至 cluster_nodes 数据库               │
          │                                     │
          ├───── node.authenticated (带 Token) ─▶│
          │                                     │
          │                                4. 持久化存储
          │                                   写入 ~/.nash-agents/cluster-identity.json
          │                                     │
          │◀────────── node.heartbeat ──────────┤ (后续长久在线)
```

---

## 3. 节点权限撤销 (Revocation)

管理员可通过 CLI 或 API 随时撤销不受信节点的集群凭证：

```bash
nash cluster nodes revoke <node-id>
```

- **即时生效**：Coordinator 会在内存连接表中立即切断其活跃 WebSocket 并发送 `4003 Node access revoked`；
- **持久标记**：在 PostgreSQL 数据库中将该节点标记为 `status = 'revoked'`，后续该 Token 发起的任何握手均被坚决拒绝。
