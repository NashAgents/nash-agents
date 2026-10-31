# Routing Session & Ambiguity Handling (多轮澄清与路由会话管理)

## 一、为什么需要 Routing Session

用户给出的任务往往存在语义不完整或天然的多候选重叠，例如：
> “修复 app-demo 中的启动问题”

当集群在同一节点或不同节点上存在多个名为 `app-demo` 的同类工程，且两者的特征、技术栈和匹配分数高度接近（得分差 ≤ 0.15）时，直接随意挑选第一名执行代码修改具有严重的安全隐患。

系统在此场景下触发 `CLARIFICATION_REQUIRED` 状态，并建立持久跟踪的 `RoutingSession`。

---

## 二、Session 结构与生命周期状态机

```typescript
export interface RoutingSessionRecord {
  sessionId: string;            // 'rsess-xxxx'
  initialRequest: string;       // 用户原始诉求
  currentIntent: TaskIntent;    // 当前意图与约束状态
  decisionHistory: RoutingDecision[];
  currentDecision?: RoutingDecision;
  clarificationHistory: Array<{
    prompt: string;
    userResponse: string;
    timestamp: number;
  }>;
  associatedTaskId?: string;
  associatedRunId?: string;
  status: "analyzing" | "clarifying" | "decided" | "dispatched" | "replanning" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}
```

```text
    用户输入
       │
       ▼
   analyzing ────(无歧义)────> decided ────(校验通过)────> dispatched
       │
 (存在候选歧义)
       ▼
   clarifying <──(用户回复选择)── [CLI / TUI / API 选项交互]
       │
       ▼
 (更新 Intent Constraints)
       │
       ▼
   analyzing (基于新约束重新裁决)
```

---

## 三、澄清选项解析与多模态交互

当 Router 产出 `CLARIFICATION_REQUIRED` 时，向用户输出结构化 `clarificationOptions`：
```json
{
  "clarificationPrompt": "检索到多个可能相符的项目，请选择您希望在哪个项目上执行任务：",
  "clarificationOptions": [
    {
      "optionId": "opt-1",
      "label": "app-demo-v1 (Mac)",
      "nodeId": "node-example-mac",
      "projectId": "proj-app-demo-v1",
      "description": "移动端演示程序 (版本 1)"
    },
    {
      "optionId": "opt-2",
      "label": "app-demo-v2 (Mac)",
      "nodeId": "node-example-mac",
      "projectId": "proj-app-demo-v2",
      "description": "移动端演示程序 (版本 2)"
    }
  ]
}
```

用户可通过以下任一方式回复：
1. **序号/代号选择**：“1”、“opt-1”、“选择第二项”；
2. **节点自然语言澄清**：“Mac 上那个”、“在腾讯云上的”；
3. **补充约束指令**：“选第 1 个，但先只读检查不要修改”。

`RoutingSessionManager.handleClarification` 自动将用户回答翻译为目标约束（如 `explicitProjectId = 'proj-app-demo-v1'`, `readOnly = true`），驱动下一轮决策直接收敛至 `DISPATCH`。
