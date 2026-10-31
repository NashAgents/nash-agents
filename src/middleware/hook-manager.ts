import type {
  HookMap,
  HookName,
  BeforeAgentRunHook,
  AfterAgentRunHook,
  OnAgentErrorHook,
  BeforeModelCallHook,
  AfterModelCallHook,
  OnModelErrorHook,
  BeforeToolExecuteHook,
  AfterToolExecuteHook,
  OnToolErrorHook,
} from "./hooks.js";

/**
 * 错误类 Hook 集合，用于执行防死循环与递归保护
 */
const ERROR_HOOK_NAMES = new Set<HookName>([
  "onAgentError",
  "onModelError",
  "onToolError",
]);

/**
 * 企业级轻量 Hook 生命周期管理器
 *
 * 特性：
 * 1. 严格 FIFO 先进先出执行顺序
 * 2. 统一支持同步函数与异步 Promise
 * 3. 错误 Hook 防递归保护机制
 * 4. 完整的类型推导与链式注册 API
 */
export class HookManager {
  private readonly hooks: {
    [K in HookName]: Array<HookMap[K]>;
  } = {
    beforeAgentRun: [],
    afterAgentRun: [],
    onAgentError: [],
    beforeModelCall: [],
    afterModelCall: [],
    onModelError: [],
    beforeToolExecute: [],
    afterToolExecute: [],
    onToolError: [],
  };

  /**
   * 记录正在执行中的错误 Hook，防止因错误回调自身抛出异常导致循环死锁
   */
  private readonly activeErrorHooks = new Set<HookName>();

  /**
   * 通用 Hook 注册方法
   *
   * @param name - 钩子名称
   * @param hook - 钩子回调函数
   */
  register<K extends HookName>(name: K, hook: HookMap[K]): this {
    this.hooks[name].push(hook);
    return this;
  }

  /**
   * 注册 beforeAgentRun 钩子
   */
  beforeAgentRun(hook: BeforeAgentRunHook): this {
    return this.register("beforeAgentRun", hook);
  }

  /**
   * 注册 afterAgentRun 钩子
   */
  afterAgentRun(hook: AfterAgentRunHook): this {
    return this.register("afterAgentRun", hook);
  }

  /**
   * 注册 onAgentError 钩子
   */
  onAgentError(hook: OnAgentErrorHook): this {
    return this.register("onAgentError", hook);
  }

  /**
   * 注册 beforeModelCall 钩子
   */
  beforeModelCall(hook: BeforeModelCallHook): this {
    return this.register("beforeModelCall", hook);
  }

  /**
   * 注册 afterModelCall 钩子
   */
  afterModelCall(hook: AfterModelCallHook): this {
    return this.register("afterModelCall", hook);
  }

  /**
   * 注册 onModelError 钩子
   */
  onModelError(hook: OnModelErrorHook): this {
    return this.register("onModelError", hook);
  }

  /**
   * 注册 beforeToolExecute 钩子
   */
  beforeToolExecute(hook: BeforeToolExecuteHook): this {
    return this.register("beforeToolExecute", hook);
  }

  /**
   * 注册 afterToolExecute 钩子
   */
  afterToolExecute(hook: AfterToolExecuteHook): this {
    return this.register("afterToolExecute", hook);
  }

  /**
   * 注册 onToolError 钩子
   */
  onToolError(hook: OnToolErrorHook): this {
    return this.register("onToolError", hook);
  }

  /**
   * 获取指定名称的所有已注册 Hook 列表
   */
  getHooks<K extends HookName>(name: K): Array<HookMap[K]> {
    return [...this.hooks[name]] as Array<HookMap[K]>;
  }

  /**
   * 清空所有或指定生命周期的已注册 Hook
   */
  clear(name?: HookName): this {
    if (name) {
      this.hooks[name] = [];
    } else {
      for (const key of Object.keys(this.hooks) as HookName[]) {
        this.hooks[key] = [];
      }
    }
    return this;
  }

  /**
   * 按注册顺序执行指定生命周期 Hook 队列
   *
   * @param name - 钩子名称
   * @param context - 对应的生命周期上下文对象
   */
  async execute<K extends HookName>(
    name: K,
    context: Parameters<HookMap[K]>[0]
  ): Promise<void> {
    const hookList = this.hooks[name];
    if (!hookList || hookList.length === 0) {
      return;
    }

    // 针对 Error 类型的 Hook 进行防递归保护
    const isErrorHook = ERROR_HOOK_NAMES.has(name);
    if (isErrorHook) {
      if (this.activeErrorHooks.has(name)) {
        return;
      }
      this.activeErrorHooks.add(name);
    }

    try {
      // 严格 FIFO 顺序执行：支持同步及异步返回
      for (const hook of hookList) {
        await Promise.resolve(
          (hook as (ctx: Parameters<HookMap[K]>[0]) => void | Promise<void>)(context)
        );
      }
    } finally {
      if (isErrorHook) {
        this.activeErrorHooks.delete(name);
      }
    }
  }
}
