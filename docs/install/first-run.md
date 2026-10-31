# 首次使用流程

所有命令从正式 GitHub 仓库的独立克隆运行。安装与构建不创建管理员、不复制模型密钥、不接触其他产品的数据。

## 初始化前

确认当前目录、Node 版本、helper、可用端口、磁盘与内存。准备模型 API 协议、Base URL、模型名称和自己的凭据。确定授权工作区、管理员账号与至少 12 字符的密码。

```sh
node --version
node dist/index.js init
```

## 向导选择

1. 角色：默认 Coordinator + Worker；仅调度时选 Coordinator；执行节点选 Worker。
2. 地址：本地使用回环地址；跨节点时选择目标网络能到达的公布地址。监听地址和公布地址不是同一概念。
3. 持久化：单 Coordinator 可用本地状态存储；生产可指定独立 PostgreSQL。管理员和模型配置始终在产品 SQLite 中。
4. 主模型：按实际服务选择三种协议之一，填写 Base URL、模型名与凭据。
5. 安全模型：默认动态跟随主模型，也可同 Provider 不同模型或完全独立配置。
6. 安全：默认 workspace-write、限制网络并审批；只有用户明确确认才允许 Full Access。非交互产品初始化必须显式提供 `danger-full-access`、`network: allow`、`approval: auto-grant` 和 `confirmFullAccess: true`；`NASH_INIT_ACCESS_MODE` 只属于开发者 REPL，不作用于产品初始化。
7. 管理员：创建自己的账号，不存在可供使用的固定测试账号。
8. Worker：填写本机名称、授权工作区和 Coordinator 地址。继承模型不需要 Coordinator 的 Provider API Key。

取消后重新执行 `init`；已有有效配置不会被覆盖。不要删除整个产品目录来“重新配置”，应使用 Web 设置和版本恢复。

## 启动与验证

```sh
node dist/index.js config validate
node dist/index.js doctor
node dist/index.js start --background
node dist/index.js status
```

打开启动输出的 Web URL 并登录。在 Projects 添加本机明确授权的目录，在 Nodes 确认在线 Worker，再用 Chat 发起只读任务。检查真正的工具调用和执行事件。

`NASH_HOME` 默认指向 `~/.nash-agents`。选择自定义目录后，每次 init/start/stop/config/upgrade 都需要同一个环境值。不同产品目录对应不同管理员、配置和节点身份。

## 自动化初始化

自动化可以使用 `init --config <JSON文件>`；文件内容遵循 `ProductInitInput`，包含管理员密码和 API Key，因此必须仅对当前用户可读、放在仓库之外、避免 CI 日志输出，完成后立即删除。普通用户优先使用交互向导，不需要编写包含明文秘密的配置示例。

初始化保存前会实际测试已配置模型的文本、工具参数、多轮、流式与取消能力；包含 Worker 的角色还需本机沙箱诊断通过。失败时不激活半配置。即便初始化成功，Web 登录、网关和真实任务仍应分别验收。
