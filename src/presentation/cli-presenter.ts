import * as crypto from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { EventBus } from "../observability/event-bus.js";
import type { HarnessEvent } from "../observability/types.js";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { AgentRecord } from "../agent/types.js";
import type { TaskManager } from "../task/task-manager.js";
import type { JobManager } from "../jobs/job-manager.js";
import type { JobRecord } from "../jobs/types.js";
import type { ApprovalService } from "../approval/approval-service.js";
import type { NavigationHandler, InteractionMode } from "../cli/types.js";
import type { PlanMode } from "../plan/plan-mode.js";
import type { ProposedPlan } from "../plan/types.js";
import { DecisionController } from "../decision/decision-controller.js";
import { DecisionRenderer } from "./decision-renderer.js";
import { ProposedPlanProjection } from "./proposed-plan-projection.js";
import { ActiveTaskGraphProjection } from "./active-task-graph-projection.js";
import {
  MultiAgentMetricsCollector,
  formatDurationHuman,
  formatTokensHuman,
} from "./multi-agent-stats.js";
import { AgentTreeProjection } from "./agent-tree-projection.js";
import { formatToolCallSummary } from "./activity-formatter.js";
import { SystemClipboard } from "../cli/clipboard.js";
import {
  TerminalRenderer,
  truncateToDisplayWidth,
  tailToDisplayWidth,
  getVisibleWidth,
} from "./terminal-renderer.js";
import { TerminalScreenManager } from "./terminal-screen-manager.js";
import { AgentTranscriptProjection } from "./agent-transcript-projection.js";
import { highlightSelectedLine, selectedText, type TextSelection } from "./transcript-selection.js";
import type { SessionRecord } from "../context/types.js";
import { SessionPicker, type ResumeSession } from "./session-picker.js";
import { SkillsPicker } from "./skills-picker.js";
import type { SkillService } from "../skills/skill-service.js";
import { getSlashCommandSuggestions } from "../cli/slash-commands-registry.js";
import { WelcomeShowcase } from "./welcome-showcase.js";

export interface TranscriptEntry {
  id: string;
  agentId: string;
  agentName?: string;
  timestamp: number;
  kind:
    | "thought"
    | "tool_start"
    | "tool_result"
    | "message"
    | "error"
    | "system"
    | "approval";
  text: string;
}

export interface CliPresenterOptions {
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  taskManager?: TaskManager;
  jobManager?: JobManager;
  approvalService?: ApprovalService;
  decisionController?: DecisionController;
  planMode?: PlanMode;
  isTTY?: boolean;
  nativeScrollback?: boolean;
  stdout?: NodeJS.WriteStream;
  modelName?: string;
  projectRoot?: string;
  onPlanApproved?: (plan: ProposedPlan) => void;
  onPlanRevisionSubmitted?: (revisionText: string, plan?: ProposedPlan) => void;
}

/**
 * 纯展示层判断：判定一个 Job 是否属于真正用户可见的长时间后台任务
 */
export function isUserVisibleBackgroundJob(job: JobRecord): boolean {
  if (!job) return false;
  return Boolean(job.backgroundRequested || job.promoted);
}

/**
 * CliPresenter - 全屏 Application-Level 终端展示中枢
 *
 * 核心特性与架构准则：
 * 1. 明确的 InteractionMode 状态机：idle -> running-main -> agent-detail / structured-decision / plan-revision -> idle；
 * 2. 真正的 IdleHomeView：应用启动或 Run 结束无任务时呈现极简 Welcome 界面，严禁显示假 working 与假 Team Leader；
 * 3. 严格解耦 selectedAgentId 与 activeViewAgentId：光标移动不切换视图，Enter 打开详情，Esc 纯净返回；
 * 4. 彻底修复鼠标滚轮：SGR 滚轮在 Agent Detail 视图下平滑滚动 Transcript，绝对不误触退出；
 * 5. Plan 严格双阶段互斥投影：Awaiting Approval 呈现纯净 ProposedPlan，Approve 后单一事实来源渲染 TaskGraph；
 * 6. Decision resolve 后可靠恢复 Main Keymap 与 Ctrl+T 展开状态。
 */
export class CliPresenter {
  private readonly eventBus: EventBus;
  private readonly agentRegistry: AgentRegistry;
  private readonly taskManager?: TaskManager;
  private readonly jobManager?: JobManager;
  private approvalService?: ApprovalService;
  private planMode?: PlanMode;
  readonly decisionController: DecisionController;
  private readonly isTTY: boolean;
  private readonly nativeScrollback: boolean;
  private nativeCommittedLines: string[] = [];
  private nativeLastLiveRows = 0;
  private nativeLastFooterRows = 0;
  private nativeCursorRowsBelowEnd = 0;
  private nativeViewAgentId = "main";
  private nativeHeaderPrinted = false;
  private readonly stdout: NodeJS.WriteStream;
  private readonly terminalRenderer: TerminalRenderer;
  private readonly screenManager: TerminalScreenManager;

  private modelName: string;
  private projectRoot: string;

  readonly metricsCollector = new MultiAgentMetricsCollector();
  readonly treeProjection = new AgentTreeProjection();

  private isRunning = false;
  private isRunTransitioning = false;
  private renderSuppressed = false;
  private needsRenderAfterTransition = false;
  private currentRunId?: string;
  private interactionMode: InteractionMode = "idle";
  private currentPrompt = "";
  private runStartTime = Date.now();
  private renderThrottleTimer?: NodeJS.Timeout;
  private elapsedTimer?: NodeJS.Timeout;
  private feedbackTimer?: NodeJS.Timeout;
  private unsubscribeBus?: () => void;
  private readonly boundResizeHandler = () => this.handleResize();

  // Navigation 与 View 状态
  private activeViewAgentId = "main";
  private selectedAgentIndex = 0;
  private selectedAgentId = "main";
  private isTaskExpanded = true; // 新 Run 默认展开 Plan
  private planScrollOffset = 0;
  private planShowDetails = false;
  private sessionPicker?: SessionPicker;
  private sessionPickerResolve?: (session: ResumeSession | undefined) => void;
  private sessionPickerPreviousMode?: InteractionMode;

  // 各 Agent 的独立 Transcript 投影 (agentId -> projection)
  private readonly transcriptProjections = new Map<
    string,
    AgentTranscriptProjection
  >();

  // 跟踪可见后台任务
  private readonly visibleBackgroundJobs = new Map<string, JobRecord>();
  // 简短 Toast 通知
  private readonly activeToasts: Array<{ text: string; createdAt: number }> = [];
  private transcriptSelection?: TextSelection;
  private screenSelection?: TextSelection;
  private isSelectingTranscript = false;
  private selectionScrollTimer?: NodeJS.Timeout;
  private selectionPointer?: { row: number; col: number };
  private transcriptViewport?: { top: number; height: number; width: number; start: number; agentId: string };
  private lastFrameLines: string[] = [];

  // Steer / Queue 状态反馈提示
  private steerFeedback?: { text: string; expiresAt: number };
  private planFeedback?: { text: string; expiresAt: number };
  private followupCount = 0;

  // 运行态 Pending Steer 待注入队列缓存 (target -> { id, content, createdAt })
  private readonly pendingSteers = new Map<
    string,
    { id: string; content: string; createdAt: number }
  >();

  // 当前用户在 composer 中正在输入的内容
  private composerDraft = "";
  private composerCursorIndex?: number;
  private followupMode: "steer" | "queue" = "steer";
  private readonly pendingFileWrites = new Map<string, string>();
  private readonly completedFileWrites = new Set<string>();

  // Plan Revision 自由文本输入状态
  private isPlanRevisionMode = false;
  private activePlanForRevision?: ProposedPlan;
  private currentRunOutTokens = 0;
  private streamedOutputTokens = 0;

  // Plan 决策生命周期外部钩子
  private onPlanApprovedCallback?: (plan: ProposedPlan) => void;
  private onPlanRevisionSubmittedCallback?: (
    revisionText: string,
    plan?: ProposedPlan
  ) => void;

  // 外部通知 InputManager 状态更新回调
  private onInteractionModeChangeCallback?: (mode: InteractionMode) => void;

  constructor(options: CliPresenterOptions) {
    this.eventBus = options.eventBus;
    this.agentRegistry = options.agentRegistry;
    this.taskManager = options.taskManager;
    this.jobManager = options.jobManager;
    this.approvalService = options.approvalService;
    this.planMode = options.planMode;
    if (this.planMode && this.taskManager) {
      this.planMode.setTaskManager(this.taskManager);
    }
    this.modelName = options.modelName ?? "gemini-3.8-flash-no-thinking";
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.onPlanApprovedCallback = options.onPlanApproved;
    this.onPlanRevisionSubmittedCallback = options.onPlanRevisionSubmitted;
    this.stdout = options.stdout ?? process.stdout;
    this.isTTY = options.isTTY ?? Boolean(this.stdout.isTTY);
    this.nativeScrollback = options.nativeScrollback ?? false;

    this.decisionController =
      options.decisionController ??
      new DecisionController({
        onDecisionChange: () => this.handleDecisionChange(),
      });

    if (options.decisionController) {
      options.decisionController.setOnDecisionChange(() => this.handleDecisionChange());
    }

    this.terminalRenderer = new TerminalRenderer({
      stdout: this.stdout,
      isTTY: this.isTTY,
    });

    this.screenManager = new TerminalScreenManager({
      stdout: this.stdout as any,
      isTTY: this.isTTY,
    });

    this.subscribeEvents();

    if (this.isTTY && typeof process.stdout.on === "function") {
      process.stdout.on("resize", this.boundResizeHandler);
    }
  }

  setAppInfo(info: { modelName?: string; projectRoot?: string }): void {
    if (info.modelName) this.modelName = info.modelName;
    if (info.projectRoot) this.projectRoot = info.projectRoot;
    if (this.isTTY) {
      this.requestRender();
    }
  }

  setOnInteractionModeChange(callback: (mode: InteractionMode) => void): void {
    this.onInteractionModeChangeCallback = callback;
  }

  private notifyInteractionMode(mode: InteractionMode): void {
    this.interactionMode = mode;
    if (this.onInteractionModeChangeCallback) {
      this.onInteractionModeChangeCallback(mode);
    }
  }

  setApprovalService(service: ApprovalService): void {
    this.approvalService = service;
  }

  setPlanMode(mode: PlanMode): void {
    this.planMode = mode;
  }

  setOnPlanApproved(callback: (plan: ProposedPlan) => void): void {
    this.onPlanApprovedCallback = callback;
  }

  setOnPlanRevisionSubmitted(
    callback: (revisionText: string, plan?: ProposedPlan) => void
  ): void {
    this.onPlanRevisionSubmittedCallback = callback;
  }

  setComposerDraft(draft: string, cursorIndex?: number): void {
    this.composerDraft = draft;
    this.composerCursorIndex = cursorIndex;
    if (this.isTTY) {
      this.render();
    }
  }

  setFollowupMode(mode: "steer" | "queue"): void {
    this.followupMode = mode;
    this.requestRender({ immediate: true });
  }

  setFollowupCount(count: number): void {
    this.followupCount = count;
    this.requestRender();
  }

  showSteerFeedback(text: string, durationMs = 4000): void {
    this.steerFeedback = {
      text,
      expiresAt: Date.now() + durationMs,
    };
    this.scheduleFeedbackExpiry();
    this.requestRender();
  }

  showPlanFeedback(text: string, durationMs = 5000): void {
    this.planFeedback = {
      text,
      expiresAt: Date.now() + durationMs,
    };
    this.scheduleFeedbackExpiry();
    this.requestRender();
  }

