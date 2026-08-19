import { randomUUID } from "node:crypto";
import {
  chatStream,
  computeCostUsd,
  modelSpec,
  recordUsage,
  type Message,
  type Model,
  type Stats,
  type ToolCall,
} from "./api.js";
import { READ_ONLY_TOOLS, TOOL_SCHEMAS, executeTool, type ToolContext } from "./tools.js";
import { Spinner } from "./ui.js";
import { buildSystemPrompt } from "./prompt.js";
import { loadInstructions } from "./instructions.js";
import { ReminderDetector } from "./reminders.js";

/**
 * Structured events emitted by runAgent. When events is provided on RunOptions,
 * the agent skips its terminal-friendly stdout writes (assistant label, dim
 * reasoning header, "→ name(args)" tool lines, notices) and emits these
 * events instead — so a non-stdout UI like the ink TUI can render them.
 *
 * The REPL leaves events undefined and gets the existing stdout behavior.
 */
export interface AgentEvents {
  /** Called once per assistant turn before any streaming begins. */
  onAssistantStart: (turnId: string) => void;
  /** Streamed assistant content chunk. */
  onAssistantContent: (turnId: string, chunk: string) => void;
  /** Streamed assistant reasoning chunk. Caller may ignore if reasoning hidden. */
  onAssistantReasoning: (turnId: string, chunk: string) => void;
  /** Called once when the assistant message is finalized (content + reasoning + tool_calls). */
  onAssistantFinal: (
    turnId: string,
    msg: { content: string; reasoning?: string; tool_calls?: ToolCall[] },
  ) => void;
  /** A tool call has started executing. */
  onToolStart: (callId: string, name: string, args: string) => void;
  /** A tool call has finished (or was rejected/interrupted). */
  onToolEnd: (callId: string, name: string, content: string, rejected: boolean) => void;
  /** System notice (auto-continue, budget exhausted). */
  onNotice: (text: string) => void;
}

// How many tool calls we let the agent chain in one user turn before we stop
// it. Set high enough that real coding tasks (read several files, search, run
// tests, write a patch, run tests again, commit) can finish in one turn; low
// enough to catch runaway loops where the model fails to converge.
export const MAX_TOOL_DEPTH = 24;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function streamHandlers(
  spinner: Spinner,
  showReasoning: boolean,
  assistantLabel: string,
  events: AgentEvents | undefined,
  turnId: string,
) {
  // Event-based path: emit structured events; do not touch stdout.
  if (events) {
    let started = false;
    return {
      onContent: (text: string) => {
        spinner.bump();
        if (!started) {
          events.onAssistantStart(turnId);
          started = true;
        }
        events.onAssistantContent(turnId, text);
      },
      onReasoning: (text: string) => {
        spinner.bump();
        if (!showReasoning) return;
        if (!started) {
          events.onAssistantStart(turnId);
          started = true;
        }
        events.onAssistantReasoning(turnId, text);
      },
      flush: () => {
        // Finalization is signaled by onAssistantFinal from runAgent — there's
        // no "flush at end of stream" event needed for the events path.
      },
    };
  }

  // Stdout path: used by `dsc "prompt"` one-shot mode. The interactive
  // TUI always passes `events`, so this branch never runs there. Output
  // is plain text — no ANSI markdown styling — because one-shot output
  // typically gets piped to other tools where escape codes are noise.
  let contentStarted = false;
  let reasoningStarted = false;

  return {
    onContent: (text: string) => {
      spinner.bump();
      if (!contentStarted) {
        spinner.stop();
        if (reasoningStarted) {
          // Close the reasoning block (reset styling, blank line) before the answer.
          process.stdout.write(`${RESET}\n\n`);
        }
        process.stdout.write(`${BOLD}${assistantLabel}${RESET} `);
        contentStarted = true;
      }
      process.stdout.write(text);
    },
    onReasoning: (text: string) => {
      spinner.bump();
      if (!showReasoning) return; // hidden — keep the spinner alive though
      if (contentStarted) return; // ignore stray reasoning after content has started
      if (!reasoningStarted) {
        spinner.stop();
        process.stdout.write(`${DIM}reasoning${RESET}\n${DIM}${ITALIC}  `);
        reasoningStarted = true;
      }
      // Indent every newline within the chunk so multi-line reasoning aligns.
      process.stdout.write(text.replace(/\n/g, "\n  "));
    },
    flush: () => {
      if (contentStarted) {
        process.stdout.write("\n");
      } else if (reasoningStarted) {
        process.stdout.write(`${RESET}\n`);
      }
    },
  };
}

