# Nash Cluster: Semantic Task Router (语义任务路由架构)

## 一、系统核心愿景

在 Phase 1（分布式通信与任务执行调度）和 Phase 2（集群资源目录与联邦记忆）的基础上，Phase 3 正式实现了**“自然语言驱动的自主任务路由与执行中枢”**。

用户不再需要预先知道：
- 节点唯一标识（Node ID，如 `node-example-mac`）
- 项目代号（Project ID，如 `proj-nash-agent`）
- SSH 主机与登录端口
- 本地真实绝对路径

用户只需输入自然语言诉求，例如：
> “检查之前开发的 Nash MCP 模块是否支持 streamable-http”
> “在腾讯云检查当前系统的 Node 版本与沙箱可用性”
> “在 WSL2 检查 Python 环境和 NVIDIA GPU 探测情况”
> “检查那个实现了字幕同步高亮的项目”

Nash Cluster Coordinator 自动完成意图拆解、跨节点资源联合检索、两阶段联邦记忆匹配、硬软约束评估、确定性安全校验，并将任务自主下发给最适合的物理节点执行，全链路流式反馈事件与结果。

---

## 二、端到端完整数据流与拓扑

```text
                                  用户自然语言输入
                                         │
                                         ▼
                               TaskIntentAnalyzer
                      - 提取目标、操作、项目/节点/能力线索
                      - 抽取只读/修改、节点硬约束与风险提示
                                         │
                                         ▼
                            RoutingCandidateCollector
                      - 联合 Project Catalog (全集群项目检索)
                      - 联合 Federated Memory (长期知识与事实检索)
                      - 联合 Capability Catalog (Skills & MCP 状态)
                      - 联合 Node Hardware (在线状态与硬件探测)
                                         │
                                         ▼
                             RoutingCandidateRanker
                      - 严格硬约束过滤 (在线、未删、未墓碑、已授权、能力非 needs_auth)
                      - 软偏好评分排序 (意图关键词、偏好节点加权、事实置信度微调)
                      - 严格隔离“检索相关性得分”与“事实可信度”
                                         │
                                         ▼
                            RoutingDecisionEngine
                      - 确定性模式：最佳候选显著领先 → 直接 DISPATCH
                      - 歧义检测模式：候选得分极度接近 (≤0.15) → CLARIFICATION_REQUIRED
                      - 跨节点协同模式：识别跨机器依赖 → MULTI_NODE_REQUIRED
                      - 阻塞模式：MCP 需授权 (needs_auth) → BLOCKED
                      - 离线等待模式：节点暂时失联 → DEFERRED
                      - 深层推理模式 (按需)：调用 Coordinator 原生 AgentLoop
                                         │
                                         ▼
                                RoutingValidator
                      - 确定性物理安全红线校验 (Deterministic Safety Boundary)
                      - 校验 Node ID 存在且 WebSocket 活跃
                      - 校验 Project ID 为正式注册工作区 (拦截任意路径透传)
                      - 校验项目未被注销 (Tombstone 拦截) 与 Revision 一致性
                                         │
                                         ▼
                            AutonomousDispatchService
                      - 复用 Phase 1 TaskScheduler (createTask)
                      - 强关联并持久化：Task ID ↔ Route ID ↔ Run ID
                      - 记录候选快照与选定证据链路
                                         │
                                         ▼
                       目标 Worker 本地 AgentLoop 执行
                      - 物理项目 realpath 二次校验与工作区锁
                      - Native OS 沙箱 (Seatbelt / Bubblewrap) 强隔离
                      - 真实工具调用 (read_file / edit_file / bash 等)
                      - 单调 SequencedEvent 流式经 WSS 回传持久化
                                         │
                                         ▼
                    TaskSupervisor & RoutingFeedbackController
                      - 事件驱动监督与异常判定
                      - 普通 tool.failed 由 Worker 局部自愈
                      - 关键异常 (InterventionRequired / NodeOffline / ProjectUnavailable)
                        触发受控重新规划 (Controlled Replanning)
                      - Outcome Unknown 防线：存在写副作用时坚决拒绝盲目重新派发
```

---

## 三、决策类型枚举矩阵

| 决策类型 | 语义说明 | 典型触发条件 | 后续行为 |
| :--- | :--- | :--- | :--- |
| `DISPATCH` | 存在明确、合法且可用的执行目标 | 最佳候选硬约束满足，得分显著高于其他候选，或用户明确指定 | 通过 RoutingValidator 校验后立即派发任务 |
| `CLARIFICATION_REQUIRED` | 候选存在实质性歧义，需用户决策 | 存在 2 个以上满足硬约束的候选，得分差距 ≤ 0.15 且涉及代码修改 | 输出选项列表与澄清问题，挂起等待用户选择 |
| `BLOCKED` | 目标明确但能力或认证不足 | 依赖的 MCP 处于 `needs_auth`，或项目权限为 `not_published` | 终止派发，明确向用户报告阻塞根因，引导配置认证 |
| `NO_CANDIDATE` | 集群无任何相符资源 | 目录检索、联邦记忆与能力均未匹配，或全部候选违反硬约束 | 报告无匹配候选及具体未满足约束清单 |
| `DEFERRED` | 目标存在但宿主节点暂时离线 | 唯一匹配项目所在节点断线，未满足在线硬约束 | 标记为挂起等待，提示用户等待 Worker 重新连线 |
| `MULTI_NODE_REQUIRED` | 任务依赖分布在多个物理节点的能力 | 例如“从腾讯云 MCP 提取字幕，导入 Mac 阅读器项目” | 生成包含子任务与推荐时序的编排计划（交由 Phase 4） |
| `REPLAN_REQUIRED` | 正在执行的任务因外部环境变化需重规划 | Worker 运行时报告代码无目标模块，或目标节点被并发撤销 | 进入 Replan 评估状态机与原任务副作用对齐流程 |