  private scheduleFeedbackExpiry(): void {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    const now = Date.now();
    const expiries = [this.steerFeedback?.expiresAt, this.planFeedback?.expiresAt, ...this.activeToasts.map((toast) => toast.createdAt + 4000)]
      .filter((expiresAt): expiresAt is number => typeof expiresAt === "number" && expiresAt > now);
    if (expiries.length === 0) return;
    this.feedbackTimer = setTimeout(() => {
      this.feedbackTimer = undefined;
      this.requestRender({ immediate: true });
      this.scheduleFeedbackExpiry();
    }, Math.max(1, Math.min(...expiries) - now + 10));
  }

  /**
   * 判断当前 Session 是否已有任何执行或对话历史
   */
  hasSessionHistory(): boolean {
    const mainProj = this.transcriptProjections.get("main");
    return Boolean(mainProj && mainProj.hasEntries());
  }

  /**
   * 进入全局 Application Screen (置顶全屏)
   */
  enterAppScreen(): void {
    if (this.isTTY) {
      if (!this.nativeScrollback) this.screenManager.enterAlternateScreen();
      if (this.hasSessionHistory()) {
        this.notifyInteractionMode("session-ready");
      } else {
        this.notifyInteractionMode("empty-session");
      }
      this.requestRender();
    }
  }

  /**
   * 退出全局 Application Screen 恢复宿主 Shell
   */
  leaveAppScreen(): void {
    this.clearTranscriptSelection();
    if (this.isTTY) {
      if (this.nativeScrollback) this.clearNativeFooter();
      if (!this.nativeScrollback || this.screenManager.isAlternateScreen()) {
        this.screenManager.leaveAlternateScreen();
      }
    }
  }

  getInteractionMode(): InteractionMode {
    return this.interactionMode;
  }

  isRunActive(): boolean {
    return this.isRunning || this.isRunTransitioning;
  }

  getProjection(agentId: string): AgentTranscriptProjection {
    let proj = this.transcriptProjections.get(agentId);
    if (!proj) {
      proj = new AgentTranscriptProjection(agentId, (filePath) => {
        try {
          const root = realpathSync(this.projectRoot);
          const resolved = realpathSync(path.resolve(root, filePath));
          const relative = path.relative(root, resolved);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
          if (statSync(resolved).size > 512_000) return undefined;
          return readFileSync(resolved, "utf8");
        } catch {
          return undefined;
        }
      });
      this.transcriptProjections.set(agentId, proj);
    }
    return proj;
  }

  /**
   * 允许预装载或同步 Agent 历史 Session 记录
   */
  loadSessionRecords(agentId: string, records: SessionRecord[]): void {
    const proj = this.getProjection(agentId);
    proj.projectFromSessionRecords(records);
    if (agentId === "main" && records.length > 0) {
      if (
        this.interactionMode === "empty-session" ||
        this.interactionMode === "idle"
      ) {
        this.notifyInteractionMode("session-ready");
      }
    }
    if (this.isTTY) {
      this.requestRender();
    }
  }

  loadResumedSession(records: SessionRecord[]): void {
    this.resetSession();
    if (records.length) this.loadSessionRecords("main", records);
    this.returnToMainView();
  }

  isInteractiveTTY(): boolean {
    return this.isTTY;
  }

  openResumePicker(sessions: ResumeSession[], currentSessionId: string): Promise<ResumeSession | undefined> {
    if (!this.isTTY) return Promise.resolve(undefined);
    this.closeResumePicker();
    this.sessionPicker = new SessionPicker(sessions, currentSessionId);
    if (this.nativeScrollback) this.clearNativeFooter();
    this.sessionPickerPreviousMode = this.interactionMode;
    this.notifyInteractionMode("session-picker");
    this.render();
    return new Promise((resolve) => { this.sessionPickerResolve = resolve; });
  }

  private closeResumePicker(selection?: ResumeSession): void {
    if (!this.sessionPicker) return;
    this.sessionPicker = undefined;
    const previous = this.sessionPickerPreviousMode ?? "session-ready";
    this.sessionPickerPreviousMode = undefined;
    this.notifyInteractionMode(previous);
    const resolve = this.sessionPickerResolve;
    this.sessionPickerResolve = undefined;
    this.render();
    resolve?.(selection);
  }

  private skillsPicker?: SkillsPicker;
  private skillsPickerPreviousMode?: InteractionMode;
  private skillsPickerResolve?: () => void;
  private activeSkillService?: SkillService;

  async openSkillsPicker(skillService: SkillService): Promise<void> {
    if (!this.isTTY) return;
    this.closeSkillsPicker();
    const items = await skillService.getAllSkillsWithModes();
    this.skillsPicker = new SkillsPicker(items);
    this.activeSkillService = skillService;
    if (this.nativeScrollback) this.clearNativeFooter();
    this.skillsPickerPreviousMode = this.interactionMode;
    this.notifyInteractionMode("skills-picker");
    this.render();
    return new Promise((resolve) => { this.skillsPickerResolve = resolve; });
  }

  private closeSkillsPicker(): void {
    if (!this.skillsPicker) return;
    this.skillsPicker = undefined;
    this.activeSkillService = undefined;
    const previous = this.skillsPickerPreviousMode ?? "session-ready";
    this.skillsPickerPreviousMode = undefined;
    this.notifyInteractionMode(previous);
    const resolve = this.skillsPickerResolve;
    this.skillsPickerResolve = undefined;
    this.render();
    resolve?.();
  }

  private subscribeEvents(): void {
    this.unsubscribeBus = this.eventBus.subscribe(
      "*",
      (event: HarnessEvent<any>) => {
        this.handleEvent(event);
      }
    );
  }

  private handleDecisionChange(): void {
    if (this.decisionController.hasActiveDecision()) {
      if (this.isPlanRevisionMode) {
        this.notifyInteractionMode("plan-revision");
      } else {
        this.notifyInteractionMode("structured-decision");
      }
    } else {
      if (this.isRunning) {
        this.notifyInteractionMode(
          this.activeViewAgentId === "main" ? "running-main" : "agent-detail"
        );
      } else {
        this.notifyInteractionMode(
          this.hasSessionHistory() ? "session-ready" : "empty-session"
        );
      }
    }
    this.requestRender();
  }

  /**
   * 是否正处于 Run 初始化 Transition 状态
   */
  isTransitioning(): boolean {
    return this.isRunTransitioning;
  }

  /**
   * 开启 Run 状态的原子初始化转换 (Transition Guard)
   * 在此期间抑制任何屏幕重绘，事件更新正常累积至 Projection 与 State
   */
  beginRunTransition(
    userInput: string,
    runId?: string,
    targetAgentId = "main"
  ): boolean {
    const targetRunId = runId ?? crypto.randomUUID();
    if (this.currentRunId && this.currentRunId === targetRunId && (this.isRunning || this.isRunTransitioning)) {
      // 避免重复对同一个 runId 进行 startRun 初始化
      return false;
    }

    this.clearTranscriptSelection();

    this.renderSuppressed = true;
    this.isRunTransitioning = true;
    this.needsRenderAfterTransition = false;
    this.currentRunId = targetRunId;

    this.isRunning = true;
    this.currentPrompt = userInput;
    this.runStartTime = Date.now();
    this.visibleBackgroundJobs.clear();
    this.activeToasts.length = 0;
    this.activeViewAgentId = targetAgentId;
    this.selectedAgentId = targetAgentId;
    this.selectedAgentIndex = Math.max(
      0,
      this.getVisibleNavigableAgents().findIndex((a) => a.agentId === targetAgentId)
    );
    this.isTaskExpanded = true;
    this.planScrollOffset = 0;
    this.isPlanRevisionMode = false;
    this.activePlanForRevision = undefined;
    this.steerFeedback = undefined;
    this.planFeedback = undefined;
    this.composerDraft = "";
    this.followupMode = "steer";
    this.currentRunOutTokens = 0;
    this.streamedOutputTokens = 0;

    // 保证目标 Agent 在首次 Running 渲染前必然在 AgentRegistry 中就绪且为 running
    const existing = this.agentRegistry.getAgent(targetAgentId);
    if (!existing) {
      this.agentRegistry.register({
        agentId: targetAgentId,
        type: targetAgentId === "main" ? "main" : "subagent",
        name: targetAgentId === "main" ? "Main" : targetAgentId,
        depth: targetAgentId === "main" ? 0 : 1,
      });
    } else if (existing.status !== "running") {
      this.agentRegistry.updateStatus(targetAgentId, "running");
    }

    this.metricsCollector.startRun();

    // 初始化对应 Agent Projection 并写入用户消息
    const proj = this.getProjection(targetAgentId);
    proj.addUserMessage(userInput);

    this.notifyInteractionMode(targetAgentId === "main" ? "running-main" : "agent-detail");

    return true;
  }

  /**
   * 确保运行态实时计时与状态刷新定时器处于活动状态（主屏幕与备用屏幕均支持无缝自刷新）
   */
  ensureElapsedTimer(): void {
    if (this.elapsedTimer) return;
    if (!this.isTTY) return;
    this.elapsedTimer = setInterval(() => {
      const hasActiveWork =
        this.isRunning ||
        this.isRunTransitioning ||
        this.agentRegistry.getRunningAgents().length > 0;
      if (hasActiveWork && this.isTTY && !this.renderSuppressed) {
        this.requestRender();
      }
    }, 500);
    this.elapsedTimer.unref?.();
  }

  setPendingSteer(target: string, content: string, id?: string): void {
    const steerId = id ?? crypto.randomUUID();
    const item = { id: steerId, content: content.trim(), createdAt: Date.now() };
    this.pendingSteers.set(target, item);
    const rec = this.agentRegistry.getAgent(target) ?? this.agentRegistry.findByName(target);
    if (rec) {
      this.pendingSteers.set(rec.agentId, item);
      if (rec.name) {
        this.pendingSteers.set(rec.name, item);
      }
    }
    if (this.isTTY) {
      this.requestRender({ immediate: true });
    }
  }

  getPendingSteer(target: string): { id: string; content: string; createdAt: number } | undefined {
    let match = this.pendingSteers.get(target);
    if (match) return match;
    const rec = this.agentRegistry.getAgent(target) ?? this.agentRegistry.findByName(target);
    if (rec) {
      match = this.pendingSteers.get(rec.agentId);
      if (match) return match;
      if (rec.name) {
        match = this.pendingSteers.get(rec.name);
        if (match) return match;
      }
    }
    return undefined;
  }

  clearPendingSteer(target?: string): void {
    if (!target) {
      this.pendingSteers.clear();
      if (this.isTTY) this.requestRender();
      return;
    }
    this.pendingSteers.delete(target);
    const rec = this.agentRegistry.getAgent(target) ?? this.agentRegistry.findByName(target);
    if (rec) {
      this.pendingSteers.delete(rec.agentId);
      if (rec.name) this.pendingSteers.delete(rec.name);
    }
    if (this.isTTY) this.requestRender();
  }

  hasAnyPendingSteer(): boolean {
    return this.pendingSteers.size > 0;
  }

  /**
   * 提交 Run 初始化转换，一次性将完整的 RunningMainView 渲染至终端
   */
  commitRunTransition(): void {
    if (!this.isRunTransitioning) return;

    this.renderSuppressed = false;
    this.isRunTransitioning = false;

    if (this.isTTY) {
      if (!this.nativeScrollback) this.screenManager.enterAlternateScreen();

      if (this.elapsedTimer) {
        clearInterval(this.elapsedTimer);
        this.elapsedTimer = undefined;
      }
      this.ensureElapsedTimer();

      this.render();
      this.needsRenderAfterTransition = false;
    }
  }

