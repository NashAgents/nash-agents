# Nash Cluster: 结果验收与反馈 (Result Verification)

## 1. 核心设计原则

在分布式多智能体编排中，必须设立严格的结果验收防线：
- **确定性物理检验绝对优先**：绝不以 LLM 的自我吹嘘（如“我已成功修改代码并测试通过”）作为任务完成判定；
- **真实测试退出码与产物校验**：必须通过实际测试进程退出码（`exitCode === 0`）、产物物理存在性与内容非空性进行判定；
- **MCP needs_auth 严格拦截**：当任务依赖的 MCP 服务（如 `bilibili-subtitles`）处于 `needs_auth` 时，系统精确产出 `NEEDS_AUTH` / `BLOCKED` 状态，绝对严禁用 Mock 数据假装成功。

---

## 2. 验收条件分类与判定逻辑

| 验收类型 | 判定规则 | 失败判定结果 |
| :--- | :--- | :--- |
| `artifact_exists` | 检查产物是否已在 Artifact Store 注册、状态为 `available` 且体积 > 0 | `FAILED` (产物缺失或空文件) |
| `test_exit_code` | 检查测试命令执行后的返回值是否与预期相符 (通常为 0) | `FAILED` (测试未通过) |
| `file_modified` | 检查结果摘要与文件变更指纹是否真实存在变更证据 | `INCOMPLETE` (无实质变更) |
| `mcp_auth_check` | 检查任务依赖的 MCP 能力是否具备合法认证令牌 | `NEEDS_AUTH` (阻断执行) |

所有验收过程均被持久化至 `cluster_graph_verifications` 审计表中。
