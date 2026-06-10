export const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

export type ProviderId = "deepseek" | "anthropic" | "openai" | "ollama";

export interface ModelRates {
  /** USD per token. */
  in_hit: number;
  in_miss: number;
  out: number;
}

export interface ModelSpec {
  id: string;
  provider: ProviderId;
  rates: ModelRates;
  contextWindow?: number;
}

// Registry of every model dsc knows. The active model is the routing key: its
// `provider` selects the transport, the API key, and the cost table. Adding a
// provider is two steps — register its models here, and register the Provider
// in PROVIDERS below. v4-pro figures are discounted (valid through 2026-05-31).
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    provider: "deepseek",
    rates: { in_hit: 0.0034e-6, in_miss: 0.414e-6, out: 0.828e-6 },
    contextWindow: 1_000_000,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    provider: "deepseek",
    rates: { in_hit: 0.0028e-6, in_miss: 0.138e-6, out: 0.276e-6 },
    contextWindow: 1_000_000,
  },
};

// Model identity is a bare string (the provider is implied by the registry),
// so session JSON stays compatible and `/model <name>` works across providers.
export type Model = string;
export const DEFAULT_MODEL: Model = "deepseek-v4-pro";

/** Model ids dsc will offer. Phase 1 lists every registered model (all
 *  DeepSeek today); provider-key availability filtering arrives with the
 *  multi-provider config work. Order is registry insertion order. */
export const AVAILABLE_MODELS: Model[] = Object.keys(MODEL_REGISTRY);

/** Resolve a model id to its spec, falling back to the default for unknown
 *  ids (mirrors history.ts's load-time model guard). */
export function modelSpec(model: Model): ModelSpec {
  return MODEL_REGISTRY[model] ?? MODEL_REGISTRY[DEFAULT_MODEL];
}

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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import * as nodePath from "node:path";

/** Current config location: ~/.config/dsc/config.json (XDG-aware). */
export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : nodePath.join(homedir(), ".config");
  return nodePath.join(base, "dsc", "config.json");
}

/** Legacy location, kept for one-time migration. Pre-1.1.0 dsc wrote here. */
export function legacyConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : nodePath.join(homedir(), ".config");
  return nodePath.join(base, "deepseek", "deepseek.json");
}

let _cachedKey: string | undefined;
let _cachedConfig: Record<string, unknown> | null | undefined;
let _migratedFromLegacy: string | null = null;

/**
 * If the new config path is missing but the legacy path exists, copy the
 * legacy file forward to the new path. The legacy file is left in place
 * — paranoid about destroying user-curated config. Returns the legacy
 * path on a fresh migration, null otherwise.
 *
 * Idempotent. Safe to call multiple times; only the first migration
 * actually copies. Surfaces the result via `consumeConfigMigrationNotice()`
 * so the TUI can `info()` it once at boot.
 */
export function migrateLegacyConfigIfNeeded(): string | null {
  const newPath = configPath();
  // Already migrated or new file was created directly — nothing to do.
  try {
    readFileSync(newPath, "utf8");
    return null;
  } catch {
    // new doesn't exist; try legacy
  }
  const legacy = legacyConfigPath();
  let text: string;
  try {
    text = readFileSync(legacy, "utf8");
  } catch {
    return null; // no legacy either; fresh-install path
  }
  try {
    mkdirSync(nodePath.dirname(newPath), { recursive: true });
    writeFileSync(newPath, text, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Migration write failed (perms, disk full). Caller still reads from
    // the legacy path via getConfig's fallback; the user is unblocked.
    return null;
  }
  _migratedFromLegacy = legacy;
  return legacy;
}

/**
 * Consume the migration notice — returns the legacy path that was just
 * migrated from, or null. After this call the notice is cleared so a
 * second consumer doesn't double-print.
 */
export function consumeConfigMigrationNotice(): string | null {
  const v = _migratedFromLegacy;
  _migratedFromLegacy = null;
  return v;
}

/**
 * Reset all in-process config caches. Test-only — exported so test
 * suites can re-exercise the migration / read paths across multiple
 * scenarios without running each in a fresh subprocess.
 */
export function _resetConfigCachesForTests(): void {
  _cachedKey = undefined;
  _cachedConfig = undefined;
  _migratedFromLegacy = null;
}

// Returns the parsed config (cached). null when neither the new nor the
// legacy file exists; throws DeepSeekError on invalid JSON. Shared by
// getApiKey and the search/mcp modules so secrets + provider + MCP
// config can live in one place.
export function getConfig(): Record<string, unknown> | null {
  if (_cachedConfig !== undefined) return _cachedConfig;
  // One-time migration from the deepseek/deepseek.json legacy location.
  // No-op if already migrated or no legacy file exists.
  migrateLegacyConfigIfNeeded();
  const p = configPath();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    // Migration may have failed; fall back to reading the legacy file
    // directly so a perms-blocked migration doesn't take dsc down.
    try {
      text = readFileSync(legacyConfigPath(), "utf8");
    } catch {
      _cachedConfig = null;
      return null;
    }
  }
  // Strip UTF-8 BOM if present. PowerShell 5.1's `Set-Content -Encoding utf8`
  // writes one by default, which would otherwise break JSON.parse with a
  // confusing "Unexpected character" error on byte 0.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DeepSeekError(`config file is not valid JSON: ${p}`);
  }
  if (!data || typeof data !== "object") {
    _cachedConfig = null;
    return null;
  }
  _cachedConfig = data as Record<string, unknown>;
  return _cachedConfig;
}

