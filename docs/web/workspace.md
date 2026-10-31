# Nash Web Control Plane: 工作台与交互设计 (Workspace)

## 1. 核心工作台交互模型

Nash AI Agent Workspace (`/`) 采用自主设计的对话交互与运行可观测布局，并增强了针对分布式多智能体与原生系统调用的可观测性。

---

## 2. 消息流与卡片渲染 (ChatMessage)

### 2.1 用户消息 (User Message)
- 采用深灰底色 (`#1e1e22`)、高亮白字通栏全宽卡片。
- 支持纯文本、多行粘贴折叠与图片/附件指示。

### 2.2 助手回复 (Assistant Message)
- **流式思考摘要 (Thinking Block)**：动态折叠/展开，支持思维链推理展示。
- **结构化路由决策卡片 (Routing Decision Card)**：
  - 展示最终决策类型 (`DISPATCH` / `PROPOSE_GRAPH` / `CLARIFICATION_REQUIRED`)。
  - 显示中标节点 ID、项目名、评分、置信度以及硬约束满足证据链。
- **任务图阶段卡片 (Graph Planning Card)**：
  - 展示解构的有向图节点数、并行阶段数与 Join Barrier 汇聚说明。

### 2.3 工具调用分层呈现 (Tool Calls & Results)
- 紧凑工具卡片：首行展示工具名（如 `bash`、`read_file`、`edit_file`）、耗时、执行退出码。
- 点击可展开查看详细参数与控制台 stdout / stderr 输出。
- `edit_file` / `write_file` 展示真实行号的代码差异 Diff 染色对比。

---

## 3. 输入控制中枢 (ChatInputBox)

- **中文输入法 (IME) 防提前提交**：
  - 监听 `compositionstart` 与 `compositionend` 事件。
  - 当 `isComposing === true` 时，回车键仅用于汉字上屏，严禁触发表单提交。
- **运行态 Steer 暂存队列条 (Pending Steer Queue)**：
  - 当后台有长任务或模型正在推理时，用户提交的指令自动置于输入框上方，显示为橙色 Pending 队列条：
    `⇥ Queued: [消息预览] (Esc to interrupt current step & send)`
  - 任务抵达 Step 边界或被用户主动中断时，自动注入并推进执行。
- **快捷键体系**：
  - `Enter`：发送消息 / 推进 Steer。
  - `Shift + Enter`：输入框内换行。
  - `Esc`：优先终止当前运行中的 Tool（发送 SIGTERM 中断子进程并推进 LLM 回答）。
