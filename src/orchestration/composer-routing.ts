import type { InteractionMode } from "../cli/types.js";

export type ComposerDestination = "start-run" | "plan-revision" | "steer" | "queue" | "unsupported-child-queue";

/** Resolve delivery from run state, not from the transcript currently on screen. */
export function resolveComposerDestination(input: {
  interactionMode: InteractionMode;
  isRunActive: boolean;
  viewedAgentId: string;
  requestedMode: "steer" | "queue" | "start-run";
}): ComposerDestination {
  if (input.interactionMode === "plan-revision") return "plan-revision";
  if (!input.isRunActive) return "start-run";
  if (input.requestedMode === "queue") {
    return input.viewedAgentId === "main" ? "queue" : "unsupported-child-queue";
  }
  return "steer";
}