export interface RunOptions {
  model: Model;
  stats: Stats;
  toolCtx: ToolContext;
  messages: Message[]; // mutated in place; pass full conversation
  signal?: AbortSignal;
  onTurn?: () => void; // called after each API response so the caller can refresh the status bar
  showReasoning?: boolean; // default true
  /** Returns the current /compact summary (folded into the system prompt).
   *  Refreshed per call so re-running /compact takes effect immediately. */
  getSummary?: () => string | undefined;
  /** Prefix shown before streamed assistant content. Defaults to "assistant:". */
  assistantLabel?: string;
  /** How many times to auto-grant another MAX_TOOL_DEPTH budget when the
   *  agent hits the cap without converging. 0 (default) = stop and ask the
   *  user to type "continue" manually, preserving today's safety. */
  maxAutoContinue?: number;
  /** Force replies in a specific language. Free-form (e.g. "en", "Romanian"). */
  language?: string;
  /** When provided, agent emits structured events instead of writing to stdout. */
  events?: AgentEvents;
  /** Additional tool schemas to advertise to the model. Used by MCP — each
   *  entry's name starts with `mcp_<server>_` so the dispatcher can route. */
  extraTools?: import("./api.js").ToolSchema[];
  /** When provided, replaces the default built-in TOOL_SCHEMAS. Read-only
   *  modes and subagents use this to remove write/bash tools from the schema
   *  rather than relying only on runtime permission prompts. */
  toolSchemas?: import("./api.js").ToolSchema[];
  /** Optional dispatcher for tools whose name starts with `mcp_`. Called
   *  in lieu of the built-in `executeTool` switch. */
  dispatchExtraTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ content: string; rejected?: boolean }>;
  /** Override the chat transport. Defaults to the real DeepSeek `chatStream`.
   *  Same injection style as `dispatchExtraTool`/`extraTools`: lets a test
   *  drive the loop with scripted responses (no network), and lets an
   *  embedder swap the transport without touching the loop. */
  chatStream?: typeof chatStream;
}

/** Effective tool-output budget. Tune with DSC_TOOL_OUTPUT_MAX_CHARS for
 *  experiments; defaults to 8 000 chars (~2k tokens). */
export function toolOutputMaxChars(): number {
  const raw = process.env.DSC_TOOL_OUTPUT_MAX_CHARS;
  if (!raw) return 8_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8_000;
}

/** Compress long tool outputs to keep the context window from ballooning.
 *  Keeps the first 60% and last 30% of the output; the middle is replaced
 *  with a one-line summary.  Outputs under the budget pass through untouched. */
