# npm Staged Publishing 发布流程

本文件描述 `nash-agents` 首次正式发布（`v0.1.0`）使用的 npm Staged Publishing 流程。它不授权发布本身；实际审批必须由维护者本人完成 2FA。

## 前置条件

- npm CLI **>= 11.15.0**。工作流固定使用 `npm@11.21.1`，并在执行前断言版本不低于 11.15.0。
- npm 账号已开启 2FA。
- GitHub Environment `npm-release` 中存在 `NPM_STAGE_TOKEN`。
- Token 必须是 Granular Access Token，包权限为 **`read-write-stage-only`**（Stage-only）。不得使用 `read-write`、bypass 2FA 或长期高权限 Token。
- 仓库与 npm 包均为公开访问；Provenance 需要公开仓库和 `id-token: write`。
- `nash-agents` 在 npm 上尚不存在。npm 的 staged publishing 允许为不存在的包创建 staged 版本；Token 必须对该包名有写权限。

## Tag 规则

- 使用**轻量标签** `v0.1.0`，不要使用 annotated tag。
  - npm Provenance 将 `GITHUB_SHA` 写入 `resolvedDependencies[0].digest.gitCommit`。annotated tag 会让该值可能指向 tag object 而不是提交；发布守卫会直接拒绝。
- Tag 必须指向 `main` 上通过 CI 的实际发布提交，不得假定初始提交或旧提交仍然有效。
- 该提交必须同时存在两个成功的 `Validation` 运行：
  - `push` 触发的完整跨平台测试；
  - `workflow_dispatch` 触发的测试，包含 `native-sandbox` 三平台原生沙箱作业。
  - 手动触发示例：`gh workflow run ci.yml -R NashAgents/nash-agents --ref main`
- 历史提交的 CI 结果不能替代目标提交的结果。

## 工作流阶段

`.github/workflows/npm-publish.yml` 由 `v*` tag push 或对 tag ref 的 `workflow_dispatch` 触发：

1. **release-guard**
   - 校验 `package.json` 的 `nash-agents@0.1.0`、公开许可证/仓库/registry 配置。
   - 校验 tag 为轻量标签，且 tag、`HEAD`、`GITHUB_SHA` 指向同一提交。
   - 校验工作区干净、提交在 `origin/main` 上。
   - 通过 GitHub Actions API 校验该提交存在成功的 `push` 与 `workflow_dispatch` Validation 运行。
2. **windows-helper**
   - 在 Windows 原生构建 helper，校验 manifest 的 `sourceCommit` 与发布提交一致，运行平台测试。
3. **verify-and-pack**
   - 构建 Linux helper，下载 Windows helper，校验两个 helper 的源码/二进制摘要。
   - 类型检查、构建、工作区产物绑定校验、单元测试、依赖审计、许可证检查、`verify-package.js --release`。
   - 打包实际 tarball，生成 `SHA256SUMS`，并校验 tarball 内部的 `dist/build-info.json`、Web 构建信息、原生 helper manifest 全部绑定到发布提交。
4. **publish**
   - 使用 `npm-release` Environment 中的 Stage-only Token，仅通过 `NODE_AUTH_TOKEN` 传递。
   - 下载并再次校验测试过的 tarball；`sha256sum --check` 通过后才认证。
   - 执行 `npm stage publish <tarball> --provenance --access public --tag latest`。
   - 通过 `npm stage view` 与 `npm stage download` 下载 staged tarball，逐字节比较 SHA-256，并再次校验内部提交绑定。
   - 输出 Run URL、Stage ID、版本、两个 SHA-256 与 Provenance 状态。
   - **到此停止**：不执行 `npm publish`，不执行 `npm stage approve`。

## 审批

由维护者本人在本地或 npm 网页完成 2FA 审批：

```bash
npm stage approve <stage-id>
```

审批前核对：

- Stage ID 与工作流摘要一致；
- 版本为 `0.1.0`，dist-tag 为 `latest`；
- staged tarball SHA-256 与 `SHA256SUMS` / `release-manifest.json` 一致；
- Provenance 状态与 transparency log 链接（若 CLI 返回）。

自动化不得代替维护者审批。

如果此前已经为 `0.1.0` 创建过 staged 版本，版本号唯一索引会阻止重复 stage。先用 2FA 检查并拒绝旧 stage，再重新运行工作流：

```bash
npm stage list nash-agents
npm stage view <old-stage-id>
npm stage reject <old-stage-id>
```

## 审批后验收

```bash
npm view nash-agents@0.1.0 --json
npm view nash-agents dist-tags --json
npm view nash-agents@0.1.0 dist.integrity dist.shasum
```

- 确认 `latest` 指向 `0.1.0`。
- 用 `release-manifest.json` 中的 `tarballSha256` 核对发布 tarball；registry 的 `dist.integrity` 为 SHA-512，可在本地对同一 tarball 计算后比对。
- 在 npm 包页面检查 Provenance：workflow 为 `.github/workflows/npm-publish.yml`，ref 为 `refs/tags/v0.1.0`，commit 与 `release-manifest.json` 一致。
- 在全新隔离的 Linux 与 Windows 环境执行真实 `npm install -g nash-agents@0.1.0`，验证：
  - `nash --version`
  - `nash init` / `nash doctor` 等基本命令
  - 平台 helper 的存在与摘要
  - 正常退出码与无遗留后台进程
- 真实模型 E2E 若未执行，必须明确记录为未覆盖，不得虚构结果。
- 最后创建 GitHub Release `v0.1.0`，附上 tarball、`SHA256SUMS`、`release-manifest.json`、安装说明与准确的 Release Notes。Release 必须引用同一 tag/commit。

## 切换到 npm Trusted Publishing

首次发布审批完成后，包已存在，才能配置 trust relationship：

```bash
npm trust github nash-agents \
  --file npm-publish.yml \
  --repo NashAgents/nash-agents \
  --env npm-release \
  --allow-stage-publish \
  --yes
npm trust list nash-agents
```

要求：

- 仅授予 `--allow-stage-publish`，不启用不必要的直接发布权限。
- 验证 OIDC 路径可用后，从工作流移除 `NPM_STAGE_TOKEN` / `NODE_AUTH_TOKEN` 依赖，保留 `id-token: write`。
- 提示维护者撤销临时 Stage-only Token。
- GitHub Owner `NashAgents`、Repository `nash-agents`、Workflow `npm-publish.yml`、Environment `npm-release` 必须与 trust 配置一致。
