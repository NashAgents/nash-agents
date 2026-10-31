# 故障排查

先记录 Git commit、Node 版本、命令退出码、平台、脱敏配置版本，再运行：

```sh
node dist/index.js config validate
node dist/index.js doctor
node dist/index.js status
```

| 现象 | 检查与处理 |
| --- | --- |
| 仓库访问失败 | 公开仓库可直接用 HTTPS 克隆；如使用 SSH remote，核对本机 key、代理与网络。不要复制其他机器凭据或把 Token 写进 URL |
| Git 指向不可用代理 | 核对当前会话代理设置及来源；安装器不修改代理，问题报告不包含认证 URL |
| Node 版本错误 | 使用 24.14.0–24.x，检查实际 `node` 路径；不要卸载其他服务依赖的版本 |
| 原生 helper 缺失 | 在目标 OS 重新构建 helper，核对 SHA-256 和协议输出 |
| Bubblewrap/namespace 不可用 | 检查内核与组织策略；不自动禁用沙箱或降低安全策略 |
| Windows helper 编译失败 | 检查 MSVC C++ workload、Windows SDK、重启要求和 helper 输出 |
| 端口占用 | 确认服务归属，选择空闲端口；不要按端口或进程名称批量终止其他应用 |
| 管理员无法登录 | 确认使用同一 NASH_HOME 和实际创建的账号；不要寻找固定测试密码 |
| Worker 连接失败 | 核对公布地址、TLS、网络、邀请有效期与身份撤销状态 |
| 网关失败 | 核对节点认证、Coordinator 的模型配置版本和 Provider 连接，不能向 Worker 复制原始 API Key |
| 模型有文本但工具失败 | 单独检查工具参数、工具结果格式、多轮推理块和所选协议 |
| 配置密钥缺失 | 恢复与 product.db 匹配的 master.key，不生成新密钥伪装修复旧数据库 |
| 内存不足 | 串行构建、检查 Swap 和机器资源；保留其他服务，必要时由管理员扩容 |
| 任务掉线且有副作用 | 保留 outcome_unknown，核对实际产物后由管理员处理，不盲目重派 |

收集日志时去除 API Key、Cookie、管理员密码、邀请、Node Token、数据库 URL 和隐私模型输入。不要把完整产品目录附到公开 Issue。
