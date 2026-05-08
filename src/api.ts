export const API_URL = "https://api.deepseek.com/chat/completions";

export const AVAILABLE_MODELS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export type Model = (typeof AVAILABLE_MODELS)[number];
export const DEFAULT_MODEL: Model = "deepseek-v4-pro";

// USD per token. v4-pro figures are discounted (valid through 2026-05-31), copied from godot-assistant.
export const MODEL_RATES: Record<Model, { in_hit: number; in_miss: number; out: number }> = {
  "deepseek-v4-pro":   { in_hit: 0.0034e-6, in_miss: 0.414e-6, out: 0.828e-6 },
  "deepseek-v4-flash": { in_hit: 0.0028e-6, in_miss: 0.138e-6, out: 0.276e-6 },
};

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: Usage;
}

export interface CallOptions {
  model: Model;
  messages: Message[];
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface StreamOptions extends CallOptions {
  onContent?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

export class DeepSeekError extends Error {
  constructor(message: string, public status?: number, public body?: string) {
    super(message);
    this.name = "DeepSeekError";
  }
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : nodePath.join(homedir(), ".config");
  return nodePath.join(base, "deepseek", "deepseek.json");
}

let _cachedKey: string | undefined;

function readKeyFromFile(): string | null {
  const p = configPath();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new DeepSeekError(`config file is not valid JSON: ${p}`);
  }
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  // Accept several shapes:
  //   {"api_key": "sk-..."}
  //   {"DEEPSEEK_API_KEY": "sk-..."}
  //   {"env": {"DEEPSEEK_API_KEY": "sk-..."}}     (dsc-style env block)
  //   {"env": {"ANTHROPIC_AUTH_TOKEN": "sk-..."}} (claude-switcher compatible)
  const env = (obj.env && typeof obj.env === "object" ? (obj.env as Record<string, unknown>) : {});
  const candidate =
    obj.api_key ??
    obj.DEEPSEEK_API_KEY ??
    env.DEEPSEEK_API_KEY ??
    env.ANTHROPIC_AUTH_TOKEN;
  if (typeof candidate === "string" && candidate.length) return candidate;
  return null;
}

export function getApiKey(): string {
  if (_cachedKey) return _cachedKey;
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) {
    _cachedKey = envKey;
    return envKey;
  }
  const fileKey = readKeyFromFile();
  if (fileKey) {
    _cachedKey = fileKey;
    return fileKey;
  }
  throw new DeepSeekError(
    `DEEPSEEK_API_KEY is not set and no key found in ${configPath()}.\n` +
      `  Either export DEEPSEEK_API_KEY, or create that file containing:\n` +
      `    {"api_key": "sk-..."}\n` +
      `  (also accepts {"env": {"ANTHROPIC_AUTH_TOKEN": "sk-..."}} for claude-switcher compat).`,
  );
}

export function hasApiKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    return readKeyFromFile() !== null;
  } catch {
    return false;
  }
}

export async function chat(opts: CallOptions): Promise<ChatResponse> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new DeepSeekError(`HTTP ${res.status}`, res.status, text);
  }
  let parsed: ChatResponse;
  try {
    parsed = JSON.parse(text) as ChatResponse;
  } catch {
    throw new DeepSeekError(`Invalid JSON response: ${text.slice(0, 200)}`);
  }
  if (!parsed.choices || parsed.choices.length === 0) {
    throw new DeepSeekError("Empty choices in response");
  }
  return parsed;
}

interface StreamToolCallAcc {
  id?: string;
  type?: "function";
  function: { name: string; arguments: string };
}

export async function chatStream(opts: StreamOptions): Promise<ChatResponse> {
  const apiKey = getApiKey();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new DeepSeekError(`HTTP ${res.status}`, res.status, text);
  }
  if (!res.body) {
    throw new DeepSeekError("No response body for stream");
  }

  let content = "";
  let reasoning = "";
  const toolCalls: StreamToolCallAcc[] = [];
  let finishReason: string | undefined;
  let usage: Usage | undefined;

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const rawLine = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!rawLine || rawLine.startsWith(":")) continue;
      if (!rawLine.startsWith("data:")) continue;
      const data = rawLine.slice(5).trim();
      if (data === "[DONE]") continue;
      let evt: any;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.usage) usage = evt.usage as Usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length) {
        content += delta.content;
        opts.onContent?.(delta.content);
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length) {
        reasoning += delta.reasoning_content;
        opts.onReasoning?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!toolCalls[idx]) toolCalls[idx] = { function: { name: "", arguments: "" } };
          const acc = toolCalls[idx];
          if (tc.id) acc.id = tc.id;
          if (tc.type) acc.type = tc.type;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const finalToolCalls: ToolCall[] = toolCalls
    .filter((t) => t && t.function?.name)
    .map((t, i) => ({
      id: t.id ?? `call_${i}`,
      type: "function",
      function: { name: t.function.name, arguments: t.function.arguments || "{}" },
    }));

  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: content || null,
          tool_calls: finalToolCalls.length ? finalToolCalls : undefined,
          reasoning_content: reasoning || undefined,
        },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
}

export interface Stats {
  prompts: number;
  responses: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  tool_calls_total: number;
  tool_calls_by_name: Record<string, number>;
  files_touched: Set<string>;
}

export function newStats(): Stats {
  return {
    prompts: 0,
    responses: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_hit_tokens: 0,
    cache_miss_tokens: 0,
    tool_calls_total: 0,
    tool_calls_by_name: {},
    files_touched: new Set(),
  };
}

export function recordUsage(stats: Stats, usage: Usage | undefined): void {
  stats.responses += 1;
  if (!usage) return;
  stats.prompt_tokens += usage.prompt_tokens ?? 0;
  stats.completion_tokens += usage.completion_tokens ?? 0;
  stats.total_tokens += usage.total_tokens ?? 0;
  stats.cache_hit_tokens += usage.prompt_cache_hit_tokens ?? 0;
  stats.cache_miss_tokens += usage.prompt_cache_miss_tokens ?? 0;
}

export function computeCostUsd(stats: Stats, model: Model): number {
  const rates = MODEL_RATES[model] ?? MODEL_RATES[DEFAULT_MODEL];
  const hit = stats.cache_hit_tokens;
  const miss = stats.cache_miss_tokens;
  const out = stats.completion_tokens;
  // Prompt tokens not categorized as hit/miss (older API responses) bill at miss rate.
  const unaccounted = Math.max(0, stats.prompt_tokens - hit - miss);
  return hit * rates.in_hit + miss * rates.in_miss + unaccounted * rates.in_miss + out * rates.out;
}
