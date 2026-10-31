# Nash Cluster 安全边界与权限模型

Nash Cluster 坚持**“零信任与本地执行最终主权”**设计原则。在分布式场景下，节点虽然受到 Coordinator 调度，但底层代码执行、文件读写与命令派发永远由 Worker 本地内核级沙箱直接监管。

---

## 1. 严格工作区与项目路径白名单 (ProjectRegistry)

- **绝对拒绝任意 CWD**：Coordinator 派发任务时，仅允许传递 `projectId`，绝不允许传递裸物理路径（如 `/etc/` 或 `../../`）。
- **递归规范化校验 (Canonical Realpath)**：
  ```typescript
  const canonicalPath = fs.realpathSync(projectPath);
  ```
  在项目注册与任务启动双重检查中，必须调用 `fs.realpath` 彻底展开所有符号链接（Symlink），验证真实物理目录未跳出受控工作区，有效抵御符号链接逃逸与 TOCTOU 攻击。

---

## 2. 原生 Fail-Closed 沙箱继承

- **macOS Seatbelt (`MacOsSeatbeltBackend`)**：通过动态生成 Scheme Profile 调用 `/usr/bin/sandbox-exec`。
- **Linux Bubblewrap (`LinuxBubblewrapBackend`)**：非特权用户命名空间隔离（mount, pid, ipc, uts, net），显式 `--cap-drop ALL`，隔离特权 Unix Sockets。
- **Fail-Closed 铁律**：若系统缺少沙箱支持，绝不静默降级为宿主裸进程，直接抛出 `SandboxUnavailableError`。

---

## 3. 远程人机审批联动 (Remote Approval Protection)

在后台无人值守运行的 Worker 节点上，涉及高危安全操作（如跨项目写文件、未授权网络调用等）绝对不会自动跳过或假定放行：

1. **触发拦截**：`FileSystemAccess` 或 `SandboxService` 发现操作越界，调用 `ApprovalService.requestApproval()`；
2. **远程转交**：`RemoteApprovalProvider` 将审批请求打包为 `approval.requested`，携带 `taskId`、`capability`、`reason`、`target` 发送至 Coordinator；
3. **安全挂起**：Worker 端任务进入 `waiting_approval` 状态，AgentLoop 挂起等待决议（默认 5 分钟超时）；
4. **人工决议**：管理员通过 CLI (`nash cluster task approve/deny <id>`) 或 Web API 做出现实决策；
5. **单次放行 (`allow-once`)**：决议传回 Worker 后仅对当前单次操作生效，绝不污染全局沙箱策略状态。超时无人审批自动 Fail-Closed 返回 `deny`。
