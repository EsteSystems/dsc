import {
  chatStream,
  computeCostUsd,
  recordUsage,
  type Message,
  type Model,
  type Stats,
} from "./api.js";
import { READ_ONLY_TOOLS, TOOL_SCHEMAS, executeTool, type ToolContext } from "./tools.js";
import { Spinner } from "./ui.js";
import { MarkdownRenderer } from "./markdown.js";
import { buildSystemPrompt } from "./prompt.js";

export const MAX_TOOL_DEPTH = 8;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function streamHandlers(spinner: Spinner, showReasoning: boolean) {
  let contentStarted = false;
  let reasoningStarted = false;
  const renderer = new MarkdownRenderer();

  return {
    onContent: (text: string) => {
      spinner.bump();
      if (!contentStarted) {
        spinner.stop();
        if (reasoningStarted) {
          // Close the reasoning block (reset styling, blank line) before the answer.
          process.stdout.write(`${RESET}\n\n`);
        }
        process.stdout.write(`${BOLD}assistant${RESET}: `);
        contentStarted = true;
      }
      process.stdout.write(renderer.push(text));
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
        process.stdout.write(renderer.flush());
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
  /** Returns the line that gets embedded into the system prompt. Called fresh
   *  before every chatStream so the model sees the latest cost/ctx numbers. */
  getStatusLine?: () => string;
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const { messages, model, stats, toolCtx, signal, onTurn } = opts;
  const showReasoning = opts.showReasoning ?? true;

  // Build the message list to send: drop any leading system entry the caller
  // may have stashed (e.g. from an older session) and prepend a freshly-built
  // one so cwd/date/status reflect the current turn.
  const conversationMessages = (): Message[] =>
    messages[0]?.role === "system" ? messages.slice(1) : messages.slice();
  const buildApi = (): Message[] => [
    {
      role: "system",
      content: buildSystemPrompt({
        cwd: toolCtx.cwd,
        date: new Date(),
        statusLine: opts.getStatusLine?.(),
      }),
    },
    ...conversationMessages(),
  ];

  for (let depth = 0; depth < MAX_TOOL_DEPTH; depth++) {
    stats.prompts += 1;
    const spinner = new Spinner("thinking");
    spinner.start();
    const handlers = streamHandlers(spinner, showReasoning);
    let resp;
    try {
      resp = await chatStream({
        model,
        messages: buildApi(),
        tools: TOOL_SCHEMAS,
        signal,
        onContent: handlers.onContent,
        onReasoning: handlers.onReasoning,
      });
    } finally {
      spinner.stop();
    }
    handlers.flush();
    recordUsage(stats, resp.usage);
    onTurn?.();

    const choice = resp.choices[0];
    const msg = choice.message;
    const content = msg.content ?? "";

    const assistantMsg: Message = { role: "assistant", content };
    if (msg.reasoning_content) assistantMsg.reasoning_content = msg.reasoning_content;
    if (msg.tool_calls && msg.tool_calls.length) assistantMsg.tool_calls = msg.tool_calls;
    messages.push(assistantMsg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return;
    }

    for (const call of msg.tool_calls) {
      const name = call.function.name;
      const argsRaw = call.function.arguments ?? "{}";
      process.stdout.write(`${DIM}→ ${name}(${truncate(argsRaw, 200)})${RESET}\n`);
      stats.tool_calls_total += 1;
      stats.tool_calls_by_name[name] = (stats.tool_calls_by_name[name] ?? 0) + 1;
      onTurn?.();

      const toolSpinner = new Spinner(`running ${name}`);
      // Don't spin tools that need approval (interactive prompt).
      const interactive = !READ_ONLY_TOOLS.has(name) && !toolCtx.yolo;
      if (!interactive) toolSpinner.start();
      let result;
      try {
        result = await executeTool(name, argsRaw, toolCtx, signal);
      } finally {
        toolSpinner.stop();
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result.content,
      });
      const lead = result.content.startsWith("error:") || result.rejected ? RED : DIM;
      process.stdout.write(`${lead}  ${truncate(result.content, 400)}${RESET}\n`);
    }
  }

  // Out of tool-call budget — ask for a final summary without tools.
  process.stdout.write(`${DIM}(reached MAX_TOOL_DEPTH=${MAX_TOOL_DEPTH}; asking for final summary)${RESET}\n`);
  messages.push({
    role: "user",
    content:
      "You've used the maximum number of tool calls for this turn. Do not call more tools. Provide a concise final response describing what was done and what (if anything) remains.",
  });
  stats.prompts += 1;
  const spinner = new Spinner("wrapping up");
  spinner.start();
  const handlers = streamHandlers(spinner, showReasoning);
  let final;
  try {
    final = await chatStream({
      model,
      messages: buildApi(),
      tools: undefined,
      signal,
      onContent: handlers.onContent,
      onReasoning: handlers.onReasoning,
    });
  } finally {
    spinner.stop();
  }
  handlers.flush();
  recordUsage(stats, final.usage);
  onTurn?.();
  const m = final.choices[0].message;
  const content = m.content ?? "";
  const assistantMsg: Message = { role: "assistant", content };
  if (m.reasoning_content) assistantMsg.reasoning_content = m.reasoning_content;
  messages.push(assistantMsg);
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
}

export function formatStatus(stats: Stats, model: Model, opts: StatusOptions): string {
  const cost = computeCostUsd(stats, model);
  const flags =
    (opts.yolo ? " yolo" : "") + (opts.reasoning === false ? " no-reasoning" : "");
  const ctx =
    opts.contextTokens !== undefined ? `  ctx:${formatCount(opts.contextTokens)}` : "";
  const session =
    opts.sessionSeconds !== undefined ? `  ${formatDuration(opts.sessionSeconds)}` : "";
  return `${model}${flags} · $${cost.toFixed(4)}  in: ${stats.prompt_tokens} (hit ${stats.cache_hit_tokens} / miss ${stats.cache_miss_tokens})  out: ${stats.completion_tokens}  tools: ${stats.tool_calls_total}${ctx}${session}`;
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
