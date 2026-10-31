# Nash Agents

[English](README.md)

**Nash Agents** 是一个基于 TypeScript 构建的分布式自主智能体执行平台，采用 Coordinator/Worker 主从协同架构，融合分布式记忆、上下文管理、自主任务规划与智能节点调度。系统能够根据任务目标自主决策、分解任务并选择合适的执行节点，通过原生操作系统沙箱保障执行安全，并提供可视化 Web 控制台。支持从单机部署起步，按需扩展 Linux、Windows Worker，实现跨节点协作、并行执行与动态任务编排。

## 核心能力

- **分布式执行**：Coordinator 负责目标状态、确定性调度、审批与结果核验；Worker 在本机执行工具，通过认证 WSS/A2A 通信。单个节点可同时承担 Coordinator 与 Worker 角色。
- **GoalRun、Graph 与证据**：目标持久化为带尝试状态的 GoalRun。规划器产出单任务或 Graph/DAG，Scout 采集证据，Coverage 依据任务/尝试身份、节点、Artifact 摘要与证据指纹判定完成——模型文本回复不能作为执行完成的证据。
- **多层安全**：Security Monitor 与独立安全模型审查工具调用；确定性硬拦截不能被自动授权绕过；TaskSecurityGrant 绑定单一 node/task/run，必须在 Worker 确认后生效，管理员可手动撤销。
- **原生沙箱**：Linux 使用 Bubblewrap，Windows 使用 AppContainer/ACL/Job Object，macOS 使用 Seatbelt；后端缺失或失败时按策略失败关闭。
- **持久状态与恢复**：PostgreSQL 保存集群状态，SQLite 保存管理员与版本化配置。Worker Journal 以序列化事件和 ACK 支撑断连恢复；副作用未知的任务保持 `outcome_unknown`，不会自动重试。
- **运维能力**：Admission freeze/drain 以真实运行状态证明无在途工作后才停止服务；systemd 与 Windows Task Scheduler 托管服务；发布产物按摘要与运行进程身份校验；Web 控制台通过 SSE 展示真实状态。

当前准备版本为 **0.1.0**，源码仓库已公开，尚未发布 npm 包或正式 Release。各平台实际验收情况见[验证矩阵](docs/release/verification.md)。源码具备某项能力不代表对应平台和外部服务已经验收通过。

## 环境要求

- Node.js **>=24.14.0 且 <25**、npm、Git。
- Linux：Debian/Ubuntu、C 编译器、Bubblewrap；系统内核或组织策略仍可能限制沙箱运行。
- Windows：Windows 11 x64、PowerShell、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK。
- macOS：系统原生 Seatbelt（`/usr/bin/sandbox-exec`）。
- 支持所选协议和工具调用的模型服务，以及用户自己的 API 凭据。
- 单 Coordinator 支持本地存储。生产持久化推荐 PostgreSQL；管理员和配置使用独立 SQLite 数据库。

## npm 安装（正式发布后适用）

一旦正式发布或使用预发布安装包：

```bash
# 全局安装
npm install -g nash-agents

# 1. 交互式初始化本节点（支持 Coordinator+Worker、Coordinator 或 Worker）
nash init

# 2. 检查操作系统沙箱与内核隔离状态
nash doctor

# 3. 启动节点服务
nash start --background

# 4. 查看集群与节点状态
nash status
nash node list

# 在远端 Worker 节点上加入集群：
nash node join
```

也可以通过 `npx` 直接体验或进行单次任务初始化：

```bash
npx nash-agents init
```

## 从源码克隆与构建

源码仓库已公开，可以直接使用 HTTPS 克隆，不需要私人访问令牌；已有 SSH 身份的机器仍可选择 SSH 克隆。

```sh
git clone https://github.com/NashAgents/nash-agents.git
# 已有本机 GitHub SSH 授权时的替代方式：
git -c 'url.git@github.com:.insteadOf=https://github.com/' clone https://github.com/NashAgents/nash-agents.git
cd nash-agents
```

两条 clone 命令只执行其中一条。Linux 安装：

```sh
bash scripts/install.sh --install-system-deps --install-node
# Linux x64: make the optional local Node toolchain available in this shell.
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/nash-agents/toolchains/node-v24.14.0-linux-x64/bin:$PATH"
```

Windows PowerShell 安装：

```powershell
powershell -NoProfile -File scripts/install.ps1 -InstallSystemDeps -InstallNode
$env:PATH = "$env:LOCALAPPDATA\NashAgents\toolchains\node-v24.14.0-win-x64;$env:PATH"
```

只有显式选项才允许安装系统依赖，过程中可能需要管理员权限。可选 Node 安装从官方站点下载并校验 SHA-256，保存在用户目录，完成后打印后续终端需要加入 PATH 的目录。脚本不会修改代理、结束既有服务或重建用户数据库。已具备依赖时省略两个安装选项。

手动构建方式：

