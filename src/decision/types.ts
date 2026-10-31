export type DecisionKind =
  | "plan-approval"
  | "permission"
  | "confirmation"
  | "retry-abort"
  | "custom";

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  destructive?: boolean;
  shortcut?: string;
}

export interface StructuredDecision<TResult = any> {
  id: string;
  kind: DecisionKind;
  title: string;
  description?: string;
  options: DecisionOption[];
  selectedIndex: number;
  metadata?: Record<string, unknown>;
  resolve: (optionId: string, result?: TResult) => void;
  reject: (err: Error) => void;
  onCancel?: () => void;
  createdAt: number;
}

export interface CreateDecisionInput<TResult = any> {
  id?: string;
  kind: DecisionKind;
  title: string;
  description?: string;
  options: DecisionOption[];
  defaultIndex?: number;
  metadata?: Record<string, unknown>;
  onCancel?: () => void;
}
