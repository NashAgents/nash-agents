# Nash Web Control Plane: 分布式任务图与 DAG 可视化 (TaskGraph UI)

## 1. 架构目标

分布式任务图控制台 (`/graphs`) 旨在为复杂多节点协同任务提供**毫秒级实时状态反馈**、**DAG 拓扑可视化**以及**全生命周期控制**。

---

## 2. 桌面端 Vue Flow 拓扑画布 (TaskGraphFlow)

在 Desktop 和 Tablet 视口下，系统采用 `@vue-flow/core` 驱动原生 SVG/Canvas 渲染：

### 2.1 节点形态与状态染色 (GraphNodeCustom)
- **节点卡片设计**：
  - 顶部：节点标题与操作类型标记（`analyze` / `execute` / `verify` / `synthesize`）。
  - 中部：分配的目标节点与执行项目、入站/出站产物标签。
  - 底部：执行状态与单调递增耗时指示。
- **状态色彩映射**：
  - `pending` / `waiting_dependencies`：灰色边框，暗度表面。
  - `dispatched` / `running`：蓝色边框，外层光晕动效。
  - `completed`：翠绿色边框，右下角带有 `✓` 标记。
  - `failed`：玫瑰红边框，展示简要错误信息。
  - `cancelling` / `cancelled`：橙黄色或灰红色边框。
  - `blocked`：暗红色边框，标记前置依赖未达成。

### 2.2 Join Barrier 汇聚动效
- 当两个并行节点（如分支 1 和分支 2）指向同一 Join Barrier 节点时，连线以平滑贝塞尔曲线汇聚。
- 上游节点生成产物时，沿连线展示微光流动动效。
- 仅当全部上游产物均已就绪且核验成功时，Join Barrier 节点自适应点亮为 `dispatched`。

### 2.3 画布控制工具条
- **缩放与适配**：`放大 (+)`、`缩小 (-)`、`一键居中全览 (Fit View)`。
- **状态筛选**：支持按 `全部`、`运行中`、`失败`、`待审批` 进行高亮过滤。
- **导出能力**：一键导出当前 DAG 为 PNG 图像或结构化 JSON。

---

## 3. 移动端垂直阶段卡片流 (GraphStageList)

在 Mobile 视口下，Vue Flow 画布自动平滑替换为垂直线性阶段卡片流：
- 顶部概览仪表盘：展示任务图全局进度条、阶段完成率、节点总览。
- 阶段卡片列表：按拓扑顺序排列，每个阶段包含其拥有的节点卡片。
- 点击卡片即可展开查看节点在远程物理节点上的执行详情、入站产物与日志。
