// Minimal subscribable state for the TUI. Avoids pulling in a state-management
// library — components read via the useStore hook, and the agent (or any
// imperative caller) mutates via setState.

import type { Model, ToolCall } from "./api.js";

export interface UIMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface ApprovalRequest {
  title: string;
  body: string;
  question: string;
  resolve: (answer: string) => void;
}

export interface AgentTask {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  /** Present-continuous form, shown while in_progress. Falls back to subject. */
  activeForm?: string;
}

export interface StoreState {
  // Finalized turns. Pushed into <Static> so they live in scrollback.
  history: UIMessage[];
  // Currently-streaming assistant message (or tool result). Lives in the
  // dynamic frame; once complete, gets moved into history.
  current: UIMessage | null;
  // Short label of the tool that's running, e.g. "bash(npm install)".
  task: string | null;
  // Pending approval request — when non-null, the ApprovalDialog mounts.
  approval: ApprovalRequest | null;
  // Agent-managed task list (Claude Code style). Mutated by the task_*
  // tools; rendered by AgentTaskList above the prompt.
  agentTasks: AgentTask[];

  // Status-bar inputs.
  model: Model;
  yolo: boolean;
  reasoning: boolean;
  compacted: boolean;
  language?: string;
  assistantLabel: string;
  autoContinue: number;
  cost: number;
  inTokens: number;
  outTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  contextTokens: number;
  toolCalls: number;
  sessionSeconds: number;
  queueDepth: number;
  busy: boolean;
}

let state: StoreState = {
  history: [],
  current: null,
  task: null,
  approval: null,
  agentTasks: [],
  model: "deepseek-v4-pro",
  yolo: false,
  reasoning: true,
  compacted: false,
  assistantLabel: "assistant:",
  autoContinue: 0,
  cost: 0,
  inTokens: 0,
  outTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  contextTokens: 0,
  toolCalls: 0,
  sessionSeconds: 0,
  queueDepth: 0,
  busy: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function getState(): StoreState {
  return state;
}

export function setState(updater: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)): void {
  const patch = typeof updater === "function" ? updater(state) : updater;
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
