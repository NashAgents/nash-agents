# Task Intent Analysis (任务意图与约束提取)

## 一、意图分析职责与设计哲学

`TaskIntentAnalyzer` 位于路由链路的第一环，其核心哲学是：**“忠实理解用户诉求，提取结构化约束，坚决杜绝模型擅自扩权或篡改用户目标”**。

用户在输入自然语言时，往往混杂了操作动词、修饰限定、环境假定和安全期望。Intent Analyzer 将其解构为具有强类型定义的 `TaskIntent`：

```typescript
export interface TaskIntent {
  originalRequest: string;       // 绝对保留的用户原始文本
  goal: string;                  // 标准化后的执行目标
  operation: TaskOperationType;  // inspect | fix | test | deploy | research | setup | environment_check | general
  projectHints: string[];        // 项目关键词线索 (如 'nash-agent', 'nash-cluster')
  nodeHints: string[];           // 物理节点线索 (如 'mac', 'tencent', 'wsl2')
  capabilityHints: string[];     // 能力线索 (如 'mcp', 'hardware:gpu')
  requiredCapabilities: string[];// 必需能力 (如 'mcp:bilibili-subtitles', 'cuda')
  preferredCapabilities: string[];
  constraints: TaskConstraints;  // 显式约束 (readOnly, explicitNodeId, preferredNodeId)
  ambiguities: string[];         // 潜在歧义记录
  riskHints: string[];           // 操作风险警示
  confidence: number;            // 意图抽取置信度 (0.0 ~ 1.0)
}
```

---

## 二、关键提取算法与安全准则

### 1. 操作类型与只读硬约束识别
- **防否定误判**：当输入包含“不要修改”、“无需改动”、“禁止修改”时，即便包含“修改”字样，系统绝对不判为 `fix`，而是严格判定为 `inspect`，并将 `constraints.readOnly = true`。
- **高风险标记**：
  - `deploy`：任务涉及部署与线上服务状态变更，属于高风险操作。
  - `fix`：任务涉及代码修改，强制要求在目标沙箱安全策略内执行并要求事前审批。

### 2. 节点别名与硬/软约束分级
- **Hard Pinning (显式必须)**：
  - 正则匹配：`/(?:必须|务必|只能|指定)在\s*([a-zA-Z0-9_一-龥]+)\s*(?:上|节点|机器|执行)/i`
  - 提取为 `constraints.explicitNodeId`。若后续候选节点不属于该 ID，一律直接硬约束阻断。
- **Soft Preference (倾向偏好)**：
  - 自然语言方位词（“在腾讯云...”、“腾讯云上...”、“WSL2 里的...”）
  - 提取为 `constraints.preferredNodeId`。在候选打分时享有显著权重加分 (+0.5)，同时在候选排序中享有同分优先决议权。

### 3. 能力感知提取
- 识别 `bilibili`、`b站`、`字幕提取` 时自动附加 `requiredCapabilities: ["mcp:bilibili-subtitles"]`。
- 识别 `cuda`、`gpu` 时附加 `requiredCapabilities: ["cuda"]`。
- 识别 `pytorch`、`torch` 时附加 `requiredCapabilities: ["pytorch"]`。
- **严禁虚假推断**：检测到 GPU 硬件不代表 PyTorch 已安装；依赖检查必须由 Worker 实际运行验证。