export function compressToolOutput(text: string, maxChars = toolOutputMaxChars()): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = Math.floor(maxChars * 0.3);
  const skipped = text.length - head - tail;
  return (
    text.slice(0, head) +
    `\n…(truncated ${skipped.toLocaleString()} chars — /compact or re-run with tighter scope to see more)\n` +
    text.slice(text.length - tail)
  );
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const { messages, model, stats, toolCtx, signal, onTurn, events } = opts;
  const showReasoning = opts.showReasoning ?? true;
  const assistantLabel = opts.assistantLabel ?? "assistant:";
  const callChat = opts.chatStream ?? chatStream;

  // Build the message list to send: drop any leading system entry the caller
  // may have stashed (e.g. from an older session) and prepend a freshly-built
  // one so cwd/date/summary/language reflect the current turn. The system
  // prompt is intentionally byte-stable within a session so DeepSeek's
  // prefix cache extends through it and into the message history.
  const conversationMessages = (): Message[] =>
    messages[0]?.role === "system" ? messages.slice(1) : messages.slice();
  const reminders = new ReminderDetector();
  const buildApi = (): Message[] => {
    const base = buildSystemPrompt({
      cwd: toolCtx.cwd,
      date: new Date(),
      summary: opts.getSummary?.(),
      language: opts.language,
      // Re-read on every turn so edits to AGENTS.md / instructions.md
      // take effect immediately without restarting dsc. Synchronous IO
      // on small files in the local cwd is well under a millisecond —
      // negligible against a streaming API call.
      instructions: loadInstructions(toolCtx.cwd),
    });
    const reminder = reminders.getReminder();
    return [
      {
        role: "system",
        content: reminder ? `${base}\n\nDecision-time reminder:\n${reminder}` : base,
      },
      ...repairToolCallPairing(conversationMessages()),
    ];
  };

  const maxAutoContinue = Math.max(0, Math.floor(opts.maxAutoContinue ?? 0));
  let autoContinues = 0;

  // Outer loop hands the agent another MAX_TOOL_DEPTH budget if it ran out
  // without converging and auto-continue is enabled. The inner for-loop is
  // the actual tool-call agent loop; it `return`s when the model produces
  // an assistant turn with no tool_calls (the normal "I'm done" exit).
  budgetLoop: while (true) {
    for (let depth = 0; depth < MAX_TOOL_DEPTH; depth++) {
      stats.prompts += 1;
    const spinner = new Spinner("thinking");
    // In events mode, the TUI shows its own busy indicator; avoid the
    // terminal-control codes the spinner emits.
    if (!events) spinner.start();
    const turnId = randomUUID();
    const handlers = streamHandlers(spinner, showReasoning, assistantLabel, events, turnId);
    let resp;
    try {
      resp = await callChat({
        model,
        messages: buildApi(),
        // Built-in tools first, MCP-provided tools appended. Order
        // doesn't affect dispatch (we route on the mcp_ prefix), but
        // keeping built-ins first is a stable, predictable shape in
        // the prompt for the model.
        tools: (opts.toolSchemas ?? TOOL_SCHEMAS).concat(opts.extraTools ?? []),
        signal,
        onContent: handlers.onContent,
        onReasoning: handlers.onReasoning,
      });
    } finally {
      spinner.stop();
    }
    handlers.flush();
    recordUsage(stats, resp.usage);

    const choice = resp.choices[0];
    const msg = choice.message;
    const content = msg.content ?? "";

    const assistantMsg: Message = { role: "assistant", content };
    if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
    if (msg.tool_calls && msg.tool_calls.length) assistantMsg.tool_calls = msg.tool_calls;
    messages.push(assistantMsg);
    events?.onAssistantFinal(turnId, {
      content,
      reasoning: msg.reasoning_content,
      tool_calls: msg.tool_calls,
    });
    onTurn?.(); // status reflects the just-pushed assistant message

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return;
    }

    const toolCalls = msg.tool_calls;

    // Partition into read-only (parallel) and read-write (sequential).
    // The model cannot chain calls within a single turn (it has no results
    // yet), so all read-only calls are safe to run concurrently.
    type Pending = {
      index: number;
      call: (typeof toolCalls)[0];
      name: string;
      fn: () => Promise<{ content: string; rejected?: boolean }>;
    };
    const ro: Pending[] = [];
    const rw: Pending[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const name = call.function.name;
      const argsRaw = call.function.arguments ?? "{}";
      if (events) {
        events.onToolStart(call.id, name, argsRaw);
      } else {
        process.stdout.write(`${DIM}→ ${name}(${truncate(argsRaw, 200)})${RESET}\n`);
      }
      stats.tool_calls_total += 1;
      stats.tool_calls_by_name[name] = (stats.tool_calls_by_name[name] ?? 0) + 1;

      const interactive = !READ_ONLY_TOOLS.has(name) && !toolCtx.yolo;

      const execute = async (): Promise<{ content: string; rejected?: boolean }> => {
        const toolSpinner = new Spinner(`running ${name}`);
        if (!interactive && !events) toolSpinner.start();
        try {
          if (opts.dispatchExtraTool && name.startsWith("mcp_")) {
            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(argsRaw); } catch { /* use empty */ }
            const raw = await opts.dispatchExtraTool(name, parsedArgs);
            return { ...raw, content: compressToolOutput(raw.content) };
          }
          const raw = await executeTool(name, argsRaw, toolCtx, signal);
          return { ...raw, content: compressToolOutput(raw.content) };
        } catch (e) {
          const isAbort =
            e instanceof Error &&
            (e.name === "AbortError" || (e as { code?: string }).code === "ABORT_ERR");
          const result = {
            content: isAbort ? "interrupted" : `error: ${(e as Error).message ?? "tool failed"}`,
            rejected: isAbort,
          };
          // Save the original error — it's re-thrown after we record the stub
          // result so the caller sees the first failure.
          (result as { _throwAfter?: unknown })._throwAfter = e;
          return result;
        } finally {
          toolSpinner.stop();
        }
      };

      (interactive ? rw : ro).push({ index: i, call, name, fn: execute });
    }

    // Execute read-only tools in parallel, then read-write sequentially.
    // `run` wraps each call so the reminder detector can see what happened
    // (and how long it took) before the next model decision.
    const results = new Array<{ content: string; rejected?: boolean; _throwAfter?: unknown }>(toolCalls.length);
    const run = async (p: Pending) => {
      const started = Date.now();
      const r = await p.fn();
      reminders.onToolEnd(p.name, r.content, !!r.rejected, Date.now() - started);
      return r;
    };
    const roResults = await Promise.all(ro.map((p) => run(p).then((r) => [p.index, r] as const)));
    for (const [idx, r] of roResults) results[idx] = r;

    let firstError: unknown = null;
    for (const p of rw) {
      results[p.index] = await run(p);
    }

    // Record results in the original tool_call order and check for errors.
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i];
      const name = call.function.name;
      const result = results[i];
      const throwAfter = result?._throwAfter;
      delete result?._throwAfter;
      if (throwAfter && !firstError) firstError = throwAfter;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result?.content ?? "error: no result",
      });
      onTurn?.(); // status reflects the tool result we just recorded
      if (events) {
        events.onToolEnd(call.id, name, result.content, !!result.rejected);
      } else {
        const lead = result.content.startsWith("error:") || result.rejected ? RED : DIM;
        process.stdout.write(`${lead}  ${truncate(result.content, 400)}${RESET}\n`);
      }

      if (throwAfter) {
        // Stub-fill any remaining tool_calls before propagating, otherwise
        // the persisted history will still 400 on the next turn.
        for (let j = i + 1; j < toolCalls.length; j++) {
          messages.push({
            role: "tool",
            tool_call_id: toolCalls[j].id,
            content: "skipped: previous tool was interrupted",
          });
        }
        throw throwAfter;
      }
    }
    if (firstError) throw firstError;
    }
    // Inner for-loop exited because depth hit MAX_TOOL_DEPTH (the normal
    // "model done, no tool_calls" exit `return`s out of runAgent). Decide
    // whether to grant another budget or stop here.
    if (autoContinues < maxAutoContinue) {
      autoContinues++;
      const text = `── auto-continue ${autoContinues}/${maxAutoContinue} (${MAX_TOOL_DEPTH * autoContinues} tool calls so far; granting another ${MAX_TOOL_DEPTH})`;
      if (events) {
        events.onNotice(text);
      } else {
        process.stdout.write(`${DIM}${text}${RESET}\n`);
      }
      continue budgetLoop;
    }
    break budgetLoop;
  }

  // Either auto-continue was off or its budget is exhausted.
  const totalCalls = MAX_TOOL_DEPTH * (autoContinues + 1);
  const stopText =
    autoContinues > 0
      ? `(stopping after ${autoContinues} auto-continue(s) at ${totalCalls} total tool calls. Send 'continue' to give the agent another budget.)`
      : `(reached MAX_TOOL_DEPTH=${MAX_TOOL_DEPTH}; stopping. Send 'continue' to grant another budget, or set DSC_AUTO_CONTINUE=N / run /auto-continue N to do this automatically.)`;
  if (events) {
    events.onNotice(stopText);
  } else {
    process.stdout.write(`${DIM}${stopText}${RESET}\n`);
  }
  onTurn?.();
}

