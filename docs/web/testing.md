# Nash Web Control Plane: 测试体系 (Testing)

## 1. 测试体系概览

Web 控制台的自动化验证分为两层：

1. **后端 API 与安全套件** (`test/cluster-phase5-web-api.test.ts`)：覆盖密码防暴破、HttpOnly Cookie、CSRF Token、会话生命周期、产物 CRUD 与防逃逸流式下载、全局 SSE 连接。
2. **浏览器 E2E 渲染与多端视觉测试** (`test/browser-e2e-visual.test.ts`)：基于 `playwright-core` 调用系统 Chrome（headless），覆盖 Desktop (1440x900)、Tablet (820x1180)、Mobile (390x844)。

浏览器测试在运行时把截图写入系统临时目录，并在 `after` 钩子中删除；截图不作为仓库证据提交。未安装 Chrome 的环境会跳过该套件，跳过原因会显示在测试输出中——跳过不是通过。

## 2. 验收记录口径

本仓库不附带预生成的截图或历史 PASS 表。视觉验收必须在目标机器上重新运行，并以该次运行的输出与截图为证据；如需保留截图，请保存在仓库之外。源码存在不代表任何平台、模型或浏览器组合已经通过验收。

## 3. 运行指令

```bash
# 后端 Web API 单元与集成测试
npx tsx --test test/cluster-phase5-web-api.test.ts

# 真实浏览器 E2E 多端视觉测试（需要本机 Chrome）
npx tsx --test test/browser-e2e-visual.test.ts

# 全量 Cluster 套件
npx tsx --test test/cluster-*.test.ts
```

测试数量随代码变化，以实际运行输出为准。
