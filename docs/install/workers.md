# Worker 加入集群

Worker 是独立机器上的原生执行节点。SSH 仅用于部署管理，任务通信使用 Nash 自身的认证连接。

## 准备

每台 Worker 独立克隆公开正式仓库、安装依赖、构建对应平台 helper。先运行 `doctor`（Windows 另运行 `sandbox doctor`），确认本机沙箱可用。为每个节点指定清晰名称和真实授权工作区。

在 Coordinator：

```sh
node dist/index.js node invite
```

邀请是敏感的一次性注册凭据，仅通过可信渠道交给加入者。不要把邀请贴入公开 Issue、日志或截图。

在 Worker：

```sh
node dist/index.js init --role worker
node dist/index.js node join
node dist/index.js start --background
```

交互输入 Coordinator 地址与邀请码，避免把邀请码放进 argv 或 Shell 历史。TLS 连接使用可信证书，不能使用忽略证书错误作为正式流程。使用自定义证书时，证书 SAN 必须包含 Worker 实际连接的地址或主机名；同机 Worker 通过 `wss://127.0.0.1:<port>` 连接时，证书必须包含 `IP:127.0.0.1`。

在 Coordinator：

```sh
node dist/index.js node list
```

确认节点 ID、名称、在线状态与沙箱能力。在 Web 的 Projects/Nodes 配置访问授权，实际运行一个限定工作区的任务。节点在线不等于具备任意项目权限。

## 身份与模型

注册后保留独立节点身份。日常重连使用该身份，不重复消费旧邀请；重复、过期或已撤销邀请应拒绝。Worker 默认通过网关继承主模型与安全模型，无需 Provider API Key。

不要复制别的节点身份文件，不要把产品目录打包给多台机器，否则会制造重复身份。备份恢复同一节点时保留自己的身份并确保旧实例已退出。

## 撤销与重新加入

在 Nodes 中对明确选中的节点撤销；被撤销身份不得继续连接。需要重新配对时，由管理员确认并生成新的邀请。不要通过直接删除数据库记录来绕开状态机。

若配对失败，分别检查 URL、TLS 信任、网络、邀请有效期、是否已被消费、节点是否已注册，以及 Coordinator 诊断记录。节点断线且任务有副作用时需要保留 `outcome_unknown`，不能盲目再次执行。