export function formatCost(stats: Stats, model: Model): string {
  const cost = computeCostUsd(stats, model);
  return `cost: $${cost.toFixed(4)}  in: ${stats.prompt_tokens} (hit ${stats.cache_hit_tokens} / miss ${stats.cache_miss_tokens})  out: ${stats.completion_tokens}  tools: ${stats.tool_calls_total}`;
}

export interface StatusOptions {
  yolo: boolean;
  reasoning?: boolean; // if false, append " no-reasoning"
  contextTokens?: number; // current message-list size, for context-budget feel
  sessionSeconds?: number; // wall-clock since REPL start
  compacted?: boolean; // /compact has been run on this session
  queued?: number; // type-ahead queue depth
}

export function formatStatus(stats: Stats, model: Model, opts: StatusOptions): string {
  const flags =
    (opts.yolo ? " yolo" : "") +
    (opts.reasoning === false ? " no-reasoning" : "") +
    (opts.compacted ? " compacted" : "");
  const ctx =
    opts.contextTokens !== undefined ? `  ctx:${formatCount(opts.contextTokens)}` : "";
  const queued =
    opts.queued && opts.queued > 0 ? `  queued:${opts.queued}` : "";
  const session =
    opts.sessionSeconds !== undefined ? `  ${formatDuration(opts.sessionSeconds)}` : "";
  return `${model}${flags}  in: ${stats.prompt_tokens} (hit ${stats.cache_hit_tokens} / miss ${stats.cache_miss_tokens})  out: ${stats.completion_tokens}  tools: ${stats.tool_calls_total}${ctx}${queued}${session}`;
}

