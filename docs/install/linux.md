# Linux 安装

目标环境为 Ubuntu 22.04 LTS x64；脚本也接受 Debian/Ubuntu 的其他版本及 Linux arm64，但必须单独验收内核、helper 与模型调用，不宣称自动兼容所有发行版。

## 1. 获取正式源码

仓库是公开的，可直接用 HTTPS 克隆，不需要 GitHub 认证。若使用 SSH remote，应使用这台机器自己的 SSH key，不能依靠开发机器的 SSH Agent 转发。进入克隆目录；不要使用另一台机器复制来的 `dist/` 或数据库。

## 2. 安装与编译

```sh
bash scripts/install.sh --install-system-deps --install-node
# Linux x64: make the optional local Node toolchain available in this shell.
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/nash-agents/toolchains/node-v24.14.0-linux-x64/bin:$PATH"
```

`--install-system-deps` 允许通过 apt 安装 `ca-certificates curl git build-essential bubblewrap python3`，非 root 用户会使用 sudo。`--install-node` 允许下载官方 Node.js 24.14.0 tarball 并验证官方 SHA-256，然后安装至当前用户的本地工具链。二者分别控制，省略时只检查已有环境。

安装脚本顺序执行根目录 `npm ci`、Web `npm ci`、Linux helper 构建和 `npm run build:all`。不启动后台服务、不修改代理、不停止已有服务、不安装 Docker。

Node.js 版本必须是 24.14.0–24.x；已有不兼容版本不会被全局卸载。脚本会打印用户工具链目录；在后续终端中把该目录的 `bin` 加入 PATH。Node 下载校验和只能证明下载完整性，不能替代源代码和依赖审计。

手动安装依赖时使用本发行版包管理器；不要给沙箱设置特权模式绕过限制。

## 3. 初始化

```sh
node dist/index.js init
node dist/index.js config validate
node dist/index.js doctor
node dist/index.js start --background
```

单机默认 Coordinator + Worker，可使用本地持久化。PostgreSQL 为可选生产存储，不能误连已有业务库。详见[首次使用](first-run.md)及[备份](../operations/backup-restore.md)。

## 4. 原生沙箱

Bubblewrap 可执行文件存在不等于隔离可用。内核必须允许需要的 user/mount/PID/network namespace，原生 helper 必须能启用 seccomp/no_new_privs。支持的 Landlock 后端仅在探测满足策略时使用；不满足时拒绝执行。

```sh
bwrap --version
node dist/index.js doctor
```

不要通过全局关闭 AppArmor、开放全部 user namespace、运行 Docker privileged 或改为 danger-full-access 来取得“通过”结果。具体系统政策调整需由机器管理员针对诊断结果决定。

## 5. 资源与代理

先检查磁盘、RAM 和 Swap。若机器有其他负载，保持原服务运行，逐台串行构建；可对单次命令设置 `NODE_OPTIONS=--max-old-space-size=1536` 限制 Node 堆，但限制过低仍可能导致构建失败。不要把结束未知进程当作安装步骤。

安装器遵循当前进程的网络环境，不会修改代理。若已有代理失效，请由用户核对并修正当前会话环境；不要将含认证的代理 URL 粘进问题报告。

## 6. 后台运行

`start/stop/status` 管理本产品的运行状态。若需要 systemd，使用专用系统账户、绝对的 Node/仓库路径、受保护的环境文件和独立服务名；审核后再启用。不要覆盖同名现存服务。多台 Coordinator 共用本地 `state.bin` 或网络盘不属于受支持部署。