```sh
npm ci
npm ci --prefix apps/web
# 仅 Linux：
npm run build:helper:linux
# 仅 Windows，替代 Linux helper：
# npm run build:helper:win32
npm run build:all
```

详见 [Linux](docs/install/linux.md)、[Windows](docs/install/windows.md)、[macOS](docs/install/macos.md)。

## 首次初始化与启动

以下命令都在克隆目录中执行，不依赖全局 `nash` 命令。

```sh
node dist/index.js init
node dist/index.js config validate
node dist/index.js doctor
node dist/index.js start --background
```

交互向导依次确认节点角色（默认 Coordinator + Worker）、授权工作区、监听/公布地址、可选 PostgreSQL、主模型、安全模型关系、安全策略和用户自己的管理员账号。密码及 API Key 通过受保护提示输入，不放进命令行参数。输入有误可取消重来；已有有效配置不会被静默覆盖。

省略 `--background` 时会在当前终端前台运行，查询状态或停止时另开终端。

打开 `start` 输出的地址；本地默认是 [http://127.0.0.1:18443](http://127.0.0.1:18443)。端口 18443 **不代表自动启用 HTTPS**。跨不可信网络前，需要配置可信的 HTTPS/WSS 接入地址。

产品数据默认位于 `~/.nash-agents`。可通过 `NASH_HOME` 改变位置，但后续**每次**命令都要使用同一设置，避免与旧 `~/.nash` 工程混用。

```sh
node dist/index.js status
node dist/index.js stop
```

## 添加 Worker

每台 Worker 都独立克隆并构建正式仓库。在 Coordinator 生成一次性邀请：

```sh
node dist/index.js node invite
```

在 Worker 执行：

```sh
node dist/index.js init --role worker
node dist/index.js node join
node dist/index.js start --background
```

按提示输入 Coordinator 地址、节点名、授权工作区和邀请码。Worker 默认通过认证网关继承模型，不应复制 Coordinator 的模型 API Key。公布地址必须能从 Worker 访问；`127.0.0.1` 只适用于同机访问。

[Worker 注册与撤销](docs/install/workers.md)介绍项目授权、重连和常见配对错误。

## 执行第一个任务

使用初始化时创建的管理员登录。先在 **Projects** 添加明确授权的项目，在 **Nodes** 确认 Worker 在线，然后打开 **Chat**，从只读请求开始：

> 查看已授权项目的目录结构并解释主要模块，不修改文件，不访问网络。

检查任务的真实工具事件、执行 Worker、审批和最终结果。在 **Graphs** 查看依赖，在 **Artifacts** 核对产物。一次普通文本回答不能代替沙箱、多节点或模型工具调用验收。

## 模型与安全

每份模型配置可独立选择 Chat Completions、Responses 或 Anthropic Messages。安全模型可动态跟随主模型、复用同一 Provider 的不同模型，或独立配置。详见[模型配置](docs/install/models.md)。

产品初始化默认使用**受限模式**：`workspace-write`、`network: deny`、`approval: ask`，同时开启 Security Monitor 与独立 Security LLM。完全访问（`danger-full-access`、`network: allow`、`approval: auto-grant`）属于显式选项：交互向导会展示风险并要求确认，非交互产品初始化必须同时提供这三个值并设置 `confirmFullAccess: true`。初始化后在 **Web → Security** 修改产品安全配置；开发者 REPL 的首次建议不改变产品默认值。`auto-grant` 表示安全审查通过后执行，而不是跳过检查：确定性硬拦截永不可审批，安全模型不可用时失败关闭。完全访问会放弃完整文件系统隔离保证，请自行确认目标目录。详见[安全策略](docs/operations/security.md)。

## 运维与升级

参阅 [Web 配置](docs/operations/web.md)、[故障排查](docs/operations/troubleshooting.md)、[备份与恢复](docs/operations/backup-restore.md)、[升级](docs/operations/upgrade.md)。升级前备份完整产品目录及外部 PostgreSQL，选择已审核的 Git 提交，重新构建、校验再启动。重新安装不能代替数据迁移。

## 架构、演示与验证

- [当前架构与执行边界](docs/operations/architecture.md)
- [可复现功能演示](docs/demo/scenarios.md)

## 文档与开发

- [首次使用完整流程](docs/install/first-run.md)
- [架构说明](docs/operations/architecture.md)
- [兼容性与验收矩阵](docs/release/verification.md)
- [发布检查清单](docs/release/checklist.md)、[Release Notes 模板](docs/release/release-notes-template.md)
- [参与贡献](CONTRIBUTING.md)、[安全报告](SECURITY.md)、[变更记录](CHANGELOG.md)

```sh
npm run typecheck
npm run typecheck:web
npm test
npm run build:all
```

实际界面截图将在正式运行验证后补充。不会将模拟截图或虚构节点状态当成安装证据。

采用 [Apache-2.0](LICENSE) 许可证。第三方组件及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；平台与协议兼容范围见[验证矩阵](docs/release/verification.md)。