/**
 * Resolve the auto-compact threshold in estimated tokens. A literal
 * DSC_AUTO_COMPACT_AT wins (set "0" / "off" / "false" to disable). Otherwise
 * the threshold is model-aware: 10% of the model's context window, clamped to
 * [32_000, 96_000]. This keeps DeepSeek's 1M window from compacting at a
 * trivially small fraction while avoiding Claude's smaller window drifting
 * into near-limit territory.
 */
export function autoCompactAtTokens(model: Model): number {
  const raw = process.env.DSC_AUTO_COMPACT_AT;
  if (raw === "0" || raw === "off" || raw === "false") return 0;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const contextWindow = modelSpec(model).contextWindow ?? 200_000;
  const byWindow = Math.floor(contextWindow * 0.1);
  return Math.min(96_000, Math.max(32_000, byWindow));
}

/** Resolve auto-compact keep count. Env override wins; default is 12 user turns. */
export function autoCompactKeepTurns(): number {
  const raw = process.env.DSC_AUTO_COMPACT_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

// Rough estimate based on stored message bodies; 1 token ≈ 4 chars.
export function estimateContextTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") total += Math.ceil(m.content.length / 4);
    if (typeof m.reasoning_content === "string") total += Math.ceil(m.reasoning_content.length / 4);
  }
  return total;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Synthesize stub tool messages for any assistant.tool_calls that don't have
 * a corresponding tool response further in the message list.
 *
 * Without this, a session that was previously interrupted after the assistant
 * called a tool (but before the tool message landed) will keep 400-ing on
 * every subsequent turn: the API enforces "an assistant message with
 * 'tool_calls' must be followed by tool messages responding to each
 * 'tool_call_id'". This recovers transparently per call.
 */
export function repairToolCallPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls || !m.tool_calls.length) continue;

    const seen = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      out.push(messages[j]);
      const id = messages[j].tool_call_id;
      if (id) seen.add(id);
      j++;
    }
    for (const tc of m.tool_calls) {
      if (!seen.has(tc.id)) {
        out.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "(no response — recovered from interrupted turn)",
        });
      }
    }
    i = j - 1; // skip the tool messages we already consumed
  }
  return out;
}
