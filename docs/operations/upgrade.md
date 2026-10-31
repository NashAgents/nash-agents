# 升级与回滚

首次安装和保留数据升级必须分别验收。升级不会要求恢复干净快照、删除产品目录或重新创建管理员。

`nash upgrade` 的自动升级仅适用于独立 Git 源码工作区，不能用于 npm 全局安装。npm 安装需要先备份产品目录和外部数据库，再通过 npm 安装已审核且实际发布的目标版本，并执行配置、沙箱和真实任务验证；当前没有经过验收的 npm 发布版本。

## 升级流程

1. 阅读 CHANGELOG 和目标提交的迁移说明。当前没有正式发布 Tag，不使用不存在的版本号下载产物。
2. 记录当前 commit、产品配置版本、Worker 身份与运行状态；按[备份流程](backup-restore.md)保存完整产品目录和外部 PostgreSQL。
3. 停止本产品的任务提交和进程，不停止其他应用。
4. `git fetch origin`，审阅变更后切换到明确的目标 commit 或已审核分支。不得使用 `reset --hard` 丢弃未知改动；工作区有用户修改时先单独处理。
5. 重新执行本平台安装器，安装器按锁文件构建源码、Web 和 helper，不改用户配置。
6. `node dist/index.js upgrade` 只预检并显示当前版本。自动升级仅支持干净的 main 工作区；`node dist/index.js upgrade --apply` 才会 fetch origin/main、确认可快进、停止本产品、备份产品数据和旧产物，然后 ff-only、锁文件安装、helper/typecheck/build/单元测试。它不会自动重启，也不备份外部 PostgreSQL；外部数据库须按第 2 步单独备份。
7. 升级命令成功后显式执行 `node dist/index.js config validate`、`node dist/index.js doctor`、`node dist/index.js start --background` 和 `node dist/index.js status`，随后在 Web 登录并执行真实任务。失败时服务保持停止，命令会输出备份路径。
8. 各 Worker 依次升级并重连，确认 Node ID 保持、项目授权存在、模型网关正常。

升级验收至少核对：管理员保留、模型与密钥状态保留、节点身份保留、项目绑定保留、任务/Graph/Artifact 不丢失、数据库迁移结果、旧邀请码和已撤销身份仍按规则拒绝。

## 回滚

停止新版本后，先核对 schema 是否向后兼容。应用拒绝打开较新 schema 时不能删除版本标记强行运行。恢复匹配的旧程序、完整产品目录和外部数据库备份，再检查真实副作用。

### Schema 版本守卫（程序回滚时的确定性行为）

`ClusterDatabase.runMigrations()` 在应用任何迁移前读取 `cluster_schema_migrations` 的最高版本：

- 最高版本 **大于** 当前程序支持的 `LATEST_CLUSTER_SCHEMA_VERSION`（当前为 15）时，**直接抛错并整体回滚**，不会建表、不会补迁移、不会写入半迁移状态；
- 错误信息同时给出数据库实际版本与程序支持版本，并明确「不得删除版本标记强行运行」；
- 并发启动的多个进程同样全部被拒绝，不会出现一部分成功、一部分失败。

该守卫把「程序回滚到旧版本、但数据库已经被新版本迁移过」这种最容易产生静默数据错乱的场景变成一次显式失败。处置方式只有两种：**升级回匹配的新程序**，或**恢复与该旧程序匹配的数据库备份**。

迁移本身保持前向可加（`CREATE TABLE IF NOT EXISTS` / 可空新列），因此「旧数据库 → 新程序」始终是单向安全升级；真实数据库验证见 `test/cluster-postgres-schema-version-guard.test.ts`（v14→v15 只补一条且旧数据完整、重复执行幂等、超版 Fail-Closed 零写入）。

回滚不自动撤销已写入项目的文件或外部 API 操作。存在 outcome_unknown 时必须单独判断，不盲目再次执行。
