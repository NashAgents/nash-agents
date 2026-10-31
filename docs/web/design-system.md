# Nash Web Control Plane: 设计系统规范 (Design System)

## 1. 设计语言理念

Nash Web Control Plane 采用自主定义的极简工作台设计，同时融合工业级控制台的信息密度与现代 Web 应用的丝滑触感。整体风格以**暗黑极简主义**为主基调，提供无缝亮色模式切换支持。

---

## 2. 色彩系统 (Color Palette)

系统采用语义化色彩 tokens，基于 Tailwind CSS 构建：

| 角色 | 命名 | 暗色值 (Dark) | 亮色值 (Light) | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| **品牌主色** | `primary-500` / `brand` | `#f97316` (Nash Amber) | `#ea580c` | 核心 CTA 按钮、主强调标识、活跃光标 |
| **主背景底色** | `surface-950` | `#09090b` (Deep Obsidian) | `#f4f4f5` | 全局页面背景、代码块深层底色 |
| **容器卡片底色** | `surface-900` | `#121215` (Elevated Surface) | `#ffffff` | 侧边栏、卡片面板、对话泡背景 |
| **边框与分割线** | `surface-800` | `#27272a` (Subtle Border) | `#e4e4e7` | 视口分割线、表格边框、输入框横线 |
| **弱化文字** | `surface-400` | `#a1a1aa` (Muted Text) | `#71717a` | 时间戳、元数据、辅助提示 |
| **主标题文字** | `surface-100` | `#f4f4f5` (High Contrast) | `#18181b` | 页面标题、主要正文 |
| **用户消息卡片** | `charcoal-user` | `#1e1e22` (Charcoal Gray) | `#e4e4e7` | 全宽用户消息通栏卡片 |
| **成功态** | `emerald-500` | `#10b981` | `#059669` | 节点在线、任务成功、产物已校验 |
| **警告态** | `amber-500` | `#f59e0b` | `#d97706` | 审批等待、候选澄清、任务阻塞 |
| **危险态** | `rose-500` | `#f43f5e` | `#e11d48` | 节点离线、任务失败、操作拒绝 |

---

## 3. 字体系统与排版 (Typography)

- **无衬线字体 (UI Font)**：`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`
- **等宽字体 (Code Font)**：`ui-monospace, SFMono-Regular, "Cascadia Code", "Fira Code", Consolas, Menlo, monospace`
- **行高与字距**：正文行高 `1.6`，标签与元数据字距 `tracking-tight` 或 `tracking-wider`。

---

## 4. 核心基础组件库

1. **`Button.vue`**：支持 `primary`、`secondary`、`ghost`、`danger` 四档变体；内置 Loading 转轮与禁用态动画。
2. **`Badge.vue`**：支持 `neutral`、`success`、`warning`、`danger`、`info` 五档变体；具备脉冲动效指示器 (`animate-pulse`)。
3. **`Modal.vue`**：模态弹窗系统，支持背景遮罩点击关闭、Esc 键安全监听、视口居中。
4. **`EmptyState.vue`**：空数据占位组件，提供统一的矢量图标、主副标题与一键操作引导。
5. **`ChatMessage.vue`**：富文本渲染气泡，支持 Markdown 代码高亮、表格自适应排版、工具折叠面板与思考摘要。
6. **`ChatInputBox.vue`**：核心输入框，集成中文输入法合成事件保护 (`isComposing`)、运行态 Steer 暂存队列条、中断与停止控制。
