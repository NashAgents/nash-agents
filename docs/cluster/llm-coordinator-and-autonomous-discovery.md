# Nash Cluster: LLM 驱动主协调智能体与分布式自主发现架构

## 1. 架构演进背景与设计动机

在早期的调度设计中，集群使用基于意图分类规则与关键词评分的确定性路由（`SemanticTaskRouter` / `DecisionEngine`）。当用户输入无法在现有 Catalog 或联邦记忆中精确匹配（例如：“分析一下 bilibili 的项目”）时，系统会直接判定为 `NO_CANDIDATE` 并向用户输出 `Nash routing_decision: 任务已创建，原因: 在集群 Catalog 与联邦记忆中未检索到与目标匹配的项目或节点`，导致用户体验陷入假死。

为了彻底解决这一问题，Nash Cluster 引入了 **LLM 驱动的主协调智能体 (`CoordinatorMainAgent`)** 与 **三节点分布式自主发现子系统 (`AutonomousDiscoveryService` / `ScoutAgent`)**。

---

## 2. 总体架构图

```text
                           用户输入 (Web UI / REST API / CLI)
                                        │
                                        ▼
                  ┌───────────────────────────────────────────┐
                  │    CoordinatorMainAgent (LLM 主协调智能体)   │
                  │   - 基于 Nash 原生 runAgentLoop 构建       │
                  │   - 维持上下文历史 (ContextManager)       │
                  │   - 产出自然语言 Markdown 回答与澄清卡片   │
                  └─────────────────────┬─────────────────────┘
                                        │ 工具调用
                 ┌──────────────────────┼──────────────────────┐
                 ▼                      ▼                      ▼
        search_cluster_projects  dispatch_cluster_task  discover_cluster_resources
                 │                      │                      │
                 ▼                      ▼                      ▼
           Catalog 检索           派发具体任务至 Worker    唤起自主分布式发现中枢
                                                         (AutonomousDiscoveryService)
                                                               │
                                       ┌───────────────────────┴───────────────────────┐
                                       ▼                                               ▼
                              调度分布式 Scout 任务                             并行本地/远端探测
                           (TaskScheduler / Worker)                             (inspect_local_projects
                                       │                                         inspect_local_mcp
                                       ▼                                         read_project_meta)
                           Worker 物理只读沙箱执行                                     │
                             (runAgentLoop + Scout)                                   │
                                       │                                               │
                                       └───────────────────────┬───────────────────────┘
                                                               │
                                                               ▼
                                                  DiscoveryResultValidator
                                                  (证据链物理审查 & 状态定级)
                                                               │
                                        ┌──────────────────────┴──────────────────────┐
                                        ▼                                             ▼
                             回写 cluster_project_catalog                  回写 cluster_memory_index
                                  (增量能力与项目沉淀)                           (联邦记忆语义召回)
```

---

## 3. 核心子系统与关键机制

### 3.1 CoordinatorMainAgent (主协调智能体)
- **原生 AgentLoop 复用**：Coordinator 不重写第二套 AgentLoop，而是原生装配 `runAgentLoop`，支持动态多步推理、工具并发调用与 AbortController 中断。
- **三层响应解耦**：
  - **Assistant Message**：最终呈现在聊天窗口的 Markdown 富文本；
  - **Execution Event**：通过 SSE 长连接 (`/api/cluster/events/stream`) 发送的节点运行、产物生成与实时时间线；
  - **Diagnostic Event**：调试与审计元数据。
- **人机澄清流程 (`request_user_clarification`)**：当检索发现多个相似候选（如独立项目 vs MCP 工具）时，主动挂起并下发结构化选项，前端自动渲染可点击的选项卡片，用户点击后无缝续推原任务。

### 3.2 AutonomousDiscoveryService (自主发现服务)
- **多维度协同探测**：在无明确候选时，向集群所有在线 Worker 节点（Tencent Linux、Mac Darwin、WSL2 Linux）并发下发 Scout 探查任务。
- **Worker 本地物理只读沙箱**：
  - Scout 任务带有 `contextOverrides: { isDiscovery: true }`；
  - Worker 端强制将沙箱级别设为 `read-only`，仅挂载专属 Scout 工具：
    - `inspect_local_projects`：读取当前 Worker 的 `ProjectRegistry` 物理项目白名单；
    - `inspect_local_mcp`：读取 `~/.nash-agents/settings.json` 与 `.mcp.json` 中配置的本地 MCP 服务与端点；
    - `read_project_meta`：只读解析 `package.json`、`README.md`，提取依赖和技术特征；
    - `submit_discovery_report`：提交结构化 `DiscoveryReport` 报告。

### 3.3 DiscoveryResultValidator (证据链物理核验)
- **拒绝无证据幻觉**：若候选缺少物理证据（代码路径、文件片段或 MCP 响应），坚决予以拒绝（`rejected`）。
- **状态定级**：
  - `verified`：在 Worker 的 `ProjectRegistry` 中物理注册且白名单验证通过；
  - `discovered_unregistered`：物理存在但未在白名单授权的项目（防止越界执行）；
  - `verified_live`：MCP 服务端点握手成功且具有存活工具能力。
- **自动闭环沉淀**：通过核验的候选自动增量写入 `cluster_project_catalog` 与 `cluster_memory_index`，后续查询无需再次探查，实现秒级直接召回。

### 3.4 流式工具分片粘连防御 (Streaming Tool Call Accumulator Fix)
针对部分模型反向代理（如 Gemini no-thinking）在单步并发调用两个工具时固定返回 `index: 0` 的缺陷，在 `accumulateChatCompletionStream` 中引入 `idToIndexMap` 与 `tc.id` 变动感知。当检测到相同 index 出现不同 `call_id` 时，动态为后续工具分配独立槽位，彻底根治工具名粘连报错（如 `search_cluster_projectssearch_cluster_capabilities`）与无限重试死循环。
