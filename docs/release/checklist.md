# 发布准备检查清单

目标版本：**0.1.0（未正式发布）**。仓库源码已公开，许可证 Apache-2.0。本清单不授权创建 Tag、GitHub Release、npm 包发布、强推、合并 PR 或生产变更。

## 源码与供应链

- [ ] 对确定的发布 Tag/SHA 执行干净 checkout 与锁文件安装。
- [ ] 在 Linux/macOS/Windows 检查 typecheck、构建、单测、数据库、浏览器、安全与原生沙箱，记录 skipped，不复用其他提交的结果。
- [ ] 实际平台构建 helper；校验源码摘要、构建清单和 Artifact SHA-256。
- [ ] 完成 Secret、历史提交、个人目录、节点身份、第三方商标引用审计；不得删除必要许可、NOTICE、真实协议名称。
- [ ] 校验 LICENSE、THIRD_PARTY_NOTICES、依赖清单和发布包内容，无生产凭据或私人配置。

## 功能与文档

- [ ] README / 中文 README、[架构](../operations/architecture.md)、[演示](../demo/scenarios.md)、[验收矩阵](verification.md)与目标版本一致。
- [ ] 明确实际模型、协议与平台的验证范围，不声称所有环境已兼容。
- [ ] 项目授权、Grant/撤销 ACK、原生沙箱、MCP 安全边界、GoalRun/Graph 与事件恢复具备可复核证据。
- [ ] 备份与恢复、数据库迁移、admission freeze/drain、未知副作用任务防重放有明确操作手册。
- [ ] GitHub Description、Topics、Homepage 已人工核对；不能把生产 IP 用作公开主页。
- [ ] 安装文档不将未发布的 `npm install -g nash-agents` 当作已存在的官方分发方式。
- [ ] 维护者独立授权发布行为。

## npm Staged Publishing

- [ ] 使用 [npm Staged Publishing 流程](npm-staged-publishing.md)；npm CLI >= 11.15.0。
- [ ] `npm-release` Environment 仅保存 Stage-only GAT（`read-write-stage-only`），不使用高权限或 bypass 2FA Token。
- [ ] `v0.1.0` 为轻量标签，指向 `main` 上同时通过 push 与 workflow_dispatch Validation 的实际发布提交。
- [ ] 工作流只 stage 已通过测试与 SHA-256 校验的同一个 tarball，并用 `npm stage download` 逐字节复核。
- [ ] 维护者本人通过 2FA 审批；自动化不得运行 `npm publish` 或 `npm stage approve`。
- [ ] 审批后验证 registry 版本、`latest`、Provenance 与源码提交一致，再做隔离环境真实安装。
- [ ] 切换 Trusted Publishing 后移除临时 Token，并撤销临时凭据。

[发布流程](npm-staged-publishing.md) · [验证矩阵](verification.md) · [Release Notes 模板](release-notes-template.md)
