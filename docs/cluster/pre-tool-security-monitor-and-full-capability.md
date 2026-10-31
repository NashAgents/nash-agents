# Nash Agent: Full Capability Execution & Pre-Tool Security Monitoring 架构

## 1. 架构演进背景

在传统的沙箱与权限模型中，系统默认将 Agent 限制在 `workspace-write` 甚至 `read-only` 模式下。当 Agent 试图读取工作区外部的常规配置、代码库或依赖时，会被系统直接拦截报错（`FilesystemAccessDeniedError`）或频繁打扰用户弹窗审批，严重破坏了 Agent 解决真实工程问题的自主性。

为了让 Nash 拥有接近真实高级开发者的完整工具执行能力，同时杜绝 Prompt Injection、越权破坏与数据外泄，Nash 正式重构权限执行体系：
**取消 `workspace-write` 作为默认能力上限，全面升级为 Full Capability Execution，并在原生 `AgentLoop` 中引入 LLM-Based Pre-Tool Security Monitor 统一安全钩子。**

---

## 2. 核心架构与执行拓扑

```text
                  LLM 生成待执行 tool_calls
                             │
                             ▼
              拦截待执行 Tool Call (Step Boundary 前)
                             │
                             ▼
         构建多维 Security Context (绑定参数 SHA-256 指纹)
                             │
                             ▼
          Pre-Tool Security Monitor (独立 Security LLM 审查)
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
         ALLOW             BLOCK       REQUIRE_APPROVAL
     (合法自主执行)    (硬性风险拦截)   (高风险人机协同审批)
           │                 │                 │
           ▼                 ▼                 ▼
   交付原生 ToolExecutor   生成拦截 ToolResult   审批通过后执行 / 拒绝
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                             ▼
             返回 Tool Result 推进 AgentLoop
```

---

## 3. 核心设计与安全规范

### 3.1 权限模式重构 (Full Capability Execution)
- **取消默认工作区硬卡死**：系统底层策略升级为 `full-capability`，Agent 具备完成任务所需的完整工具集（File Read/Write, Shell Execution, Network Access, MCP Tools, Project Operations, Git Operations, Cluster Operations）；
- **保留 OS 原生安全底座**：
  - macOS Seatbelt 强制对 `/System`, `/etc`, `/sbin`, `/usr` 等关键系统底座路径实施只读保护；
  - Linux Bubblewrap 保持对根系统 `/` 的 `--ro-bind` 只读挂载，将用户工作区和 Home 目录赋予读写权限；
  - `FileSystemAccess` 拦截针对 `/etc/shadow`, `/etc/sudoers` 等敏感特权文件的读写。

### 3.2 独立安全审查策略与威胁模型
- **三大核心威胁模型 (Threat Model)**：
  1. `Prompt Injection`：外部文件、网页或工具输出中的对抗性恶意指令；
  2. `Scope Creep`：超出当前授权任务边界的蔓延操作；
  3. `Accidental Damage`：因不清楚影响范围导致的不可逆破坏。
- **HARD BLOCK**：绝对拦截（Data Exfiltration、Security Bypass / 篡改特权、Credential Destruction）；
- **SOFT BLOCK**：高危或破坏性操作（Git 强推、批量删除关键文件、修改生产环境），若缺少用户明确的 `[named+specifics]` 授权，统一收敛为 `REQUIRE_APPROVAL`；
- **ALLOW Exceptions**：常规代码编辑、构建、依赖安装、单测运行、集群只读探查直接放行。

### 3.3 参数指纹防篡改与并行安全审查
- 每次审查时均对 `toolName` 和 `rawArgs` 计算 SHA-256 参数指纹；
- 执行前严格校验实际执行参数是否与被审查参数一致，防止中间环节被篡改；
- 单轮并发生成的多个 `tool_calls` 统一进行并行安全审查，大幅降低 Wall-Clock 延迟。

### 3.4 移除硬编码步数限制
- 彻底清理 `AutonomousDiscoveryService` 中硬编码的 `maxScoutSteps = 6` 和 `CoordinatorDecisionController` 中硬编码的 `maxSteps = 5`；
- 全面回归 Nash 原生 AgentLoop 的执行限制与预算终止机制；
- Worker 端增加感知：Scout 任务一旦成功提交 `submit_discovery_report`，支持 Early Exit 自然完工，彻底解决多项目节点因步数耗尽而导致探查失败的问题。