  /**
   * 回滚 Run 初始化转换（用于异常中断或初始化失败恢复）
   */
  rollbackRunTransition(error?: unknown): void {
    this.renderSuppressed = false;
    this.isRunTransitioning = false;
    this.needsRenderAfterTransition = false;
    this.isRunning = false;
    this.currentRunId = undefined;

    const mainProj = this.transcriptProjections.get("main");
    if (mainProj) {
      mainProj.popLastUserMessageIfMatch(this.currentPrompt);
    }

    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }

    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = undefined;
    }

    const mainAgent = this.agentRegistry.getAgent("main");
    if (mainAgent && mainAgent.status === "running") {
      this.agentRegistry.updateStatus("main", "failed", {
        error: error
          ? { message: error instanceof Error ? error.message : String(error) }
          : undefined,
      });
    }

    this.notifyInteractionMode(
      this.hasSessionHistory() ? "session-ready" : "empty-session"
    );

    if (this.isTTY) {
      this.stdout.write("\x1b[?25h\x1b[0m");
      this.render();
    }
  }

  /**
   * 启动单次用户交互 Run 的展示（原子化组合 begin + commit）
   */
  startRun(userInput: string, runId?: string): void {
    const started = this.beginRunTransition(userInput, runId);
    if (started) {
      this.commitRunTransition();
    }
  }

  /**
   * 将 Assistant 最终回复与 Run 摘要追加至 Main Transcript 投影
   */
  recordRunComplete(answer?: string, summary?: string): void {
    const mainProj = this.getProjection("main");
    if (answer && answer.trim()) {
      if (!mainProj.hasModelResponseMatching(answer)) {
        mainProj.addModelResponse(answer);
      }
    }
    if (summary && summary.trim()) {
      mainProj.addRunSummary(summary);
    }
    const tasks = this.taskManager?.getTasks() ?? [];
    const finished = tasks.filter((task) => task.status === "completed").length;
    const failed = tasks.filter((task) => task.status === "failed").length;
    const parts: string[] = [];
    if (tasks.length) parts.push(`Tasks ${finished}/${tasks.length} done${failed ? `, ${failed} failed` : ""}`);
    if (this.completedFileWrites.size) {
      const files = [...this.completedFileWrites];
      parts.push(`Files touched ${files.length}: ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`);
    }
    if (parts.length) mainProj.addSystemNotice(`Review · ${parts.join(" · ")}`);
    if (this.isTTY) {
      this.requestRender({ immediate: true });
    }
  }

  showReview(text: string): void {
    this.getProjection("main").addSystemNotice(text);
    this.requestRender({ immediate: true });
  }

  /**
   * 状态收敛：检查团队成员与子代理，若任务已全部完成或成员无进行中任务，收敛其状态避免僵死在 working
   */
  private convergeAgentStatuses(): void {
    const allTasks = this.taskManager?.getTasks() ?? [];
    const allCompleted = allTasks.length > 0 && allTasks.every((t) => t.status === "completed");
    for (const agent of this.agentRegistry.getAllAgents()) {
      if (agent.agentId !== "main") {
        if (allCompleted) {
          if (agent.status === "running" || agent.status === "waiting") {
            this.agentRegistry.updateStatus(agent.agentId, "completed");
          }
        } else if (agent.status === "running") {
          const runningTask = allTasks.find(
            (t) => t.ownerAgentId === agent.agentId && t.status === "running"
          );
          if (!runningTask) {
            this.agentRegistry.updateStatus(agent.agentId, "ready");
          }
        }
      }
    }
  }

  /**
   * 结束当前 Run，并平滑过渡至 session-ready（保留全部历史 Transcript 与 Bottom Dock）
   */
  stopRun(answer?: string, summary?: string): void {
    this.convergeAgentStatuses();

    if (!this.isRunning && !this.isRunTransitioning) {
      if (answer || summary) {
        this.recordRunComplete(answer, summary);
      }
      return;
    }

    if (answer || summary) {
      this.recordRunComplete(answer, summary);
    }

    this.isRunning = false;
    this.isRunTransitioning = false;
    this.renderSuppressed = false;
    this.needsRenderAfterTransition = false;
    this.currentRunId = undefined;
    this.pendingFileWrites.clear();
    this.completedFileWrites.clear();

    const mainAgent = this.agentRegistry.getAgent("main");
    if (mainAgent) {
      this.agentRegistry.updateStatus("main", "ready");
    }

    this.convergeAgentStatuses();

    this.notifyInteractionMode(this.activeViewAgentId === "main" ? "session-ready" : "agent-detail");
    // 保留用户在运行过程中尚未发送的输入草稿 (composerDraft)，严禁在 Agent 结束运行时抹掉草稿导致输入框闪烁或串字符

    const hasRemainingRunning = this.agentRegistry.getRunningAgents().length > 0;
    if (!hasRemainingRunning && this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }

    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = undefined;
    }

    if (this.isTTY) {
      this.stdout.write("\x1b[?25h\x1b[0m");
      this.render();
    }
  }

  /**
   * 重置整个 Session（用于 /new 开启全新空会话）
   */
  resetSession(): void {
    this.clearTranscriptSelection();
    this.nativeCommittedLines = [];
    this.nativeViewAgentId = "main";
    this.taskManager?.clear();
    for (const proj of this.transcriptProjections.values()) {
      proj.clear();
    }
    this.transcriptProjections.clear();
    this.visibleBackgroundJobs.clear();
    this.activeToasts.length = 0;
    this.pendingFileWrites.clear();
    this.completedFileWrites.clear();
    this.steerFeedback = undefined;
    this.planFeedback = undefined;
    this.composerDraft = "";
    this.activeViewAgentId = "main";
    this.selectedAgentIndex = 0;
    this.selectedAgentId = "main";
    this.isRunning = false;
    this.isRunTransitioning = false;

    const all = this.agentRegistry.getAllAgents();
    for (const a of all) {
      if (a.agentId !== "main") {
        this.agentRegistry.unregister(a.agentId);
      }
    }
    const mainAgent = this.agentRegistry.getAgent("main");
    if (mainAgent) {
      this.agentRegistry.updateStatus("main", "ready" as any);
    }

    this.notifyInteractionMode("empty-session");
    if (this.isTTY) {
      this.render();
    }
  }

  /**
   * 异常或中断时恢复终端状态
   */
  restoreTerminal(): void {
    this.decisionController.abortAll("Interrupted by user");
    this.stopRun();
    this.screenManager.forceRestore();
    if (this.isTTY) {
      if (this.nativeScrollback && this.nativeCursorRowsBelowEnd > 0) this.stdout.write(`\x1b[${this.nativeCursorRowsBelowEnd}B`);
      this.stdout.write("\x1b[?1007l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?25h\x1b[0m\n");
    }
  }

  destroy(): void {
    this.clearTranscriptSelection();
    // 退出时先停止渲染，避免备用屏幕已关闭后把最后一帧画到 Shell 主屏幕。
    this.renderSuppressed = true;
    this.closeResumePicker();
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = undefined;
    }
    if (this.feedbackTimer) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = undefined;
    }
    this.decisionController.abortAll("Interrupted by user");
    this.clearNativeFooter();
    this.screenManager.forceRestore();
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
    if (this.isTTY && typeof process.stdout.removeListener === "function") {
      process.stdout.removeListener("resize", this.boundResizeHandler);
    }
  }

  getActiveViewAgentId(): string {
    return this.activeViewAgentId;
  }

  getSelectedAgentId(): string {
    return this.selectedAgentId;
  }

  /**
   * 获取当前可供键盘导航与展示的 Agent 列表：
   * 1. Main 始终保留；
   * 2. Team 成员 (team-member / team-lead) 属于常驻编制，始终常驻保留；
   * 3. 临时子代理 (subagent)：只有 running 或 waiting 状态，或者当前正查看其详情视图时才显示；
   *    一旦执行完成 (completed / failed / interrupted) 且不在其视图中，直接从列表彻底消失！
   */
  getVisibleNavigableAgents(): AgentRecord[] {
    return this.treeProjection
      .getNavigableAgents(this.agentRegistry)
      .filter((a) => {
        if (a.agentId === "main" || a.type === "main") return true;
        // Team 成员常驻
        if (a.type === "team-member" || a.type === "team-lead") return true;
        // 当前正被查看的 Agent 保持可见
        if (a.agentId === this.activeViewAgentId) return true;
        // 临时子代理：仅在 running 或 waiting 时可见，做完就消失！
        return a.status === "running" || a.status === "waiting";
      });
  }

  private moveAgentSelection(direction: -1 | 1): void {
    const agents = this.getVisibleNavigableAgents();
    if (agents.length === 0) return;
    const current = agents.findIndex((agent) => agent.agentId === this.selectedAgentId);
    const next = (Math.max(0, current) + direction + agents.length) % agents.length;
    this.selectedAgentIndex = next;
    this.selectedAgentId = agents[next].agentId;
    this.requestRender({ immediate: true });
  }

  /**
   * 切换至指定 Agent 的独立视图
   */
  switchToAgentView(targetAgentId: string): void {
    this.clearTranscriptSelection();
    if (targetAgentId === "main") {
      this.returnToMainView();
      return;
    }
    if (!this.agentRegistry.getAgent(targetAgentId) && !this.transcriptProjections.has(targetAgentId)) return;
    if (this.nativeScrollback) this.clearNativeFooter();
    this.activeViewAgentId = targetAgentId;
    this.selectedAgentId = targetAgentId;
    this.selectedAgentIndex = this.getVisibleNavigableAgents().findIndex((agent) => agent.agentId === targetAgentId);
    this.notifyInteractionMode("agent-detail");
    this.render();
  }

  /**
   * 从 Agent 详情视图返回 Main 视图
   */
  returnToMainView(): void {
    this.clearTranscriptSelection();
    this.activeViewAgentId = "main";
    this.selectedAgentId = "main";
    this.selectedAgentIndex = 0;
    if (this.nativeScrollback) this.clearNativeFooter();
    this.notifyInteractionMode(this.isRunning ? "running-main" : this.hasSessionHistory() ? "session-ready" : "empty-session");
    this.render();
  }

  /**
   * 触发 Plan 结构化决策请求 (Plan Approval)
   */
  triggerPlanApproval(plan: ProposedPlan): void {
    this.planScrollOffset = 0;
    this.planShowDetails = false;
    const decisionId = `plan-appr-${plan.planId}`;
    if (this.decisionController.getActiveDecision()?.id === decisionId) {
      // 若当前决策已被 PlanMode 内部的 requestApproval 挂载激活，避免双重注册
      return;
    }
    this.decisionController
      .requestDecision({
        id: `plan-appr-${plan.planId}`,
        kind: "plan-approval",
        title: "Plan ready for approval",
        description: `Goal: ${plan.goal}\nSummary: ${plan.summary}`,
        options: [
          { id: "approve", label: "Approve & execute", shortcut: "a" },
          { id: "revise", label: "Revise plan", shortcut: "r" },
          { id: "cancel", label: "Cancel", destructive: true, shortcut: "c" },
        ],
        defaultIndex: 0,
        metadata: { plan },
      })
      .then((selectedOptionId) => {
        if (selectedOptionId === "approve") {
          if (this.planMode && this.planMode.getState() === "proposed") {
            this.planMode.resolveApproval(true);
            this.planMode.exit();
          }
        } else if (selectedOptionId === "revise") {
          this.isPlanRevisionMode = true;
          this.activePlanForRevision = plan;
          this.notifyInteractionMode("plan-revision");
          this.requestRender();
        } else {
          if (this.planMode && (this.planMode.getState() === "proposed" || this.planMode.getState() === "awaiting_approval")) {
            this.planMode.resolveApproval(false, "User cancelled");
            this.planMode.exit();
          }
        }
      })
      .catch(() => {});
  }

  /**
   * 提交 Plan Revision 修改指令
   */
  submitPlanRevision(revisionText: string): void {
    if (!this.isPlanRevisionMode) return;
    this.isPlanRevisionMode = false;
    const plan = this.activePlanForRevision;
    this.activePlanForRevision = undefined;
    this.notifyInteractionMode("running-main");

    const trimmed = revisionText.trim();
    if (!trimmed) {
      this.requestRender();
      return;
    }

    this.showPlanFeedback(`↻ Revising plan: "${trimmed.slice(0, 25)}..."`);
    this.pushToast(`↻ Plan revision requested`);

    if (this.planMode) {
      this.planMode.submitRevision(trimmed);
    }

    if (this.onPlanRevisionSubmittedCallback) {
      this.onPlanRevisionSubmittedCallback(trimmed, plan);
    }
  }

  /**
   * 取消 Plan Revision 自由文本输入并返回决策选择器
   */
  cancelPlanRevision(): void {
    if (!this.isPlanRevisionMode) return;
    this.isPlanRevisionMode = false;
    const plan = this.activePlanForRevision ?? this.planMode?.getProposedPlan();
    this.activePlanForRevision = undefined;
    if (plan) {
      this.triggerPlanApproval(plan);
    } else {
      this.notifyInteractionMode(
        this.isRunning
          ? "running-main"
          : this.hasSessionHistory()
          ? "session-ready"
          : "empty-session"
      );
    }
    this.requestRender();
  }

  /**
   * 获取运行期间导航与交互按键处理器
   */
  getNavigationHandler(): NavigationHandler {
    return {
      onResumeQueryChange: (query: string) => {
        this.sessionPicker?.setQuery(query);
        this.requestRender({ immediate: true });
      },
      onResumeMove: (delta: number) => {
        this.sessionPicker?.move(delta);
        this.requestRender({ immediate: true });
      },
      onResumeConfirm: () => {
        if (this.sessionPicker?.selected) this.closeResumePicker(this.sessionPicker.selected);
      },
      onResumeCancel: () => this.closeResumePicker(),
      onSkillsQueryChange: (query: string) => {
        this.skillsPicker?.setQuery(query);
        this.requestRender({ immediate: true });
      },
      onSkillsMove: (delta: number) => {
        this.skillsPicker?.move(delta);
        this.requestRender({ immediate: true });
      },
      onSkillsCycle: () => {
        const changed = this.skillsPicker?.cycleCurrentMode();
        if (changed && this.activeSkillService) {
          void this.activeSkillService.setSkillMode(changed.name, changed.newMode);
        }
        this.requestRender({ immediate: true });
      },
      onSkillsClose: () => this.closeSkillsPicker(),
      hasActiveDecision: () => this.decisionController.hasActiveDecision(),
      isPlanRevisionInput: () => this.isPlanRevisionMode,

      // 决策按键分发
      onDecisionKeyUp: () => {
        this.decisionController.selectPrevious();
        this.requestRender();
      },
      onDecisionKeyDown: () => {
        this.decisionController.selectNext();
        this.requestRender();
      },
      onDecisionConfirm: () => {
        this.decisionController.confirmSelected();
        this.requestRender();
      },
      onDecisionCancel: () => {
        if (this.isPlanRevisionMode) {
          this.cancelPlanRevision();
        } else {
          this.decisionController.cancelActive();
        }
        this.requestRender();
      },
      onDecisionShortcut: (key: string) => {
        const handled = Boolean(this.decisionController.handleShortcut(key));
        if (handled) {
          this.requestRender();
        }
        return handled;
      },
      onPlanPageUp: () => {
        if (this.decisionController.getActiveDecision()?.kind !== "plan-approval") return;
        this.planScrollOffset = Math.max(0, this.planScrollOffset - 4);
        this.requestRender({ immediate: true });
      },
      onPlanPageDown: () => {
        const decision = this.decisionController.getActiveDecision();
        if (decision?.kind !== "plan-approval") return;
        const plan = decision.metadata?.plan as ProposedPlan | undefined;
        this.planScrollOffset = Math.min(Math.max(0, (plan?.steps.length ?? 0) - 4), this.planScrollOffset + 4);
        this.requestRender({ immediate: true });
      },
      onPlanToggleDetails: () => {
        if (this.decisionController.getActiveDecision()?.kind !== "plan-approval") return false;
        this.planShowDetails = !this.planShowDetails;
        this.requestRender({ immediate: true });
        return true;
      },

      // Arrow keys move the agent-panel selection; Enter changes the viewed transcript.
      onKeyUp: () => {
        this.moveAgentSelection(-1);
      },

      onKeyDown: () => {
        this.moveAgentSelection(1);
      },

      // 鼠标滚轮/触控板向上：严格逐行平滑滚动，并通过 16ms 动画帧批处理合并重绘，消除积压延迟
      onMouseWheelUp: () => {
        const targetProj = this.getProjection(this.activeViewAgentId);
        targetProj.scrollUp(1);
        this.requestRender({ throttleMs: 16 });
      },

      // 鼠标滚轮/触控板向下：严格逐行平滑滚动，并通过 16ms 动画帧批处理合并重绘，消除积压延迟
      onMouseWheelDown: () => {
        const targetProj = this.getProjection(this.activeViewAgentId);
        targetProj.scrollDown(1);
        this.requestRender({ throttleMs: 16 });
      },
      onMouseButton: (mouse) => this.handleTranscriptMouse(mouse),

      onPageUp: () => {
        const proj = this.getProjection(this.activeViewAgentId);
        proj.pageUp(8);
        this.requestRender({ immediate: true });
      },
      onPageDown: () => {
        const proj = this.getProjection(this.activeViewAgentId);
        proj.pageDown(8);
        this.requestRender({ immediate: true });
      },
      onHome: () => {
        const proj = this.getProjection(this.activeViewAgentId);
        const rows = process.stdout.rows || 24;
        proj.scrollToTop(
          proj.getDisplayLines().length,
          Math.max(5, rows - 10)
        );
        this.requestRender({ immediate: true });
      },
      onEnd: () => {
        const proj = this.getProjection(this.activeViewAgentId);
        proj.scrollToBottom();
        this.requestRender({ immediate: true });
      },

      // Enter opens the selected agent from any view.
      onKeyEnter: () => {
        const navigable = this.getVisibleNavigableAgents();
        if (navigable.length === 0) return;
        const target = navigable.find((agent) => agent.agentId === this.selectedAgentId);
        if (!target) return;
        if (target.agentId === "main") this.returnToMainView();
        else this.switchToAgentView(target.agentId);
      },

      // Esc: Agent 详情退回 Main；Main 模式下重置光标选择
      onKeyEscape: () => {
        if (this.activeViewAgentId !== "main") {
          this.returnToMainView();
        } else {
          this.selectedAgentIndex = 0;
          this.selectedAgentId = "main";
          this.requestRender();
        }
      },

      onKeyLeft: () => {
        if (this.activeViewAgentId !== "main") {
          this.returnToMainView();
        }
      },

      // Ctrl+T toggles the task graph from Main or an agent transcript.
      onKeyCtrlT: () => {
        if (this.interactionMode === "running-main" || this.interactionMode === "navigation" || this.interactionMode === "agent-detail" || this.interactionMode === "session-ready") {
          const hasTasks = Boolean(this.taskManager && this.taskManager.getTasks().length > 0);
          if (hasTasks) {
            this.isTaskExpanded = !this.isTaskExpanded;
            this.requestRender();
          }
        }
      },
      onKeyCtrlO: () => {
        this.getProjection(this.activeViewAgentId).toggleDetailedView();
        this.requestRender({ immediate: true });
      },

      onApprovalKey: (key: "y" | "n") => {
        if (this.decisionController.hasActiveDecision()) {
          this.decisionController.handleShortcut(key);
          this.requestRender();
          return true;
        } else if (this.approvalService?.hasPending()) {
          this.approvalService.resolveActive(
            key === "y" ? "allow-once" : "deny"
          );
          this.requestRender();
          return true;
        }
        return false;
      },

      onInterrupt: () => {
        this.decisionController.abortAll("Interrupted by user");
        this.approvalService?.abortAll("Interrupted by user");
        this.restoreTerminal();
      },
    };
  }

  /**
   * 统一事件分发与 Projection 隔离维护
   */
  private handleEvent(event: HarnessEvent<any>): void {
    const agentId = event.agentId ?? "main";
    const agentRecord = this.agentRegistry.getAgent(agentId);
    const agentName =
      agentRecord?.name ?? event.agentName ?? (agentId === "main" ? "Main" : agentId);
    const agentType = event.agentType;

    this.metricsCollector.ensureAgent(agentId, agentName, agentType);
    const targetProj = this.getProjection(agentId);
    const mainProj = this.getProjection("main");

    switch (event.type) {
      case "agent.steered": {
        const steerContent = event.data?.content ?? "";
        if (steerContent) {
          this.clearPendingSteer(agentId);
          this.addUserMessageToTranscript(steerContent, agentId, "steer");
        }
        break;
      }

      case "agent.started": {
        this.ensureElapsedTimer();
        const userInput = event.data?.userInput;
        if (userInput && typeof userInput === "string" && agentId !== "main") {
          targetProj.addUserMessage(userInput);
        }
        break;
      }

      case "team.message.sent": {
        const msg = event.data?.message;
        if (msg) {
          const senderDisplay = msg.senderName ?? msg.senderAgentId;
          const formatted = `[Message from ${senderDisplay}]: ${msg.content}`;
          if (msg.targetAgentId === "*") {
            for (const a of this.agentRegistry.getAllAgents()) {
              if (a.agentId !== msg.senderAgentId) {
                this.getProjection(a.agentId).addSystemNotice(formatted);
              }
            }
          } else if (msg.targetAgentId) {
            this.getProjection(msg.targetAgentId).addSystemNotice(formatted);
          }
        }
        break;
      }

      case "tool.started": {
        this.ensureElapsedTimer();
        let toolName = event.data?.name ?? event.data?.toolName ?? "unknown";
        if (toolName.startsWith("tool.execute:")) {
          toolName = toolName.replace("tool.execute:", "");
        }
        const rawArgs = event.data?.rawArgs ?? event.data?.args ?? {};
        const summary = formatToolCallSummary(toolName, rawArgs);
        const callId =
          event.data?.toolCallId ?? event.spanId ?? event.data?.id ?? crypto.randomUUID();
        if ((toolName === "write_file" || toolName === "edit_file") && typeof rawArgs?.path === "string") {
          this.pendingFileWrites.set(callId, rawArgs.path);
        }

        this.treeProjection.setActivity(agentId, {
          kind: "tool",
          summary,
          startedAt: Date.now(),
        });

        targetProj.addToolCallStart(callId, toolName, summary, rawArgs);

        if (!this.isTTY) {
          console.log(`[${agentName}] ${summary}`);
        }
        break;
      }

      case "tool.completed": {
        let toolName = event.data?.name ?? event.data?.toolName ?? "tool";
        if (toolName.startsWith("tool.execute:")) {
          toolName = toolName.replace("tool.execute:", "");
        }
        const durationMs = event.data?.durationMs ?? 0;
        const callId = event.data?.toolCallId ?? event.spanId ?? event.data?.id ?? "";
        const touchedPath = this.pendingFileWrites.get(callId);
        if (touchedPath) this.completedFileWrites.add(touchedPath);
        this.pendingFileWrites.delete(callId);
        const preview = event.data?.preview ?? event.data?.resultSummary ?? "";
        const rawArgs = event.data?.rawArgs ?? event.data?.args;

        this.metricsCollector.recordToolCall(
          agentId,
          toolName,
          durationMs,
          true
        );
        this.treeProjection.clearActivity(agentId);

        targetProj.completeToolCall(callId, toolName, true, durationMs, preview, rawArgs);
        break;
      }

      case "tool.failed": {
        let toolName = event.data?.name ?? event.data?.toolName ?? "tool";
        if (toolName.startsWith("tool.execute:")) {
          toolName = toolName.replace("tool.execute:", "");
        }
        const durationMs = event.data?.durationMs ?? 0;
        const callId = event.data?.toolCallId ?? event.spanId ?? event.data?.id ?? "";
        this.pendingFileWrites.delete(callId);
        const rawArgs = event.data?.rawArgs ?? event.data?.args;

        this.metricsCollector.recordToolCall(
          agentId,
          toolName,
          durationMs,
          false
        );
        this.treeProjection.clearActivity(agentId);

        targetProj.completeToolCall(
          callId,
          toolName,
          false,
          durationMs,
          event.data?.error,
          rawArgs
        );
        break;
      }

      case "model.started": {
        this.ensureElapsedTimer();
        this.treeProjection.setActivity(agentId, {
          kind: "model",
          summary: "thinking...",
          startedAt: Date.now(),
        });
        targetProj.addThought();
        break;
      }

      case "memory.recalled": {
        const memories = event.data?.memories ?? [];
        if (memories.length > 0) {
          targetProj.recordRecalledMemories(memories);
        }
        break;
      }

      case "model.thought_delta": {
        const delta = event.data?.delta ?? "";
        this.streamedOutputTokens += Math.max(1, Math.ceil(delta.length / 4));
        this.treeProjection.setActivity(agentId, {
          kind: "model",
          summary: "thinking...",
          startedAt: Date.now(),
        });
        targetProj.appendThoughtDelta(delta);
        break;
      }

      case "model.content_delta": {
        const delta = event.data?.delta ?? "";
        this.streamedOutputTokens += Math.max(1, Math.ceil(delta.length / 4));
        this.treeProjection.setActivity(agentId, {
          kind: "model",
          summary: "responding...",
          startedAt: Date.now(),
        });
        targetProj.appendContentDelta(delta);
        break;
      }

      case "model.completed": {
        const inTokens =
          event.data?.inTokens ?? event.data?.usage?.prompt_tokens ?? 0;
        const outTokens =
          event.data?.outTokens ?? event.data?.usage?.completion_tokens ?? 0;
        const durationMs = event.data?.durationMs ?? 0;
        const reasoningDurationMs = event.data?.reasoningDurationMs ?? 0;
        const hasUsage =
          event.data?.hasUsage ?? (inTokens > 0 || outTokens > 0);

        this.metricsCollector.recordModelCall(
          agentId,
          inTokens,
          outTokens,
          durationMs,
          true,
          hasUsage
        );
        this.currentRunOutTokens += outTokens;
        this.streamedOutputTokens = 0;
        this.treeProjection.clearActivity(agentId);

        const effectiveReasoningMs = reasoningDurationMs > 0 ? reasoningDurationMs : (durationMs >= 500 ? durationMs : 0);
        targetProj.finalizeThought(effectiveReasoningMs, inTokens);
        targetProj.finalizeContent();
        targetProj.clearPendingThought();
        break;
      }

      case "agent.spawned": {
        const a = event.data?.agent;
        const spawnedName = a?.name ?? a?.agentId ?? "subagent";
        if (agentId !== "main") {
          mainProj.addChildLifecycleNotice(spawnedName, "started");
        }
        if (!this.isTTY) {
          console.log(`[Runtime] agent started: ${spawnedName}`);
        }
        break;
      }

      case "agent.running": {
        this.metricsCollector.updateAgentStatus(agentId, "running");
        break;
      }

      case "agent.waiting": {
        this.metricsCollector.updateAgentStatus(agentId, "waiting");
        this.treeProjection.setActivity(agentId, {
          kind: "waiting",
          summary: "waiting",
          startedAt: Date.now(),
        });
        if (agentId !== "main") {
          mainProj.addChildLifecycleNotice(agentName, "waiting");
        }
        break;
      }

      case "agent.completed": {
        this.metricsCollector.updateAgentStatus(
          agentId,
          "completed",
          event.data?.durationMs
        );
        this.treeProjection.clearActivity(agentId);
        this.pushToast(`✓ ${agentName} completed`);

        if (agentId !== "main") {
          mainProj.addChildLifecycleNotice(agentName, "completed");
        }
        if (!this.isTTY) {
          console.log(`[${agentName}] completed ✓`);
        }
        break;
      }

      case "agent.failed": {
        this.metricsCollector.updateAgentStatus(
          agentId,
          "failed",
          event.data?.durationMs
        );
        this.treeProjection.clearActivity(agentId);
        this.pushToast(`✗ ${agentName} failed`);

        if (agentId !== "main") {
          mainProj.addChildLifecycleNotice(
            agentName,
            "failed",
            event.data?.error?.message
          );
        }
        if (!this.isTTY) {
          console.log(
            `[${agentName}] failed ✗: ${event.data?.error?.message ?? ""}`
          );
        }
        break;
      }

      case "agent.interrupted": {
        this.metricsCollector.updateAgentStatus(agentId, "interrupted");
        this.treeProjection.clearActivity(agentId);
        this.pushToast(`⊘ ${agentName} interrupted`);
        if (agentId !== "main") {
          mainProj.addChildLifecycleNotice(agentName, "interrupted");
        }
        break;
      }

      case "user.steer_queued": {
        this.showSteerFeedback(
          `↻ Steering ${event.data?.targetAgentId ?? "agent"}...`
        );
        break;
      }

      case "user.steer_applied": {
        this.showSteerFeedback(`✓ Guidance applied`);
        break;
      }

      case "plan.proposed": {
        const plan = event.data?.plan as ProposedPlan;
        if (plan) {
          this.triggerPlanApproval(plan);
        }
        this.requestRender();
        break;
      }

      case "plan.approved": {
        const plan =
          (event.data?.plan as ProposedPlan) ?? this.planMode?.getProposedPlan();
        this.pushToast(`✓ Plan approved & TaskGraph activated`);
        this.showPlanFeedback(`✓ Plan approved & executing`);
        if (this.onPlanApprovedCallback && plan) {
          this.onPlanApprovedCallback(plan);
        }
        this.requestRender();
        break;
      }

      case "plan.rejected": {
        this.pushToast(`⊘ Plan proposal cancelled`);
        this.showPlanFeedback(`Plan cancelled`);
        this.requestRender();
        break;
      }

      case "plan.patch_started": {
        this.showPlanFeedback(`↻ Updating plan from user guidance...`);
        break;
      }

      case "plan.patch_completed": {
        this.showPlanFeedback(`Plan revised`);
        break;
      }

      case "job.started":
      case "job.promoted": {
        const job = event.data as JobRecord;
        if (job && isUserVisibleBackgroundJob(job)) {
          this.visibleBackgroundJobs.set(job.id, job);
        }
        break;
      }

      case "job.completed": {
        const job = event.data as JobRecord;
        if (job) {
          const wasVisible = this.visibleBackgroundJobs.has(job.id) || isUserVisibleBackgroundJob(job);
          this.visibleBackgroundJobs.delete(job.id);
          if (wasVisible) this.pushToast(`Background command completed: ${job.command}`);
        }
        break;
      }

      case "job.failed": {
        const job = event.data as JobRecord;
        if (job) {
          const wasVisible = this.visibleBackgroundJobs.has(job.id) || isUserVisibleBackgroundJob(job);
          this.visibleBackgroundJobs.delete(job.id);
          if (wasVisible) {
            const ownerProj = this.getProjection(job.ownerAgentId ?? agentId);
            ownerProj.addSystemNotice(`Background command failed: ${job.command}`);
          }
        }
        break;
      }

      case "job.cancelled":
      case "job.timed_out": {
        const job = event.data as JobRecord;
        if (job) {
          const wasVisible = this.visibleBackgroundJobs.has(job.id) || isUserVisibleBackgroundJob(job);
          this.visibleBackgroundJobs.delete(job.id);
          if (wasVisible) {
            const ownerProj = this.getProjection(job.ownerAgentId ?? agentId);
            ownerProj.addSystemNotice(`Background command ${job.status}: ${job.command}`);
          }
        }
        break;
      }
    }

    if (this.isTTY && this.isRunning) {
      this.requestRender();
    }
  }

  private pushToast(text: string): void {
    this.activeToasts.push({ text, createdAt: Date.now() });
    if (this.activeToasts.length > 2) {
      this.activeToasts.shift();
    }
    this.scheduleFeedbackExpiry();
    this.requestRender();
  }

  requestRender(options?: { immediate?: boolean; throttleMs?: number }): void {
    if (!this.isTTY) return;

    // 当处于 Run 初始化 Transition 保护期时，禁止立刻渲染，只累积标记 dirty 状态
    if (this.renderSuppressed) {
      this.needsRenderAfterTransition = true;
      return;
    }

    if (options?.immediate) {
      if (this.renderThrottleTimer) {
        clearTimeout(this.renderThrottleTimer);
        this.renderThrottleTimer = undefined;
      }
      this.render();
      return;
    }

    if (this.renderThrottleTimer) return;

    const delay = typeof options?.throttleMs === "number" ? options.throttleMs : 50;
    this.renderThrottleTimer = setTimeout(() => {
      this.renderThrottleTimer = undefined;
      if (this.isTTY && !this.renderSuppressed) {
        this.render();
      }
    }, delay);
  }

  private handleResize(): void {
    this.clearTranscriptSelection();
    if (this.isTTY && !this.renderSuppressed) {
      this.requestRender();
    }
  }

  private clearTranscriptSelection(): void {
    if (this.selectionScrollTimer) clearInterval(this.selectionScrollTimer);
    this.selectionScrollTimer = undefined;
    this.transcriptSelection = undefined;
    this.screenSelection = undefined;
    this.isSelectingTranscript = false;
    this.selectionPointer = undefined;
  }

  private selectableTranscriptLines(viewport: NonNullable<CliPresenter["transcriptViewport"]>): string[] {
    const lines = this.getProjection(viewport.agentId).getDisplayLines(viewport.width);
    const selectable = [this.lastFrameLines[0] ?? "", ...(lines.length ? lines : [this.lastFrameLines[1] ?? ""])];
    while (selectable.length < viewport.start + viewport.height + 1) selectable.push("");
    return selectable;
  }

  private updateSelectionFocus(row: number, col: number): void {
    const viewport = this.transcriptViewport;
    if (!viewport) return;
    if (this.screenSelection) {
      const next = { line: Math.max(0, Math.min(this.lastFrameLines.length - 1, row - 1)), column: Math.max(0, col - 1) };
      if (this.screenSelection.focus.line === next.line && this.screenSelection.focus.column === next.column) return;
      this.screenSelection.focus = next;
      this.requestRender({ throttleMs: 16 });
      return;
    }
    if (!this.transcriptSelection) return;
    const relativeRow = Math.max(0, Math.min(viewport.height - 1, row - viewport.top));
    const lines = this.selectableTranscriptLines(viewport);
    const line = row < viewport.top ? 0 : Math.min(lines.length - 1, viewport.start + relativeRow + 1);
    const next = {
      line,
      column: Math.max(0, Math.min(line === 0 ? this.terminalRenderer.getColumns() : viewport.width, col - 1)),
    };
    if (this.transcriptSelection.focus.line === next.line && this.transcriptSelection.focus.column === next.column) return;
    this.transcriptSelection.focus = next;
    this.requestRender({ throttleMs: 16 });
  }

  private updateSelectionAutoScroll(): void {
    if (this.selectionScrollTimer) clearInterval(this.selectionScrollTimer);
    this.selectionScrollTimer = undefined;
    const viewport = this.transcriptViewport;
    const pointer = this.selectionPointer;
    if (!viewport || !pointer || !this.isSelectingTranscript || this.screenSelection) return;
    const direction = pointer.row <= viewport.top ? -1 : pointer.row >= viewport.top + viewport.height - 1 ? 1 : 0;
    if (!direction) return;
    this.selectionScrollTimer = setInterval(() => {
      if (!this.isSelectingTranscript || !this.selectionPointer || !this.transcriptViewport) return;
      const current = this.transcriptViewport;
      const proj = this.getProjection(current.agentId);
      if (direction < 0) proj.scrollUp(1, proj.getDisplayLines(current.width).length, current.height);
      else proj.scrollDown(1);
      current.start = proj.getViewportStartIndex(current.width, current.height);
      this.updateSelectionFocus(this.selectionPointer.row, this.selectionPointer.col);
    }, 90);
  }

  private handleTranscriptMouse(mouse: { button: number; col: number; row: number; isRelease?: boolean; isDrag?: boolean; isMotion?: boolean }): void {
    const viewport = this.transcriptViewport;
    if (!viewport || this.sessionPicker || this.skillsPicker || this.nativeScrollback) return;
    if ((mouse.button & 3) !== 0 && !mouse.isRelease) return;

    if (mouse.isRelease) {
      if (!this.isSelectingTranscript) return;
      this.updateSelectionFocus(mouse.row, mouse.col);
      this.isSelectingTranscript = false;
      if (this.selectionScrollTimer) clearInterval(this.selectionScrollTimer);
      this.selectionScrollTimer = undefined;
      const selection = this.transcriptSelection ?? this.screenSelection;
      if (!selection) return;
      const lines = this.screenSelection
        ? this.lastFrameLines
        : this.selectableTranscriptLines(viewport).map((line) => truncateToDisplayWidth(line, viewport.width));
      const text = selectedText(lines, selection);
      if (text) {
        this.pushToast(SystemClipboard.writeText(text)
          ? "✓ Selected text copied to clipboard"
          : "✖ Failed to copy selected text");
      }
      return;
    }

    if (mouse.isMotion || mouse.isDrag) {
      if (!this.isSelectingTranscript) return;
      this.selectionPointer = { row: mouse.row, col: mouse.col };
      this.updateSelectionFocus(mouse.row, mouse.col);
      this.updateSelectionAutoScroll();
      return;
    }

    this.clearTranscriptSelection();
    if (mouse.row < 1 || mouse.row > this.lastFrameLines.length) return;
    if (mouse.row > 1 && mouse.row < viewport.top + viewport.height) {
      const lines = this.selectableTranscriptLines(viewport);
      const line = Math.min(lines.length - 1, viewport.start + mouse.row - viewport.top + 1);
      const position = { line, column: Math.max(0, Math.min(viewport.width, mouse.col - 1)) };
      this.transcriptSelection = { anchor: position, focus: position };
    } else if (mouse.row === 1) {
      const position = { line: 0, column: Math.max(0, Math.min(this.terminalRenderer.getColumns(), mouse.col - 1)) };
      this.transcriptSelection = { anchor: position, focus: position };
    } else {
      const position = { line: mouse.row - 1, column: Math.max(0, mouse.col - 1) };
      this.screenSelection = { anchor: position, focus: position };
    }
    this.isSelectingTranscript = true;
    this.selectionPointer = { row: mouse.row, col: mouse.col };
    this.requestRender({ immediate: true });
  }

  private renderNativeScrollback(
    transcriptLines: string[],
    footerLines: string[],
    composerRowInFooter: number | undefined,
    composerCol: number | undefined,
    columns: number,
    rows: number,
    viewId = this.activeViewAgentId
  ): void {
    const liveCapacity = footerLines.length > 0
      ? Math.max(1, rows - footerLines.length - 2)
      : rows;
    const commitCount = Math.max(0, transcriptLines.length - liveCapacity);
    const committed = transcriptLines.slice(0, commitCount);
    const liveLines = [...transcriptLines.slice(commitCount), ...footerLines]
      .map((line) => truncateToDisplayWidth(line, Math.max(1, columns - 2)));
    const viewChanged = this.nativeViewAgentId !== viewId;
    let firstChanged = 0;
    if (!viewChanged) {
      while (firstChanged < Math.min(this.nativeCommittedLines.length, committed.length)
        && this.nativeCommittedLines[firstChanged] === committed[firstChanged]) firstChanged++;
    }

    let output = "\x1b[?25l";
    if (this.nativeLastLiveRows > 0) {
      if (this.nativeCursorRowsBelowEnd > 0) output += `\x1b[${this.nativeCursorRowsBelowEnd}B`;
      if (this.nativeLastLiveRows > 1) output += `\x1b[${this.nativeLastLiveRows - 1}A`;
      output += "\r\x1b[J";
    } else {
      output += "\r\n";
    }
    if (viewId === "main" && !this.nativeHeaderPrinted) {
      output += `${truncateToDisplayWidth(`\x1b[36mNash\x1b[0m · \x1b[90m${this.modelName} · ${this.projectRoot}\x1b[0m`, Math.max(1, columns - 2))}\r\n\r\n`;
      if (!this.hasSessionHistory()) {
        const showcase = WelcomeShowcase.render({
          modelName: this.modelName,
          projectRoot: this.projectRoot,
          width: Math.max(20, columns - 2),
        });
        for (const line of showcase) {
          output += `${truncateToDisplayWidth(line, Math.max(1, columns - 2))}\x1b[0m\r\n`;
        }
      }
      this.nativeHeaderPrinted = true;
    }
    if (viewChanged) {
      output += `\x1b[90mViewing ${viewId}\x1b[0m\r\n`;
      for (const line of committed) {
        output += `${truncateToDisplayWidth(line, Math.max(1, columns - 2))}\x1b[0m\r\n`;
      }
    } else if (committed.length > this.nativeCommittedLines.length) {
      for (const line of committed.slice(this.nativeCommittedLines.length)) {
        output += `${truncateToDisplayWidth(line, Math.max(1, columns - 2))}\x1b[0m\r\n`;
      }
    }
    for (const [index, line] of liveLines.entries()) {
      output += `${line}\x1b[0m${index < liveLines.length - 1 ? "\r\n" : ""}`;
    }
    if (composerCol !== undefined) {
      const cursorRow = composerRowInFooter === undefined
        ? liveLines.length - 1
        : footerLines.length > 0
          ? Math.min(liveLines.length - 1, transcriptLines.length - commitCount + composerRowInFooter)
          : Math.min(liveLines.length - 1, composerRowInFooter);
      this.nativeCursorRowsBelowEnd = Math.max(0, liveLines.length - 1 - cursorRow);
      if (this.nativeCursorRowsBelowEnd > 0) output += `\x1b[${this.nativeCursorRowsBelowEnd}A`;
      output += `\x1b[${Math.max(1, Math.min(columns, composerCol))}G\x1b[?25h`;
    } else {
      this.nativeCursorRowsBelowEnd = 0;
      output += "\x1b[?25l";
    }
    this.stdout.write(output);
    this.nativeLastLiveRows = liveLines.length;
    this.nativeLastFooterRows = footerLines.length;
    this.nativeCommittedLines = committed;
    this.nativeViewAgentId = viewId;
  }

  /**
   * 为即将向终端直接打印多行文本的操作（如 Slash 命令）准备干净的输出环境：
   * 在 Native Scrollback 模式下安全清除 Live 区域，确保控制台输出从干净的行自然向下滚屏，
   * 绝不发生光标错位、残影与重复重绘。
   */
  prepareForDirectTerminalOutput(): void {
    if (!this.isTTY || !this.nativeScrollback) return;
    if (this.nativeLastLiveRows > 0) {
      let output = "";
      if (this.nativeCursorRowsBelowEnd > 0) output += `\x1b[${this.nativeCursorRowsBelowEnd}B`;
      if (this.nativeLastLiveRows > 1) output += `\x1b[${this.nativeLastLiveRows - 1}A`;
      output += `\r\x1b[J\x1b[0m\x1b[?25h`;
      this.stdout.write(output);
      this.nativeLastLiveRows = 0;
      this.nativeLastFooterRows = 0;
      this.nativeCursorRowsBelowEnd = 0;
    }
  }

  private clearNativeFooter(): void {
    if (!this.isTTY || !this.nativeScrollback || this.nativeLastFooterRows === 0) return;
    let output = "";
    if (this.nativeCursorRowsBelowEnd > 0) output += `\x1b[${this.nativeCursorRowsBelowEnd}B`;
    if (this.nativeLastFooterRows > 1) output += `\x1b[${this.nativeLastFooterRows - 1}A`;
    this.stdout.write(`${output}\r\x1b[J\x1b[0m\x1b[?25h`);
    this.nativeLastFooterRows = 0;
    this.nativeLastLiveRows = 0;
    this.nativeCursorRowsBelowEnd = 0;
  }

  /**
   * 统一计算 ScreenLayout 并执行终端渲染。
   */
  render(): void {
    if (!this.isTTY) return;
    if (this.renderSuppressed) return;

    if (this.sessionPicker) {
      const rows = this.terminalRenderer.getRows();
      const columns = this.terminalRenderer.getColumns();
      const lines = this.sessionPicker.render(columns, rows);
      if (this.nativeScrollback) this.renderNativeScrollback(lines, [], undefined, 10 + getVisibleWidth(this.sessionPicker.query), columns, rows, "sessions");
      else this.terminalRenderer.renderFullScreen(
        lines,
        { row: Math.max(1, rows - 1), col: Math.min(columns, 10 + getVisibleWidth(this.sessionPicker.query)) }
      );
      return;
    }

    if (this.skillsPicker) {
      const rows = this.terminalRenderer.getRows();
      const columns = this.terminalRenderer.getColumns();
      const lines = this.skillsPicker.render(columns, rows);
      const searchRow = 4;
      const searchCol = Math.max(1, Math.min(columns - 2, 4 + getVisibleWidth(this.skillsPicker.query)));
      if (this.nativeScrollback) this.renderNativeScrollback(lines, [], searchRow, searchCol, columns, rows, "skills");
      else this.terminalRenderer.renderFullScreen(lines, { row: searchRow + 1, col: searchCol });
      return;
    }

    const columns = this.terminalRenderer.getColumns();
    const rows = this.terminalRenderer.getRows();
    const maxDisplayWidth = Math.max(20, columns - 2);

    const activeAgentRecord = this.agentRegistry.getAgent(this.activeViewAgentId);
    const activeViewName =
      this.activeViewAgentId === "main"
        ? "Main"
        : activeAgentRecord?.name ??
          (activeAgentRecord
            ? AgentTreeProjection.getDisplayName(activeAgentRecord)
            : this.activeViewAgentId);

    // 计算系统综合状态
    const isReady =
      !this.isRunning ||
      this.interactionMode === "session-ready" ||
      this.interactionMode === "empty-session";
    let stateText = isReady ? "ready" : "working";
    const activeDecision = this.decisionController.getActiveDecision();
    if (activeDecision) {
      stateText = "awaiting approval";
    } else if (this.planMode?.getState() === "exploring") {
      stateText = "planning";
    } else if (
      this.agentRegistry.getAllAgents().filter((a) => a.status === "running")
        .length > 1
    ) {
      stateText = "coordinating";
    }

    // =========================================================================
    // 1. Header (固定第 1 行，保持简洁统一：左侧显示 Nash 与运行状态，右侧显示模型与路径)
    // =========================================================================
    const leftHeader = isReady
      ? `\x1b[36mNash\x1b[0m · \x1b[32mready\x1b[0m`
      : `\x1b[36mNash\x1b[0m · \x1b[33m${stateText}\x1b[0m`;
    const rightHeaderRaw = `\x1b[90m${this.modelName} · ${this.projectRoot}\x1b[0m`;
    const maxRightWidth = Math.max(0, columns - getVisibleWidth(leftHeader) - 2);
    const rightHeader = truncateToDisplayWidth(rightHeaderRaw, maxRightWidth);
    const headerPad = Math.max(
      2,
      columns - getVisibleWidth(leftHeader) - getVisibleWidth(rightHeader)
    );
    const headerLine = `${leftHeader}${" ".repeat(headerPad)}${rightHeader}`;

    // =========================================================================
    // 1.5 Live Status Line (实时运行与 Token 指示行)
    // =========================================================================
    const liveStatusLines: string[] = [];
    const elapsedMs = Math.max(0, Date.now() - this.runStartTime);
    const durationHuman = formatDurationHuman(elapsedMs);
    const currentOutTokens = this.currentRunOutTokens + this.streamedOutputTokens;
    const tokensHuman = formatTokensHuman(currentOutTokens);

    if (this.isRunning && !isReady) {
      let statusVerb = "Harmonizing...";
      const act = this.treeProjection.getActivity(this.activeViewAgentId);
      if (act && act.summary) {
        if (act.kind === "model") {
          statusVerb = act.summary.includes("responding") ? "Responding..." : "Harmonizing...";
        } else if (act.kind === "tool") {
          statusVerb = `${act.summary}...`;
        } else if (act.kind === "waiting") {
          statusVerb = "Waiting...";
        }
      } else if (stateText === "planning") {
        statusVerb = "Planning...";
      } else if (stateText === "coordinating") {
        statusVerb = "Coordinating...";
      } else if (stateText === "awaiting approval") {
        statusVerb = "Awaiting approval...";
      }

      const statusIcon = "\x1b[38;5;208m✳\x1b[0m";
      const statusTitle = `\x1b[38;5;208m${statusVerb}\x1b[0m`;
      const statusMeta = `\x1b[90m(${durationHuman} · ↓ ${tokensHuman})\x1b[0m`;
      liveStatusLines.push(`  ${statusIcon} ${statusTitle} ${statusMeta}`);
    }

    // =========================================================================
    // 2. Plan Panel (双阶段独立互斥投影，位于输入框上方；完工后自动收起)
    // =========================================================================
    const planLines: string[] = [];
    const allTasks = this.taskManager ? this.taskManager.getTasks() : [];
    const proposedPlan = this.planMode?.getProposedPlan() ?? (activeDecision?.metadata?.plan as ProposedPlan | undefined);
    const isAwaitingPlanApproval = activeDecision?.kind === "plan-approval";

    const hasActiveTasks = allTasks.some(
      (t) =>
        t.status === "running" ||
        t.status === "blocked" ||
        t.status === "ready"
    );

    if (isAwaitingPlanApproval && proposedPlan) {
      // 阶段 A: Awaiting Approval 阶段，展示 ProposedPlan 文档化步骤
      const proposedRendered = ProposedPlanProjection.render(proposedPlan, {
        maxWidth: maxDisplayWidth,
        maxVisibleSteps: 4,
        stepOffset: this.planScrollOffset,
        showDetails: this.planShowDetails,
      });
      planLines.push(...proposedRendered.map((l) => truncateToDisplayWidth(l, maxDisplayWidth)));
    } else if (allTasks.length > 0 && hasActiveTasks) {
      // 阶段 B: Executing 阶段，仅当存在活跃任务 (running/blocked/ready) 时展示；
      // 一旦任务全部完成 (all completed / done ✓)，自动收起，将垂直空间立即归还给 Transcript 正文！
      const taskGraphRendered = ActiveTaskGraphProjection.render(allTasks, {
        isExpanded: this.isTaskExpanded,
        maxWidth: maxDisplayWidth,
        maxVisibleTasks: Math.min(5, Math.max(2, Math.floor(rows / 6))),
        agentRegistry: this.agentRegistry,
      });
      planLines.push(...taskGraphRendered.map((l) => truncateToDisplayWidth(l, maxDisplayWidth)));
    }

    // =========================================================================
    // 3. Agents Panel (垂直列表：子代理完工即消失，Team 常驻)
    // =========================================================================
    const navigableAgents = this.getVisibleNavigableAgents();
    const selectedPosition = navigableAgents.findIndex((agent) => agent.agentId === this.selectedAgentId);
    this.selectedAgentIndex = selectedPosition >= 0 ? selectedPosition : 0;
    this.selectedAgentId = navigableAgents[this.selectedAgentIndex]?.agentId ?? "main";
    const agentLines: string[] = [];
    let selectedAgentRow = 1;

    if (navigableAgents.length > 1) {
      const agentHeaderRight = activeDecision
        ? activeDecision.kind === "plan-approval"
          ? `\x1b[90m↑↓ choose · PgUp/PgDn steps\x1b[0m`
          : `\x1b[90m↑↓ choose · Enter confirm\x1b[0m`
        : this.activeViewAgentId === "main"
          ? `\x1b[90m↑↓ scroll · Ctrl+N/P select · Enter open\x1b[0m`
          : `\x1b[90m↑↓ scroll · Ctrl+N/P select · Enter open · Esc Main\x1b[0m`;
      const workingAgents = navigableAgents.filter((agent) => agent.status === "running").length;
      const agentTitleLeft = `\x1b[1mAgents\x1b[0m \x1b[90m${workingAgents}/${navigableAgents.length} working\x1b[0m`;
      const agentHeaderPad = Math.max(
        2,
        columns - getVisibleWidth(agentTitleLeft) - getVisibleWidth(agentHeaderRight) - 2
      );
      agentLines.push(truncateToDisplayWidth(`${agentTitleLeft}${" ".repeat(agentHeaderPad)}${agentHeaderRight}`, maxDisplayWidth));

      const maxVisibleAgents = Math.min(5, Math.max(1, Math.floor(rows / 6)));
      const totalAgents = navigableAgents.length;

      let agentWindowStart = 0;
      if (this.selectedAgentIndex >= maxVisibleAgents) {
        agentWindowStart = Math.min(
          this.selectedAgentIndex - maxVisibleAgents + 1,
          Math.max(0, totalAgents - maxVisibleAgents)
        );
      }
      const visibleAgentsSlice = navigableAgents.slice(
        agentWindowStart,
        agentWindowStart + maxVisibleAgents
      );

      for (let i = 0; i < visibleAgentsSlice.length; i++) {
        const a = visibleAgentsSlice[i];
        const actualIndex = agentWindowStart + i;
        const isSelected = actualIndex === this.selectedAgentIndex;
        const isCurrentView = a.agentId === this.activeViewAgentId;

        const cursorPrefix = isSelected ? "\x1b[36m> \x1b[0m" : "  ";
        const nameColor = isCurrentView ? "\x1b[36m\x1b[1m" : "\x1b[0m";
        const hierarchy = a.parentAgentId ? `${"  ".repeat(Math.min(a.depth, 3))}└ ` : "";
        const role = a.type === "team-member" ? " · team" : a.type === "subagent" ? " · subagent" : "";
        const name = `${hierarchy}${AgentTreeProjection.getDisplayName(a)}${role}${isCurrentView && !isSelected ? " [view]" : ""}`;

        let statusColor = "\x1b[90m";
        let statusLabel: string = a.status;
        if (activeDecision && a.agentId === "main") {
          statusColor = "\x1b[35m";
          statusLabel = "waiting approval";
        } else if (isReady && a.agentId === "main") {
          statusColor = "\x1b[32m";
          statusLabel = "ready";
        } else if (a.status === "completed") {
          statusColor = "\x1b[32m";
          statusLabel = "done ✓";
        } else if (a.status === "running") {
          statusColor = "\x1b[33m";
          statusLabel = "working";
        } else if (a.status === "waiting") {
          statusColor = "\x1b[35m";
          statusLabel = "waiting";
        } else if (a.status === "failed") {
          statusColor = "\x1b[31m";
          statusLabel = "failed ✗";
        } else if (a.status === "interrupted") {
          statusColor = "\x1b[33m";
          statusLabel = "interrupted ⊘";
        } else if ((a.status as string) === "ready") {
          statusColor = "\x1b[32m";
          statusLabel = "ready";
        }

        const leftPart = `${cursorPrefix}${nameColor}${name}\x1b[0m`;
        const rightPart = `${statusColor}${statusLabel}\x1b[0m`;
        const fittedLeft = truncateToDisplayWidth(leftPart, Math.max(8, columns - getVisibleWidth(rightPart) - 3));
        const pad = Math.max(
          2,
          columns - getVisibleWidth(fittedLeft) - getVisibleWidth(rightPart) - 2
        );
        if (isSelected) selectedAgentRow = agentLines.length;
        agentLines.push(truncateToDisplayWidth(`${fittedLeft}${" ".repeat(pad)}${rightPart}`, maxDisplayWidth));
      }

      if (rows >= 20) {
        const selected = navigableAgents[this.selectedAgentIndex];
        if (selected) {
          const task =
            this.taskManager?.getTasks().find((item) => item.id === selected.currentTaskId) ??
            this.taskManager?.getTasks().find((item) => item.ownerAgentId === selected.agentId && item.status === "running");
          const activity = this.treeProjection.getActivity(selected.agentId)?.summary;
          const detail = task
            ? `${selected.name ?? selected.agentId} · ${task.subject}${task.status === "blocked" && task.blockedReason ? ` · ${task.blockedReason}` : ""}`
            : activity ? `${selected.name ?? selected.agentId} · ${activity}` : `${selected.roleDescription ?? selected.status}`;
          agentLines.push(truncateToDisplayWidth(`  \x1b[90m↳ ${detail}\x1b[0m`, maxDisplayWidth));
        }
      }
    }

    // =========================================================================
    // 3.5 Pending Steer Panel (待注入提示条，置于输入框上方)
    // =========================================================================
    const pendingSteerLines: string[] = [];
    const activePendingSteer =
      this.getPendingSteer(this.activeViewAgentId) ??
      (this.activeViewAgentId === "main" ? Array.from(this.pendingSteers.values())[0] : undefined);

    if (activePendingSteer) {
      const activeAgent = this.agentRegistry.getAgent(this.activeViewAgentId);
      const activeTargetName = activeAgent?.name ?? (this.activeViewAgentId === "main" ? "Main" : this.activeViewAgentId);
      const steerPrefix = `\x1b[38;5;214m⇥ Queued for ${activeTargetName}:\x1b[0m `;
      const steerSuffix = ` \x1b[90m(esc to interrupt & send)\x1b[0m`;
      const availableTextWidth = Math.max(10, maxDisplayWidth - getVisibleWidth(steerPrefix) - getVisibleWidth(steerSuffix) - 4);
      const fittedContent = truncateToDisplayWidth(activePendingSteer.content, availableTextWidth);
      pendingSteerLines.push(truncateToDisplayWidth(`  ${steerPrefix}\x1b[1m${fittedContent}\x1b[0m${steerSuffix}`, maxDisplayWidth));
    }

    // =========================================================================
    // 4. Composer / Decision Panel (双横线输入框)
    // =========================================================================
    const composerLines: string[] = [];
    let cursorPosition: { row: number; col: number } | null = null;
    const draftGraphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.composerDraft), (part) => part.segment);
    const draftCursor = Math.min(this.composerCursorIndex ?? draftGraphemes.length, draftGraphemes.length);
    const beforeCursor = draftGraphemes.slice(0, draftCursor).join("");
    const afterCursor = draftGraphemes.slice(draftCursor).join("");
    const composerWidth = Math.max(1, columns - 4);
    const beforeWidth = afterCursor ? Math.max(1, composerWidth - 8) : composerWidth;
    const visibleBefore = tailToDisplayWidth(beforeCursor, beforeWidth);
    const visibleAfter = truncateToDisplayWidth(afterCursor, Math.max(0, composerWidth - getVisibleWidth(visibleBefore)));
    const visibleDraft = visibleBefore + visibleAfter;

    const ruleLine = `\x1b[38;5;238m${"─".repeat(Math.max(1, columns - 2))}\x1b[0m`;

    if (activeDecision && !this.isPlanRevisionMode) {
      const decRendered = DecisionRenderer.renderDecision({
        decision: activeDecision,
        totalPending: this.decisionController.getPendingCount(),
        maxWidth: maxDisplayWidth,
      });
      composerLines.push(ruleLine);
      composerLines.push(...decRendered);
      composerLines.push(ruleLine);
      cursorPosition = null;
    } else if (this.isPlanRevisionMode) {
      composerLines.push(ruleLine);
      composerLines.push(`\x1b[33mDescribe what should change:\x1b[0m`);
      composerLines.push(`> ${visibleDraft}`);
      composerLines.push(ruleLine);
      cursorPosition = {
        row: 2,
        col: 3 + getVisibleWidth(visibleBefore),
      };
    } else {
      const isSlashMode = this.composerDraft.startsWith("/");
      const slashSuggestions = isSlashMode
        ? getSlashCommandSuggestions(this.composerDraft, 5)
        : null;
      const suggestionLines: string[] = [];

      if (slashSuggestions && slashSuggestions.matches.length > 0) {
        for (const m of slashSuggestions.matches) {
          const prefix = m.highlightPrefix;
          const unhighlighted = m.name.slice(prefix.length);
          const nameStyled = `\x1b[36m${prefix}\x1b[0m\x1b[1m${unhighlighted}\x1b[0m`;
          const padLen = Math.max(2, 16 - m.name.length);
          const pad = " ".repeat(padLen);
          const desc = `\x1b[90m${m.description}\x1b[0m`;
          const lineText = `  ${nameStyled}${pad}${desc}`;
          suggestionLines.push(truncateToDisplayWidth(lineText, maxDisplayWidth));
        }
        if (slashSuggestions.totalMatches > slashSuggestions.matches.length) {
          const remaining = slashSuggestions.totalMatches - slashSuggestions.matches.length;
          suggestionLines.push(
            truncateToDisplayWidth(
              `  \x1b[90m… and ${remaining} more (type to filter, Tab to complete)\x1b[0m`,
              maxDisplayWidth
            )
          );
        }
      }

      if (suggestionLines.length > 0) {
        composerLines.push(ruleLine);
        composerLines.push(...suggestionLines);
      }
      composerLines.push(ruleLine);

      if (this.composerDraft) {
        const styledDraft = visibleDraft
          .replace(/\[Pasted text \([^)]+\)\]/g, "\x1b[38;5;214m$&\x1b[0m")
          .replace(/\[Image: [^\]]+\]/g, "\x1b[38;5;39m$&\x1b[0m");

        const isCursorAtEnd = draftCursor === draftGraphemes.length;
        const ghostSuffix =
          isCursorAtEnd && slashSuggestions?.ghostText
            ? `\x1b[90m${slashSuggestions.ghostText}\x1b[0m`
            : "";

        const isBang = styledDraft.startsWith("!");
        const renderedDraft = isBang
          ? `\x1b[1m\x1b[33m!\x1b[0m${styledDraft.slice(1)}`
          : styledDraft;

        composerLines.push(`> ${renderedDraft}${ghostSuffix}`);
        const promptRow = suggestionLines.length > 0 ? 2 + suggestionLines.length : 1;
        cursorPosition = {
          row: promptRow,
          col: 3 + getVisibleWidth(visibleBefore),
        };
      } else {
        const hint =
          this.interactionMode === "empty-session"
            ? "> 输入指令..."
            : isReady
              ? "> 输入下一条指令..."
              : this.activeViewAgentId === "main"
                ? "> 给 Main 输入新的指令..."
                : `> 给 ${activeViewName} 输入指令...`;
        composerLines.push(`\x1b[90m${hint}\x1b[0m`);
        cursorPosition = {
          row: 1,
          col: 3,
        };
      }
      composerLines.push(ruleLine);
    }

    // A single visible feedback row keeps steering, queueing and background
    // progress observable without displacing the decision or composer.
    const now = Date.now();
    const feedback = this.planFeedback && this.planFeedback.expiresAt > now
      ? this.planFeedback.text
      : this.steerFeedback && this.steerFeedback.expiresAt > now
        ? this.steerFeedback.text
        : this.activeToasts.filter((toast) => toast.createdAt + 4000 > now).at(-1)?.text;
    const statusParts = [feedback];
    if (this.followupCount > 0) statusParts.push(`${this.followupCount} queued`);
    if (this.visibleBackgroundJobs.size > 0) {
      const active = this.visibleBackgroundJobs.values().next().value as JobRecord;
      statusParts.push(this.visibleBackgroundJobs.size === 1
        ? `background · ${active.command}`
        : `${this.visibleBackgroundJobs.size} background commands`);
    }

    // 纯净底栏状态行 (Permissions & Shortcuts)
    const hintParts: string[] = [];
    const hasMultipleAgents = navigableAgents.length > 1;
    const isAgentDetail = this.activeViewAgentId !== "main";

    if (isAgentDetail) {
      hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90m↑↓ select agent · enter view · esc Main · /help commands\x1b[0m`);
    } else if (isReady) {
      if (this.composerDraft.startsWith("!")) {
        hintParts.push(`\x1b[33m▶▶\x1b[0m \x1b[90mpermissions: local-shell · enter to run ! command · output lands directly in conversation\x1b[0m`);
      } else if (this.composerDraft.startsWith("/")) {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mTab to autocomplete · Enter to run · /help commands\x1b[0m`);
      } else if (hasMultipleAgents) {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mpermissions: workspace-write · ↑↓ select agent · enter to send · /help commands\x1b[0m`);
      } else {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mpermissions: workspace-write · enter to send · /help commands\x1b[0m`);
      }
    } else {
      if (this.composerDraft.startsWith("!")) {
        hintParts.push(`\x1b[33m▶▶\x1b[0m \x1b[90m! shell commands cannot run while agent is working · esc to interrupt\x1b[0m`);
      } else if (this.composerDraft.startsWith("/")) {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mTab to autocomplete · Enter to run · /help commands\x1b[0m`);
      } else if (hasMultipleAgents) {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mpermissions: workspace-write (shift+tab to cycle) · tab steer · esc interrupt · ↑↓ select agent\x1b[0m`);
      } else {
        hintParts.push(`\x1b[31m▶▶\x1b[0m \x1b[90mpermissions: workspace-write (shift+tab to cycle) · tab steer · esc interrupt\x1b[0m`);
      }
    }
    const activeStatus = statusParts.filter(Boolean);
    const feedbackText = activeStatus.length > 0
      ? `\x1b[36m${activeStatus.join(" · ")}\x1b[0m · ${hintParts.join(" · ")}`
      : hintParts.join(" · ");
    const feedbackLines = [truncateToDisplayWidth(feedbackText, maxDisplayWidth)];

    // Reserve room for the transcript on short terminals. Approval choices take
    // precedence over plan details; the selected choice must remain visible.
    const minimumTranscriptHeight = Math.min(4, Math.max(1, rows - 3));
    const chromeBudget = Math.max(1, rows - 1 - minimumTranscriptHeight);
    while (agentLines.length + composerLines.length + feedbackLines.length + planLines.length + pendingSteerLines.length > chromeBudget && planLines.length > 0) {
      planLines.pop();
    }
    while (agentLines.length + composerLines.length + feedbackLines.length + pendingSteerLines.length > chromeBudget && agentLines.length > 2) {
      agentLines.pop();
    }
    while (agentLines.length + composerLines.length + feedbackLines.length + pendingSteerLines.length > chromeBudget && composerLines.length > 1) {
      const selected = activeDecision?.selectedIndex ?? 0;
      const removeAt = selected === 0 ? composerLines.length - 1 : 0;
      composerLines.splice(removeAt, 1);
    }
    const agentsHeight = agentLines.length;
    const composerHeight = composerLines.length;
    const planHeight = planLines.length;
    const pendingSteerHeight = pendingSteerLines.length;

    // =========================================================================
    // 5. Transcript Viewport (自适应占据 Header 与 LiveStatus/Composer 之间的剩余空间)
    // =========================================================================
    const headerHeight = 1;
    const liveStatusHeight = liveStatusLines.length;
    const availableTranscriptHeight = Math.max(
      1,
      rows - headerHeight - liveStatusHeight - feedbackLines.length - planHeight - pendingSteerHeight - composerHeight - agentsHeight
    );

    const activeProj = this.getProjection(this.activeViewAgentId);
    let transcriptViewportLines = activeProj.renderViewport({
      width: maxDisplayWidth,
      height: availableTranscriptHeight,
      scrollOffset: activeProj.getScrollOffset(),
    });
    this.transcriptViewport = {
      top: 2,
      height: availableTranscriptHeight,
      width: maxDisplayWidth,
      start: activeProj.getViewportStartIndex(maxDisplayWidth, availableTranscriptHeight),
      agentId: this.activeViewAgentId,
    };
    while (transcriptViewportLines.length < availableTranscriptHeight) {
      transcriptViewportLines.push("");
    }

    // =========================================================================
    // 6. 逐行装配全屏 Frame 并通过 TerminalRenderer 绝对坐标绘制 (硬边界防护)
    // =========================================================================
    const fullScreenLines: string[] = [
      headerLine,
      ...transcriptViewportLines,
      ...liveStatusLines,
      ...planLines,
      ...pendingSteerLines,
      ...composerLines,
      ...agentLines,
      ...feedbackLines,
    ].map((line) => truncateToDisplayWidth(line, Math.max(1, columns - 2)));
    this.lastFrameLines = fullScreenLines.slice();
    if (this.transcriptSelection && !this.nativeScrollback) {
      fullScreenLines[0] = highlightSelectedLine(fullScreenLines[0] ?? "", 0, this.transcriptSelection);
      for (let i = 0; i < availableTranscriptHeight; i++) {
        const row = i + 1;
        fullScreenLines[row] = highlightSelectedLine(fullScreenLines[row] ?? "", this.transcriptViewport.start + i + 1, this.transcriptSelection, maxDisplayWidth);
      }
    } else if (this.screenSelection && !this.nativeScrollback) {
      for (let i = 0; i < fullScreenLines.length; i++) {
        fullScreenLines[i] = highlightSelectedLine(fullScreenLines[i] ?? "", i, this.screenSelection, maxDisplayWidth);
      }
    }

    const promptRowInComposer = cursorPosition ? cursorPosition.row : 1;

    if (cursorPosition) {
      cursorPosition.row =
        headerHeight +
        transcriptViewportLines.length +
        liveStatusLines.length +
        planHeight +
        pendingSteerHeight +
        promptRowInComposer +
        1;
    }

    if (this.nativeScrollback) {
      const footerLines = [
        ...liveStatusLines,
        ...planLines,
        ...pendingSteerLines,
        ...composerLines,
        ...agentLines,
        ...feedbackLines,
      ].map((line) => truncateToDisplayWidth(line, Math.max(1, columns - 2)));

      const composerRowInFooter = cursorPosition
        ? liveStatusHeight + planHeight + pendingSteerHeight + promptRowInComposer
        : undefined;

      this.renderNativeScrollback(
        activeProj.getDisplayLines(maxDisplayWidth),
        footerLines,
        composerRowInFooter,
        cursorPosition?.col,
        columns,
        rows
      );
      return;
    }

    this.terminalRenderer.renderFullScreen(fullScreenLines, cursorPosition);
  }

  addUserMessageToTranscript(
    text: string,
    agentId = "main",
    mode: "normal" | "steer" | "queue" = "normal"
  ): void {
    const proj = this.getProjection(agentId);
    proj.addUserMessage(text, Date.now(), mode);
    if (this.isTTY) {
      this.requestRender({ immediate: true });
    }
  }

  appendTranscript(entry: TranscriptEntry): void {
    const proj = this.getProjection(entry.agentId);
    if (entry.kind === "thought") {
      proj.addThought(entry.timestamp);
    } else if (entry.kind === "message") {
      proj.addUserMessage(entry.text, entry.timestamp);
    } else {
      proj.addSystemNotice(entry.text, entry.timestamp);
    }

    if (this.isTTY) {
      this.requestRender();
    }
  }

  /**
   * 将当前活跃 Agent 的最新一条 Assistant 回复内容复制至系统剪贴板 (/copy 命令支持)
   */
  copyLatestResponseToClipboard(): boolean {
    const proj = this.getProjection(this.activeViewAgentId);
    const text = proj.getLatestModelResponseText();
    if (!text) {
      this.pushToast("ℹ No assistant response to copy");
      if (this.isTTY) this.requestRender({ immediate: true });
      return false;
    }
    const success = SystemClipboard.writeText(text);
    if (success) {
      this.pushToast("✓ Copied latest assistant response to clipboard");
    } else {
      this.pushToast("✖ Failed to copy to clipboard");
    }
    if (this.isTTY) this.requestRender({ immediate: true });
    return success;
  }
}
