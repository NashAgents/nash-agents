import type { Readable, Writable } from "node:stream";

/**
 * 结构化交互模式状态机：
 * - idle: 启动空闲或 Run 结束，处于欢迎首屏 (IdleHomeView)，等待新 Run
 * - running-main: Main Agent 执行中，处于主屏幕 (MainScreen)
 * - agent-detail: 查看具体 Agent 的全屏详情与独立 Transcript
 * - structured-decision: 结构化决策活动中 (Plan Approval, Permission 等)，焦点独占
 * - plan-revision: Plan Revision 自由文本输入状态
 * - user-input: 兼容原有底层 reader 模式
 * - approval: 兼容原有底层 askYesNo 模式
 * - navigation: 兼容模式
 */
export type InteractionMode =
  | "idle"
  | "empty-session"
  | "session-ready"
  | "running-main"
  | "agent-detail"
  | "structured-decision"
  | "plan-revision"
  | "user-input"
  | "approval"
  | "navigation"
  | "session-picker"
  | "skills-picker";

/**
 * 运行期间键盘与鼠标导航事件监听处理器接口
 */
export interface NavigationHandler {
  onKeyUp?: () => void;
  onKeyDown?: () => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
  onHome?: () => void;
  onEnd?: () => void;
  onKeyEnter?: () => void;
  onKeyEscape?: () => void;
  onKeyLeft?: () => void;
  onKeyCtrlT?: () => void;
  onKeyCtrlO?: () => void;
  /** Return false when no approval is pending so y/n stays available to the composer. */
  onApprovalKey?: (key: "y" | "n") => boolean | void | number;
  onInterrupt?: () => void;
  isRunActive?: () => boolean;
  onAgentInterrupt?: () => void;
  onComposerChange?: (draft: string, cursorIndex?: number) => void;
  onFollowupModeChange?: (mode: "steer" | "queue") => void;
  onComposerSubmit?: (
    text: string,
    mode: "steer" | "queue" | "start-run"
  ) => void;

  // 鼠标滚轮事件
  onMouseWheelUp?: () => void;
  onMouseWheelDown?: () => void;
  onMouseButton?: (mouse: { button: number; col: number; row: number; isRelease?: boolean; isDrag?: boolean; isMotion?: boolean }) => void;

  // 结构化决策模式分发接口
  hasActiveDecision?: () => boolean;
  isPlanRevisionInput?: () => boolean;
  onDecisionKeyUp?: () => void;
  onDecisionKeyDown?: () => void;
  onDecisionConfirm?: () => void;
  onDecisionCancel?: () => void;
  onDecisionShortcut?: (key: string) => boolean;
  onPlanPageUp?: () => void;
  onPlanPageDown?: () => void;
  onPlanToggleDetails?: () => boolean;
  onResumeQueryChange?: (query: string) => void;
  onResumeMove?: (delta: number) => void;
  onResumeConfirm?: () => void;
  onResumeCancel?: () => void;
  onSkillsQueryChange?: (query: string) => void;
  onSkillsMove?: (delta: number) => void;
  onSkillsCycle?: () => void;
  onSkillsClose?: () => void;
}

/**
 * askYesNo 方法的可选配置
 */
export interface AskYesNoOptions {
  /**
   * 当用户直接敲击回车或输入为空时的默认布尔值（默认为 false）
   */
  defaultValue?: boolean;
}

/**
 * 可配置的 Readable/Writable 流类型，支持 TTY 和 RawMode 探测
 */
export type InputReadable = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  setEncoding?: (encoding: BufferEncoding) => void;
};

export type OutputWritable = Writable & {
  isTTY?: boolean;
};

/**
 * InputManager 构造配置项
 */
export interface InputManagerOptions {
  /**
   * 输入流（默认使用 process.stdin）
   */
  input?: InputReadable;

  /**
   * 输出流（默认使用 process.stdout）
   */
  output?: OutputWritable;

  /**
   * 显式指定是否为 TTY 终端（若未指定则自动检测 input.isTTY）
   */
  isTTY?: boolean;

  /**
   * 收到 Ctrl+C (SIGINT) 中断信号时的自定义回调，未配置时默认退出进程
   */
  onInterrupt?: () => void;

  /**
   * 是否在交互模式下自动启用终端鼠标事件报告 (DECSET 1000/1006)。
   * 默认为 false，保证终端原生的鼠标划选、双击选词、三击选行和复制功能不受拦截。
   */
  enableMouseReporting?: boolean;
}

/**
 * 当存在并发 reader（例如同时调用 readUserMessage 与 askYesNo）时抛出的安全互斥异常
 */
export class InputBusyError extends Error {
  constructor(message = "InputManager is already reading input") {
    super(message);
    this.name = "InputBusyError";
  }
}
