# Routing Policy: Candidate Ranking & Validation (候选过滤、排序与验证策略)

## 一、双层安全防线架构

Nash Cluster 采用**“软排序引导（Soft Ranking）+ 确定性硬核准（Deterministic Validation）”**的双层防线。

```text
       CandidateCollector (汇聚项目、记忆、MCP、Skills、硬件)
                     │
                     ▼
       RoutingCandidateRanker (硬约束过滤 + 软偏好打分 + 置信度隔离)
                     │
                     ▼
       RoutingDecisionEngine (决策产出：DISPATCH / CLARIFICATION / BLOCKED ...)
                     │
                     ▼
    ┌──────────────────────────────────────────────┐
    │       RoutingValidator 确定性安全红线         │
    │  - 物理真实在线 (WebSocket 存活)              │
    │  - 已授权合法项目 (杜绝任意绝对路径逃逸)        │
    │  - 墓碑与撤销检查 (Tombstone 拒绝)            │
    │  - Revision 一致性校验                       │
    │  - MCP 必须为 verified/available (拒绝伪装)    │
    └──────────────────────────────────────────────┘
                     │
                     ▼
             TaskScheduler 真正执行派发
```

---

## 二、候选收集与证据溯源 (Candidate Evidence)

每个候选不仅记录其评分，更保留强类型的证据清单（`CandidateEvidence[]`）：
- `sourceType`：`project_catalog` | `federated_memory` | `remote_memory` | `skill_catalog` | `mcp_catalog` | `node_hardware`
- `referenceId`：具体来源（如 `proj:proj-nash-agent`、`mem:fed-nash-mcp`、`hw:NVIDIA GPU`）
- `confidence`：该项证据的真实置信度
- `freshnessTimestamp`：事实产生或更新的时间戳
- `matchReasons`：匹配关键词与同义词展开理由

禁止将候选数据串接为单一段落无结构文本，保证决策解释完全可溯源、可审计。

---

## 三、硬约束规则集 (Hard Constraints)

任何候选若违反以下任一条，`hardConstraintsSatisfied` 立即置为 `false`，绝不因语义分高而派发：
1. **显式节点限制**：若 `intent.constraints.explicitNodeId` 存在且不等于 `candidate.nodeId`，拒绝。
2. **显式项目限制**：若 `intent.constraints.explicitProjectId` 存在且不等于 `candidate.projectId`，拒绝。
3. **节点在线状态**：目标节点的 WebSocket 连接必须处于活跃状态；离线节点一律排除出直接执行集。
4. **项目活跃状态**：项目不得处于 `tombstone`（已注销）或 `disabled` 状态。
5. **项目权限策略**：项目 `visibility` 必须不为 `not_published`。
6. **必需能力就绪**：若依赖某 MCP 服务，该服务在目标节点必须存在且状态为 `available`；若为 `needs_auth`，直接阻断为 `BLOCKED`。

---

## 四、软偏好打分算法与置信度隔离

### 1. 评分公式
$$\text{RawScore} = \text{BaseProjectMatch} + \text{MemorySnippetMatch} + \text{TechCapMatch}$$
$$\text{FinalScore} = (\text{RawScore} + \text{PreferredNodeBonus}) \times (0.6 + 0.4 \times \text{Confidence})$$

- 当 `preferredNodeId` 命中时，获得 `+0.5` 的倾向加分。
- 分数严格归一化到 `[0.01, 1.00]`。
- **得分与置信度分离原则**：即使通过关键词高频匹配获得很高的相关性得分，若该条记忆来自未经充分代码验证的推断（低 Confidence），其最终加权分将被压制，避免“过期或不可靠记忆”误导决策。

### 2. 排序优先级
1. `hardConstraintsSatisfied === true` 优先于不满足者；
2. `nodeOnline === true` 优先于离线者；
3. `preferredNodeId` 匹配者优先；
4. `score` 从高到低；
5. `confidence` 从高到低。
