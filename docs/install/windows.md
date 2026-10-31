# Windows 安装

目标环境为 Windows 11 x64。必须在目标机器上构建并验证原生 helper；Mac/Linux 上编译 TypeScript 不能证明 Windows 原生沙箱可用。

## 1. 前提

- Windows PowerShell 5.1 或 PowerShell 7。
- Git。仓库公开，可直接用 HTTPS 克隆，不需要 GitHub 私有仓库授权；如使用 SSH remote，使用本机自己的 key。
- Node.js >=24.14.0 且 <25。
- Visual Studio 2022 Build Tools，“使用 C++ 的桌面开发”与 Windows SDK。
- 使用可写的普通用户目录作为工作区。系统管理员限制的 AppContainer 能力需由管理员检查。

克隆仓库后在其目录打开 PowerShell。安装器不会更改全局 ExecutionPolicy。若组织策略阻止执行，请按组织要求授权此文件，不要全局关闭脚本策略。

## 2. 安装与构建

```powershell
powershell -NoProfile -File scripts/install.ps1 -InstallSystemDeps -InstallNode
$env:PATH = "$env:LOCALAPPDATA\NashAgents\toolchains\node-v24.14.0-win-x64;$env:PATH"
```

`-InstallNode` 单独允许下载官方 Node.js ZIP，校验 SHA-256，并放入当前用户的 `%LOCALAPPDATA%\NashAgents\toolchains`。脚本会打印需要加入后续终端 PATH 的目录。

`-InstallSystemDeps` 单独允许用 winget 安装缺少的 Git、Visual Studio Build Tools 和 C++ 工具链，可能出现 UAC 或要求重启。遇到重启要求先按提示重启，再重新执行安装器。未提供该选项时只检查环境并给出缺项。

已经手动安装依赖时：

```powershell
powershell -NoProfile -File scripts/install.ps1
```

安装器执行根目录/Web 的锁文件安装、`build:helper:win32` 和 `build:all`。helper 通过 `--version-json` 验证协议；这一步不等于 AppContainer/DACL 真实越权测试通过。

## 3. 初始化与启动

```powershell
node dist/index.js init
node dist/index.js config validate
node dist/index.js sandbox doctor
node dist/index.js start --background
```

Worker 初始化与邀请配对见[加入集群](workers.md)。始终使用本机的授权工作区，不能把 Coordinator 的文件路径当作 Windows 路径。

双击仓库的 `start.bat` 也可调用同一 `start` 入口；BAT 只含 ASCII，不打开额外 CMD 窗口。首次初始化和构建仍须事先完成。

## 4. 安全验收

Windows helper 必须验证 AppContainer、目录 DACL、受限 Token 和 Job Objects。应确认受限写入只能访问授权目录、不能读取额外秘密、子进程继承约束，并且取消后进程树结束。

```powershell
node dist/index.js sandbox doctor
node dist/index.js doctor
```

遇到 `SandboxUnavailableError` 应修复 helper 或系统能力，不能切换 Full Access 绕过。不要手工给 Entire disk/Everyone 添加写权限。管理员权限本身也不能代替隔离验证。

## 5. 端口与退出

端口被占用时先使用 Diagnostics/系统工具确认占用者，选择另一个端口或由管理员处理已确认的旧实例。安装器与启动器不会用端口号批量 `taskkill`。用 `node dist/index.js stop` 结束本产品管理的服务；不要终止其他项目的 Node 进程。

验证记录应包含 Windows 版本、MSVC/SDK 版本、helper SHA-256、实际隔离测试和取消清理结果。未完成这些步骤时应标记待验收。
