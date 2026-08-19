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
  /** Hint for how to colorize the body — diffs get red/green lines etc. */
  kind?: "diff" | "preview" | "command" | "url";
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

export interface PlanTask {
  id: number;
  text: string;
  done: boolean;
}

export interface PlanState {
  title: string;
  tasks: PlanTask[];
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
  /** API-reported `prompt_tokens` from the most recent response. 0 until
   *  the first response. StatusBar uses this as the authoritative ctx value
   *  and falls back to `contextTokens` when it is unavailable. */
  lastPromptTokens: number;
  contextTokens: number;
  toolCalls: number;
  sessionSeconds: number;
  /** Pending prompts the user typed while a turn was running. Mirrored from
   *  tui.tsx's local promptQueue so the QueuedPrompts component can render
   *  them without holding its own state. queueDepth derives from this. */
  queue: string[];
  queueDepth: number;
  busy: boolean;
  /** Active /plan session. null when no plan is in progress. */
  plan: PlanState | null;
  /** Title stashed while waiting for the agent to produce a plan. */
  planRequestTitle: string | null;
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
  lastPromptTokens: 0,
  contextTokens: 0,
  toolCalls: 0,
  sessionSeconds: 0,
  queue: [],
  queueDepth: 0,
  busy: false,
  plan: null,
  planRequestTitle: null,
};

type Listener = { fn: () => void; keys?: string[] };
const listeners = new Set<Listener>();

export function getState(): StoreState {
  return state;
}

export function setState(updater: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)): void {
  const patch = typeof updater === "function" ? updater(state) : updater;
  state = { ...state, ...patch };
  // A function updater can read and mutate arbitrary state, so we can't
  // know which keys it touched — notify every listener. An object patch,
  // however, tells us exactly which keys changed; keyed listeners only fire
  // when at least one of their keys was touched. Unkeyed listeners keep the
  // old "fire on every setState" contract for imperative callers.
  const changed = typeof updater === "function" ? null : new Set(Object.keys(updater));
  for (const l of listeners) {
    if (!l.keys || !changed || l.keys.some((k) => changed.has(k))) l.fn();
  }
}

export function subscribe(l: () => void, keys?: string[]): () => void {
  const entry: Listener = { fn: l, keys };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
}
