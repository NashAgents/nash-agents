# Nash Web Control Plane: 人机协同安全审批规范 (Approvals)

## 1. 核心安全铁律 (Security Invariants)

在分布式多智能体执行过程中，遇到跨项目文件写入、敏感命令执行或网络请求越界时，Nash 严格遵守以下安全红线：

1. **Fail-Closed 铁律**：后台无人值守 Worker 绝不能静默放行，必须将审批项打包为 `approval.requested` 上报 Coordinator。
2. **单次放行原则 (Allow Once)**：批准操作仅对本次调用的特定命令与目标资源有效，严禁持久污染全局安全策略。
3. **单次提权与重试限制**：单操作仅限一次提权与一次重试，拒绝无限循环请求。

---

## 2. 审批中心界面设计 (`/approvals`)

审批中心分为两大模块：

### 2.1 待处理安全审批 (Pending Approvals)
- 顶部展示待审批计数与醒目的金色脉冲指示灯。
- 审批卡片信息结构：
  - 工具类型徽章：如 `bash (命令行)`、`write_file (写文件)`。
  - 发生源头：源节点 ID (`nodeId`)、所属任务 ID (`taskId`)、关联 DAG。
  - 请求理由：模型给出的申请理由（如“需要编译前端代码”、“需要拉取依赖”）。
  - 目标资源：具体执行的代码、目标物理文件路径或目标 URL。
- 操作控制：
  - `放行一次 (Allow Once)`：通过 `POST /api/cluster/approvals/:id/resolve` 下发 `allow-once`。
  - `拒绝操作 (Deny)`：下发 `deny`，立即阻断 Worker 当前越界行为并向 LLM 返回拒绝错误。

### 2.2 审批历史追溯 (Audit Trail)
- 归档已决议的审批历史。
- 展示最终决议状态 (`approved` / `denied`)、决议时间戳与审计人员 ID。