function readKeyFromFile(): string | null {
  const obj = getConfig();
  if (!obj) return null;
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

/**
 * Returns "env" when the env var DEEPSEEK_API_KEY is set, "file" when the
 * config file has a key, or null when neither is set. Lets the UI explain
 * to the user where the key is coming from without leaking it.
 */
export function apiKeySource(): "env" | "file" | null {
  if (process.env.DEEPSEEK_API_KEY) return "env";
  try {
    return readKeyFromFile() !== null ? "file" : null;
  } catch {
    return null;
  }
}

/**
 * Merge `key` into the config file at `configPath()`, creating the file +
 * parent directory if needed. Preserves any other fields already in the
 * file (e.g. `search` provider settings). Writes with 0600 permissions so
 * other users on the box can't read the key.
 *
 * Invalidates the in-memory caches so the next getApiKey() picks up the
 * new value without a restart.
 */
export async function saveApiKey(key: string): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed) throw new DeepSeekError("api key is empty");
  const p = configPath();
  await fsp.mkdir(nodePath.dirname(p), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    let txt = await fsp.readFile(p, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable — start fresh; we'd rather overwrite a broken
    // file than silently fail the save
  }
  existing.api_key = trimmed;

  // mode on the write is honored on POSIX; Windows ignores it but inherits
  // the directory ACL. Best-effort chmod afterwards in case the file
  // already existed with looser perms.
  await fsp.writeFile(p, JSON.stringify(existing, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fsp.chmod(p, 0o600);
  } catch {
    // POSIX-only; ignore failures on Windows.
  }

  _cachedKey = undefined;
  _cachedConfig = undefined;
  return p;
}

/**
 * Set the active search provider in the config file. Writes
 * `search.provider` while preserving any other fields (per-provider
 * keys, etc). Use `null` / undefined to clear back to the default.
 */
export async function saveSearchProvider(
  provider: "brave" | "tavily" | "ddg",
): Promise<string> {
  const p = configPath();
  await fsp.mkdir(nodePath.dirname(p), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    let txt = await fsp.readFile(p, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable — start fresh
  }
  const search =
    existing.search && typeof existing.search === "object"
      ? (existing.search as Record<string, unknown>)
      : {};
  search.provider = provider;
  existing.search = search;

  await fsp.writeFile(p, JSON.stringify(existing, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fsp.chmod(p, 0o600);
  } catch {}

  _cachedConfig = undefined;
  return p;
}

/**
 * Save a search-provider key (brave/tavily) into the config file.
 * Merges into `search.<provider>.api_key`, preserving any other fields
 * already in `search` (e.g. `provider`, the *other* provider's key).
 * Returns the path written to.
 */
export async function saveSearchKey(
  provider: "brave" | "tavily",
  key: string,
): Promise<string> {
  const trimmed = key.trim();
  if (!trimmed) throw new DeepSeekError("api key is empty");
  const p = configPath();
  await fsp.mkdir(nodePath.dirname(p), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    let txt = await fsp.readFile(p, "utf8");
    if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
    const parsed = JSON.parse(txt);
    if (parsed && typeof parsed === "object") {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or unparseable — start fresh
  }
  const search =
    existing.search && typeof existing.search === "object"
      ? (existing.search as Record<string, unknown>)
      : {};
  const sub =
    search[provider] && typeof search[provider] === "object"
      ? (search[provider] as Record<string, unknown>)
      : {};
  sub.api_key = trimmed;
  search[provider] = sub;
  existing.search = search;

  await fsp.writeFile(p, JSON.stringify(existing, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await fsp.chmod(p, 0o600);
  } catch {}

  _cachedConfig = undefined;
  return p;
}

// ---------------------------------------------------------------------------
// Provider abstraction
//
// The agent loop speaks a normalized OpenAI-flavored shape (Message/ToolCall/
// ChatResponse). A Provider translates that to/from a vendor's wire format.
// DeepSeek, OpenAI, and Ollama are all OpenAI-compatible, so one factory
// (openAICompatProvider) covers them with just a different URL + key. Anthropic
// gets its own Provider (Messages API translation) in a later phase.
// ---------------------------------------------------------------------------

export interface Provider {
  id: ProviderId;
  /** Soft key lookup for availability checks; null when not configured. */
  resolveKey: () => string | null;
  chat: (opts: CallOptions, spec: ModelSpec) => Promise<ChatResponse>;
  /** One streaming attempt. Retry/backoff lives in the top-level chatStream. */
  chatStream: (opts: StreamOptions, spec: ModelSpec) => Promise<ChatResponse>;
}

interface OpenAICompatOptions {
  id: ProviderId;
  url: string;
  resolveKey: () => string | null;
  /** Throws a provider-specific, user-actionable error when no key is set. */
  requireKey: () => string;
}

function openAICompatProvider(o: OpenAICompatOptions): Provider {
  return {
    id: o.id,
    resolveKey: o.resolveKey,
    chat: (opts) => openAICompatChat(o.url, o.requireKey(), opts),
    chatStream: (opts) => openAICompatStreamOnce(o.url, o.requireKey(), opts),
  };
}

const deepseekProvider = openAICompatProvider({
  id: "deepseek",
  url: DEEPSEEK_API_URL,
  resolveKey: () => {
    try {
      return getApiKey();
    } catch {
      return null;
    }
  },
  // getApiKey throws the existing "set DEEPSEEK_API_KEY / config" guidance.
  requireKey: getApiKey,
});

const PROVIDERS: Partial<Record<ProviderId, Provider>> = {
  deepseek: deepseekProvider,
};

/** The Provider that serves a given model, via the registry. */
export function providerFor(model: Model): Provider {
  const spec = modelSpec(model);
  const p = PROVIDERS[spec.provider];
  if (!p) {
    throw new DeepSeekError(
      `No provider registered for '${spec.provider}' (model '${model}')`,
    );
  }
  return p;
}

export async function chat(opts: CallOptions): Promise<ChatResponse> {
  return providerFor(opts.model).chat(opts, modelSpec(opts.model));
}

async function openAICompatChat(
  url: string,
  apiKey: string,
  opts: CallOptions,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  const res = await fetch(url, {
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

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRY_ATTEMPTS = 3;

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR");
}

function isRetriableNetworkError(e: unknown): boolean {
  // fetch() throws TypeError for network errors in undici (Node 18+).
  if (!(e instanceof Error)) return false;
  if (e.name === "TypeError") return true;
  const code = (e as { cause?: { code?: string } }).cause?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "ENOTFOUND";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function chatStream(opts: StreamOptions): Promise<ChatResponse> {
  const provider = providerFor(opts.model);
  const spec = modelSpec(opts.model);
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.chatStream(opts, spec);
    } catch (e) {
      if (isAbortError(e)) throw e;
      const transient =
        (e instanceof DeepSeekError && e.status !== undefined && RETRY_STATUSES.has(e.status)) ||
        isRetriableNetworkError(e);
      if (!transient || attempt >= MAX_RETRY_ATTEMPTS) throw e;
      const delay = 1000 * Math.pow(2, attempt - 1);
      const reason =
        e instanceof DeepSeekError && e.status ? `HTTP ${e.status}` : (e as Error).message;
      process.stderr.write(
        `${DIM}(${reason}; retrying in ${Math.round(delay / 1000)}s, attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})${RESET}\n`,
      );
      await sleep(delay, opts.signal);
    }
  }
}

async function openAICompatStreamOnce(
  url: string,
  apiKey: string,
  opts: StreamOptions,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;

  const res = await fetch(url, {
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
  const rates = modelSpec(model).rates;
  const hit = stats.cache_hit_tokens;
  const miss = stats.cache_miss_tokens;
  const out = stats.completion_tokens;
  // Prompt tokens not categorized as hit/miss (older API responses) bill at miss rate.
  const unaccounted = Math.max(0, stats.prompt_tokens - hit - miss);
  return hit * rates.in_hit + miss * rates.in_miss + unaccounted * rates.in_miss + out * rates.out;
}
