# 兼容性与验证范围

本页说明 Nash Agents 已验证的能力范围，以及哪些组合需要使用者自行确认。它不是对所有环境、所有模型服务或所有第三方集成的通用兼容承诺。

## CI 覆盖

每个提交在 GitHub Actions 的 `Validation` 工作流中执行：

| 作业 | 内容 |
| --- | --- |
| `security` | 产品审计（含 Git 历史）、依赖审计、第三方声明检查 |
| `unit-and-build`（Ubuntu / macOS / Windows） | 类型检查、构建、单元测试、打包校验 |
| `postgres` | PostgreSQL 集成测试 |
| `browser` | 浏览器端到端与视觉测试 |
| `windows-release-helper` | Windows 原生 helper 构建与产物摘要 |
| `native-sandbox` | 三平台原生沙箱测试；由 `workflow_dispatch` 触发，不在每次 PR 中运行 |

历史提交的成功结果不自动适用于新提交；以对应提交的 Actions 结果为准。

## 平台执行边界

| 平台 | 原生沙箱 | 说明 |
| --- | --- | --- |
| Linux | Bubblewrap（Landlock 可用时启用） | 需要 C 编译器与 `bubblewrap`；内核或组织策略可能限制隔离能力 |
| Windows 11 x64 | AppContainer / ACL / Job Object | 需要 Windows Sandbox helper；AppContainer 能力不足时按策略失败关闭 |
| macOS | Seatbelt（`/usr/bin/sandbox-exec`） | 以系统自带沙箱能力为准 |

所需后端缺失、初始化失败或能力校验不通过时，受限策略的调用会被拒绝，而不是降级为无隔离执行。

## 模型与协议

- 支持 **Chat Completions**、**Responses** 与 **Anthropic Messages** 三种协议适配。
- 主模型必须支持工具调用；不调用工具的纯文本模型无法完成需要执行的任务。
- 安全审查模型可独立配置；不可用时调用按策略失败关闭（需要审批或拒绝），不会静默放行。
- 协议兼容不等于各 Provider、模型版本或参数组合均已实测通过。

## 状态与持久化

- 单机部署可使用本地存储；生产持久化推荐 PostgreSQL。
- 管理员与版本化配置保存在独立的 SQLite 数据库，与 PostgreSQL 集群数据职责不同。
- 升级前应建立一致性备份，并在升级后核对发布身份（commit、构建产物摘要与运行进程身份）。

演示与证据采集方式见[功能演示](../demo/scenarios.md)；安装与平台细节见[安装文档](../install/)。
