// The one-shot JSON envelope emitted by `dsc "prompt" --json`.
//
// It is deliberately a flat, stable, machine-readable shape: `ok`/`error`
// for control flow, `result` for the final assistant text, `tool_calls` for
// observability, and `usage`/`cost_usd`/`duration_ms` for accounting. The
// TUI and REPL paths are untouched; this is only for headless/scripted use.

import { computeCostUsd, type Model, type Stats } from "./api.js";

export interface OneShotToolCall {
  id: string;
  name: string;
  args: unknown;
  content: string;
  rejected: boolean;
}

export interface OneShotEnvelope {
  ok: boolean;
  error?: string;
  result?: string;
  tool_calls?: OneShotToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
  };
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  model?: string;
  /** Short actionable recovery hint when ok=false. */
  fix?: string;
  /** Concrete follow-ups the caller can take or prompt the agent with. */
  next_actions?: string[];
}

function parseToolArgs(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface ErrorClassification {
  fix?: string;
  next_actions?: string[];
}

/** Best-effort classification for the failures we can recover from without
 *  a human. Kept intentionally broad so unknown errors still get a generic
 *  "inspect and retry" hint rather than no hint at all. */
function classifyError(error: string): ErrorClassification {
  const e = error.toLowerCase();
  if (e.includes("api key") || e.includes("apikey") || e.includes("unauthorized") || e.includes("authentication")) {
    return {
      fix: "Configure an API key with /api-key or set DEEPSEEK_API_KEY.",
      next_actions: ["/api-key sk-...", "export DEEPSEEK_API_KEY=sk-..."],
    };
  }
  if (e.includes("old_string not found")) {
    return {
      fix: "Re-read the target file and retry edit_file with the current exact content.",
      next_actions: ["read_file the target path", "retry edit_file with corrected old_string"],
    };
  }
  if (e.includes("old_string is not unique")) {
    return {
      fix: "Add more surrounding context or pass replace_all=true if replacing every match is intended.",
      next_actions: ["read_file the target path", "retry edit_file with more context or replace_all=true"],
    };
  }
  if (e.includes("budget reached")) {
    return {
      fix: "Raise or clear the budget with /budget.",
      next_actions: ["/budget <amount>", "/budget off"],
    };
  }
  if (e.includes("timeout")) {
    return {
      fix: "Use bash_status with background=true for long-running commands, or raise timeout_ms.",
      next_actions: ["rerun with background=true and poll bash_status", "raise timeout_ms and retry"],
    };
  }
  if (e.includes("max_tool_depth") || e.includes("auto_continue")) {
    return {
      fix: "The agent did not converge. Split the work into smaller explicit steps and retry.",
      next_actions: ["retry with a narrower prompt", "ask the agent to do one step at a time"],
    };
  }
  return {
    fix: "Inspect the error and retry with adjusted arguments or a narrower prompt.",
  };
}

export interface OneShotEnvelopeInput {
  ok: boolean;
  error?: string;
  result?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: string;
    content: string;
    rejected: boolean;
  }>;
  stats?: Stats;
  model?: Model;
  durationMs?: number;
  sessionId?: string;
  fix?: string;
  nextActions?: string[];
}

export function buildOneShotEnvelope(input: OneShotEnvelopeInput): OneShotEnvelope {
  const env: OneShotEnvelope = {
    ok: input.ok,
  };

  if (input.error) env.error = input.error;
  const classification = input.error ? classifyError(input.error) : {};
  const fix = input.fix ?? classification.fix;
  if (fix) env.fix = fix;
  const nextActions = input.nextActions ?? classification.next_actions;
  if (nextActions && nextActions.length > 0) env.next_actions = nextActions;
  if (input.result !== undefined) env.result = input.result;
  if (input.toolCalls && input.toolCalls.length > 0) {
    env.tool_calls = input.toolCalls.map((t) => ({
      id: t.id,
      name: t.name,
      args: parseToolArgs(t.args),
      content: t.content,
      rejected: t.rejected,
    }));
  }
  if (input.stats) {
    env.usage = {
      prompt_tokens: input.stats.prompt_tokens,
      completion_tokens: input.stats.completion_tokens,
      total_tokens: input.stats.total_tokens,
      cache_hit_tokens: input.stats.cache_hit_tokens,
      cache_miss_tokens: input.stats.cache_miss_tokens,
    };
    if (input.model) {
      env.cost_usd = computeCostUsd(input.stats, input.model);
    }
  }
  if (input.durationMs !== undefined) env.duration_ms = input.durationMs;
  if (input.sessionId !== undefined) env.session_id = input.sessionId;
  if (input.model !== undefined) env.model = input.model;
  return env;
}
