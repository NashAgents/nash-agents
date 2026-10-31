# Nash Cluster 运维与故障排查手册

## 1. CLI 命令速查表

### 1.1 集群管理命令 (`nash cluster`)
```bash
# 启动 Coordinator (及可选的同机本地 Worker)
nash cluster start [--port <p>] [--host <h>] [--db <url>] [--worker]

# 查看集群全局状态 (在线节点数、任务数、待审批数)
nash cluster status [--json]

# 查看所有注册节点清单与在线状态
nash cluster nodes [--json]

# 撤销指定节点的访问权限
nash cluster nodes revoke <node-id>

# 生成一次性加入邀请码
nash cluster invite

# 显式向指定节点派发任务
nash cluster dispatch <node-id> <project-id> "<goal>" [--prompt "<p>"]

# 查看所有任务清单
nash cluster tasks [--node <n>] [--status <s>] [--json]

# 查看指定任务详情与 State Projection 状态投影
nash cluster task <task-id>

# 查看或实时跟踪 (--follow) 任务执行事件流
nash cluster task logs <task-id> [--follow]

# 向正在执行的任务注入用户指导意见 (Steer)
nash cluster task steer <task-id> "<guidance>"

# 请求立即中断当前任务的工具执行
nash cluster task interrupt <task-id>

# 取消任务执行
nash cluster task cancel <task-id> [reason]

# 查看等待用户裁决的远程审批请求
nash cluster task approvals

# 批准 / 拒绝指定安全能力申请
nash cluster task approve <approval-id>
nash cluster task deny <approval-id>

# 可选：systemd Unit 状态 / 渲染安装 (默认 dry-run) / 预检后重启
nash cluster service status [--role <r>] [--unit <name>]
nash cluster service install [--write] [--force] [--enable]
nash cluster service restart --confirm
```

### 1.2 节点管理命令 (`nash node`)
```bash
# 启动 Worker 守护进程并连接 Coordinator
nash node start [--coordinator <url>]

# 使用邀请码配对加入集群
nash node join <coordinator-wss-url> <invite-code>

# 查看本地节点身份信息、配置与已授权项目
nash node status

# 查看、添加或移除本地项目授权
nash node projects list
nash node projects add <path> [--name <name>]
nash node projects remove <project-id>
```

---

## 2. Linux systemd 运维与启动熔断治理

```bash
# 执行部署环境与启动前置检查 (Preflight)
nash cluster preflight [--port 18444] [--db <url>]

# 运行全面的 Linux 部署与服务健康诊断
nash doctor --deployment

# 查看 Coordinator 服务状态
systemctl status nash-cluster

# 查看实时结构化日志
journalctl -u nash-cluster -f

# 重启 Coordinator 服务
systemctl restart nash-cluster

# 停止 Coordinator 服务
systemctl stop nash-cluster
```

### 启动熔断与无限重启防御策略
针对服务在目录丢失后可能发生的无限重启问题，服务单元需采用双层熔断：
1. **启动速率熔断 (Start Limit)**：`StartLimitIntervalSec=60s` + `StartLimitBurst=3`，在 60 秒内重启失败超过 3 次强制进入 `start-limit-hit` 停机状态；
2. **致命配置错误阻断 (Exit Guard)**：`RestartPreventExitStatus=78`，Preflight 识别到目录丢失、入口未构建或配置损坏时以 RFC 78 (`EX_CONFIG`) 退出，systemd 绝不重启；
3. **废弃服务管理**：旧版启动单元不得与当前 `nash-product.service` 并行运行；迁移前应检查历史服务是否已禁用。

### 可选：通过 CLI 渲染与安装 systemd Unit

`nash cluster service` 是**完全可选**的辅助命令：既有节点继续使用 `nash cluster start` / `nash node start` 或人工维护的 Unit 启动，不受任何影响。

```bash
# 只读：查看 Unit 当前状态与「无限重启风险」判定（systemd 缺失时报告 available:false，不报错）
nash cluster service status [--role coordinator|worker] [--unit <name>] [--json]

# 渲染 Unit（默认 dry-run：只打印文本与目标路径，不建目录、不写文件、不调用 systemctl）
nash cluster service install [--role coordinator|worker] [--unit <name>] [--json]
# 真正写盘
nash cluster service install --write [--force] [--json]
# 写盘并同时执行 daemon-reload / enable / start（必须显式 --enable）
nash cluster service install --write --enable [--json]

# 先 Preflight，再重启；缺少 --confirm 时绝不执行
nash cluster service restart [--role coordinator|worker] [--unit <name>] --confirm
```

行为约定：

- **默认 dry-run**：`install` 不带 `--write` 时只输出渲染结果；`--dry-run` 与 `--write` 互斥，未知参数一律以非 0 退出，绝不静默忽略拼错的 flag。
- **不覆盖既有 Unit**：目标文件已存在时拒绝写入，必须显式 `--force`。
- **启用必须显式**：`systemctl daemon-reload|enable|start` 只在同时给出 `--write --enable` 时执行；其余情况在输出中标记为 `[skip]`。**在已有数据目录（`~/.nash-agents` 或自定义 `NASH_HOME`）的机器上启用服务前，必须确认这是期望的目标实例**——命令不会替你判断，只有显式 `--enable` 才会真正启用，避免意外拉起第二个服务占用同一数据目录与端口。
- **Preflight 先行**：`restart` 失败于预检时保留 RFC 退出码语义（`78` 永久配置错误 / `75` 暂时依赖故障），且绝不会触达 `systemctl`。由于重启时监听端口必然被现有进程占用，预检会跳过端口可用性检查。
- **凭据与端口一致**：Unit 正文只引用 `EnvironmentFile`（Coordinator 默认 `/etc/nash/nash-cluster.env`，Worker 默认 `/etc/nash/nash-worker.env`），绝不内联密钥；`ExecStart` 中的 `--host/--port` 由参数显式渲染，默认端口 `18443` 与 `nash cluster start` 保持一致（历史模板中的 `18444` 不再复现）。

## 3. WSL2 Worker 运维

```bash
# 查看 Worker 服务状态
systemctl status nash-worker

# 查看实时日志
journalctl -u nash-worker -f

# 重启 Worker
systemctl restart nash-worker
```
