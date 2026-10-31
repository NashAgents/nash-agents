import type {
  ApprovalDecision,
  ApprovalProvider,
  ApprovalRequest,
} from "./types.js";
import type { InputManager } from "../cli/input-manager.js";
import { TerminalUI } from "../cli/terminal-ui.js";
import type { DecisionController } from "../decision/decision-controller.js";

export interface CliApprovalProviderOptions {
  inputManager: InputManager;
  terminalUI?: TerminalUI;
  decisionController?: DecisionController;
}

/**
 * 基于统一 InputManager、DecisionController 与 TerminalUI 的 CLI 审批提供者实现。
 * 遵循单一输入消费者原则，不直接读取 stdin，不创建独立的 readline。
 */
export class CliApprovalProvider implements ApprovalProvider {
  private readonly inputManager: InputManager;
  private readonly terminalUI: TerminalUI;
  private readonly decisionController?: DecisionController;

  constructor(options: CliApprovalProviderOptions) {
    this.inputManager = options.inputManager;
    this.terminalUI = options.terminalUI ?? new TerminalUI();
    this.decisionController = options.decisionController;
  }

  cancelApproval(requestId: string): void {
    if (this.decisionController) this.decisionController.cancelDecision(requestId);
    else this.inputManager.cancelApproval();
  }

  async askApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    // 优先使用结构化决策控制器 (DecisionController)
    if (this.decisionController) {
      try {
        const agentName = request.agentName ?? request.agentId ?? "Agent";
        const targetStr = request.target ? `\nTarget: ${request.target}` : "";
        const reasonStr = request.reason ? `\nReason: ${request.reason}` : "";

        const selectedOptionId = await this.decisionController.requestDecision({
          id: request.id,
          kind: "permission",
          title: `Permission required · ${request.capability}`,
          description: `[${agentName}] requests permission to execute ${request.capability}${targetStr}${reasonStr}`,
          options: [
            { id: "allow-once", label: "Allow once", shortcut: "y" },
            { id: "deny", label: "Deny", destructive: true, shortcut: "n" },
          ],
          defaultIndex: 0,
          metadata: { request },
        });

        return selectedOptionId === "allow-once" ? "allow-once" : "deny";
      } catch {
        return "deny";
      }
    }

    // 若当前终端处于 navigation 运行模式且未注入 decisionController，由 CliPresenter 底栏交互呈现并由 ApprovalService.resolveActive 响应
    if (this.inputManager.getInteractionMode() === "navigation") {
      return new Promise<ApprovalDecision>(() => {
        // 保持挂起
      });
    }

    try {
      const promptText = this.terminalUI.formatApprovalPrompt(request);
      const allowed = await this.inputManager.askYesNo(promptText, {
        defaultValue: false,
      });

      return allowed ? "allow-once" : "deny";
    } catch {
      // 若审批交互过程中发生异常，严格遵循 Fail-Closed，默认拒绝
      return "deny";
    }
  }
}
