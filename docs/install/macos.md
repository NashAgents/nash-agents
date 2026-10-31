# macOS 安装

需要 Git、Node.js >=24.14.0 <25，以及系统自带的 `/usr/bin/sandbox-exec`。macOS 版本和 CPU 架构应单独记录。不要假定 Linux 的 Bubblewrap 或 Windows helper 适用于 macOS。

```sh
git clone https://github.com/NashAgents/nash-agents.git
cd nash-agents
bash scripts/install.sh --install-node
# Apple Silicon; Intel Macs use darwin-x64 instead of darwin-arm64.
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/nash-agents/toolchains/node-v24.14.0-darwin-arm64/bin:$PATH"
node dist/index.js init
node dist/index.js doctor
node dist/index.js start --background
```

仓库公开，可直接用 HTTPS 克隆，不需要预先配置 GitHub 授权；如使用 SSH remote，使用本机自己的 key。已有兼容 Node.js 时省略 `--install-node`。安装器不自动安装 Homebrew、不修改系统安全策略。

原生 Seatbelt 探测失败时停止执行，检查操作系统限制；不能用 Full Access 代替沙箱验收。运行实际工具任务后才能确认工作区写入与网络策略生效。不要将开发 Mac 的既有配置复制给首次使用的机器。
