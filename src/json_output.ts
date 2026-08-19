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
}

function parseToolArgs(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
}

export function buildOneShotEnvelope(input: OneShotEnvelopeInput): OneShotEnvelope {
  const env: OneShotEnvelope = {
    ok: input.ok,
  };

  if (input.error) env.error = input.error;
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
