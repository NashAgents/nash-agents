import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  useWorkbenchLayoutStore,
  fitWorkbench,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  DEFAULT_CONTEXT_WIDTH,
  MIN_CONTEXT_WIDTH,
  MIN_CONVERSATION_WIDTH,
  DEFAULT_SIDEBAR_NAV_RATIO,
  MIN_SIDEBAR_NAV_HEIGHT,
  MIN_SIDEBAR_RECENT_HEIGHT,
} from "../apps/web/src/stores/workbench-layout.js";

const { setActivePinia, createPinia } = await import(
  new URL("../apps/web/node_modules/pinia/dist/pinia.mjs", import.meta.url).href
);

// 模拟 localStorage
class FakeLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function setup(t: TestContext) {
  const fakeStorage = new FakeLocalStorage();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = fakeStorage as any;

  const pinia = createPinia();
  setActivePinia(pinia);

  t.after(() => {
    for (const store of pinia._s.values()) store.$dispose();
    globalThis.localStorage = originalStorage;
  });

  return { fakeStorage };
}

test("1. 侧边栏与检查器尺寸约束：默认值与边界 Clamp 保护", (t) => {
  setup(t);
  const layout = useWorkbenchLayoutStore();

  assert.equal(layout.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
  assert.equal(layout.contextWidth, DEFAULT_CONTEXT_WIDTH);

  // 1.1 侧边栏最小与最大约束 (220 ~ 400px)
  layout.setSidebarWidth(100);
  assert.equal(layout.sidebarWidth, MIN_SIDEBAR_WIDTH, "侧边栏不能小于 220px");

  layout.setSidebarWidth(600);
  assert.equal(layout.sidebarWidth, MAX_SIDEBAR_WIDTH, "侧边栏不能大于 400px");

  layout.setSidebarWidth(320);
  assert.equal(layout.sidebarWidth, 320, "有效区间内正常设定");

  // 1.2 检查器最小约束 (>= 300px)
  layout.setContextWidth(200);
  assert.equal(layout.contextWidth, MIN_CONTEXT_WIDTH, "上下文面板不能小于 300px");

  layout.setContextWidth(550);
  assert.equal(layout.contextWidth, 550, "允许自由展开至更宽尺寸");
});

test("2. 中间 Conversation 空间优先守卫 (保障至少 500px)", (t) => {
  setup(t);
  const layout = useWorkbenchLayoutStore();

  // 假设小屏幕视口 1100px：
  // 若 contextWidth 为 400px，展开状态下最大允许侧边栏宽度 = 1100 - 400 - 500 = 200px -> Clamp 到 MIN (220px)
  const maxSidebar = layout.getMaxSidebarWidth(1100, 400, true);
  assert.equal(maxSidebar, MIN_SIDEBAR_WIDTH);

  // 若视口为 1440px，context 为 400px：
  // 1440 - 400 - 500 = 540px -> 受到 MAX_SIDEBAR_WIDTH (400px) 限制
  const maxSidebarWide = layout.getMaxSidebarWidth(1440, 400, true);
  assert.equal(maxSidebarWide, MAX_SIDEBAR_WIDTH);

  // 设定超出可用空间的宽度时自动 Clamp
  layout.setSidebarWidth(380, 1100, 400, true);
  assert.equal(layout.sidebarWidth, MIN_SIDEBAR_WIDTH);
});

test("3. 侧边栏垂直分栏：功能导航与最近会话高度分配", (t) => {
  setup(t);
  const layout = useWorkbenchLayoutStore();

  assert.equal(layout.sidebarNavRatio, DEFAULT_SIDEBAR_NAV_RATIO);

  // 容器总高度 800px：
  // 最小导航高度 140px，最小最近会话 120px（即最大导航高度 800 - 120 = 680px）
  layout.setSidebarNavHeight(50, 800);
  assert.equal(layout.sidebarNavHeight, MIN_SIDEBAR_NAV_HEIGHT, "导航高度不得小于 140px");

  layout.setSidebarNavHeight(750, 800);
  assert.equal(layout.sidebarNavHeight, 800 - MIN_SIDEBAR_RECENT_HEIGHT, "必须为最近会话保留至少 120px");

  layout.setSidebarNavHeight(350, 800);
  assert.equal(layout.sidebarNavHeight, 350);
  assert.equal(layout.sidebarNavRatio, 350 / 800);
});

test("4. 双击恢复默认尺寸与比例", (t) => {
  setup(t);
  const layout = useWorkbenchLayoutStore();

  // 修改各参数
  layout.setSidebarWidth(350);
  layout.setContextWidth(600);
  layout.setSidebarNavHeight(200, 600);

  assert.notEqual(layout.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);
  assert.notEqual(layout.contextWidth, DEFAULT_CONTEXT_WIDTH);

  // 双击重置
  layout.resetSidebarWidth();
  assert.equal(layout.sidebarWidth, DEFAULT_SIDEBAR_WIDTH);

  layout.resetContextWidth();
  assert.equal(layout.contextWidth, DEFAULT_CONTEXT_WIDTH);

  layout.resetSidebarNavRatio();
  assert.equal(layout.sidebarNavRatio, DEFAULT_SIDEBAR_NAV_RATIO);
  assert.equal(layout.sidebarNavHeight, null);
});

test("5. 键盘 step 步进操作 (ARIA Separator 键位控制)", (t) => {
  setup(t);
  const layout = useWorkbenchLayoutStore();

  // 侧边栏初始 280
  layout.stepSidebarWidth(8);
  assert.equal(layout.sidebarWidth, 288);

  layout.stepSidebarWidth(-16);
  assert.equal(layout.sidebarWidth, 272);

  // 检查器初始 400
  layout.stepContextWidth(32);
  assert.equal(layout.contextWidth, 432);

  // 侧边栏导航区高度步进 (总高 600px)
  layout.stepSidebarNavHeight(20, 600);
  assert.equal(layout.sidebarNavHeight, 320); // 600 * 0.5 + 20
});

test("6. 本地持久化与跨分辨率安全 Clamp 恢复", (t) => {
  const { fakeStorage } = setup(t);
  const layout = useWorkbenchLayoutStore();

  layout.restoreLayout(1920);
  layout.setSidebarWidth(360);
  layout.setContextWidth(520);
  layout.setSidebarNavHeight(280, 700);
  layout.persistLayout();

  // 验证 localStorage 是否存入
  const raw = fakeStorage.getItem("nash_workbench_layout_v2");
  assert.ok(raw);
  const parsed = JSON.parse(raw!).wide;
  assert.equal(parsed.sidebarWidth, 360);
  assert.equal(parsed.contextWidth, 520);

  // 模拟重新实例化 Store 并恢复
  const newLayout = useWorkbenchLayoutStore();
  newLayout.restoreLayout(1920);
  assert.equal(newLayout.sidebarWidth, 360);
  assert.equal(newLayout.contextWidth, 520);

  // 极端场景：用户将电脑从 1920px 显示器移至 1024px 小屏：
  // 360 + 520 + 500 = 1380px > 1024px，必须自动安全 Clamp 收缩，绝不挤扁中间会话
  newLayout.restoreLayout(1024);
  const fitted = fitWorkbench(1024, newLayout.sidebarWidth, newLayout.contextWidth, true, true);
  assert.ok(fitted.sidebar + fitted.context + MIN_CONVERSATION_WIDTH + 2 <= 1024);
  assert.ok(fitted.sidebar >= MIN_SIDEBAR_WIDTH);
  assert.ok(fitted.context >= MIN_CONTEXT_WIDTH);
});

test("7. 拖动只改变内存，完成时保存；不同设备配置独立且非法值安全恢复", t => {
  const { fakeStorage } = setup(t);
  const layout = useWorkbenchLayoutStore();
  layout.restoreLayout(1920);
  layout.setSidebarWidth(390);
  assert.equal(fakeStorage.getItem("nash_workbench_layout_v2"), null);
  layout.persistLayout();
  layout.restoreLayout(1024);
  assert.equal(layout.sidebarWidth, 280);
  layout.setSidebarWidth(230); layout.persistLayout();
  layout.restoreLayout(1920);
  assert.equal(layout.sidebarWidth, 390);
  layout.setSidebarWidth(Infinity); layout.setContextWidth(NaN);
  assert.equal(layout.sidebarWidth, 390);
  assert.equal(layout.contextWidth, 400);
  fakeStorage.setItem("nash_workbench_layout_v2", JSON.stringify({ wide: { sidebarWidth: -20, contextWidth: 999999, sidebarNavRatio: 50 } }));
  layout.restoreLayout(1920);
  assert.equal(layout.sidebarWidth, 220);
  assert.equal(layout.contextWidth, 800);
  assert.equal(layout.sidebarNavRatio, .85);
});

test("8. 所有桌面宽度与折叠组合均保留会话空间，窄容器自动覆盖", () => {
  for (const width of [768, 1024, 1280, 1440, 1920]) for (const left of [true, false]) for (const right of [true, false]) {
    const fitted = fitWorkbench(width, 400, 800, left, right);
    const occupied = fitted.sidebar + fitted.context + (left ? 1 : 0) + (fitted.docked ? 1 : 0);
    assert.ok(width - occupied >= 500, JSON.stringify({ width, left, right, fitted }));
    if (fitted.docked) assert.ok(fitted.context >= 300);
  }
});

test("9. 旧配置迁移，损坏存储与高度变化不留下越界尺寸", t => {
  const { fakeStorage } = setup(t);
  fakeStorage.setItem("nash_workbench_layout_v1", JSON.stringify({ sidebarWidth: 310, contextWidth: 450, sidebarNavRatio: .4 }));
  const layout = useWorkbenchLayoutStore(); layout.restoreLayout(1440);
  assert.equal(layout.sidebarWidth, 310); assert.equal(layout.sidebarNavRatio, .4);
  layout.stepSidebarNavHeight(8, 400);
  assert.equal(layout.sidebarNavHeight, 168);
  fakeStorage.setItem("nash_workbench_layout_v2", "broken");
  layout.restoreLayout(1024);
  assert.equal(layout.sidebarWidth, 280);
});

test("10. 损坏配置在下一次有效调整后可以修复并重新恢复", t => {
  const { fakeStorage } = setup(t);
  fakeStorage.setItem("nash_workbench_layout_v2", "{invalid");
  const layout = useWorkbenchLayoutStore(); layout.restoreLayout(1440);
  layout.setSidebarWidth(320); layout.persistLayout();
  layout.restoreLayout(1440); assert.equal(layout.sidebarWidth, 320);
});

test("11. 响应式临时收缩不会覆盖用户原来的有效宽度", t => {
  setup(t);
  const layout = useWorkbenchLayoutStore();
  layout.setSidebarWidth(360); layout.setContextWidth(600);
  assert.equal(fitWorkbench(1024, layout.sidebarWidth, layout.contextWidth, true, true).context, 300);
  assert.equal(layout.sidebarWidth, 360); assert.equal(layout.contextWidth, 600);
  assert.equal(fitWorkbench(1920, layout.sidebarWidth, layout.contextWidth, true, true).context, 600);
});
