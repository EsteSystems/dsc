import {
  chatStream,
  computeCostUsd,
  recordUsage,
  type Message,
  type Model,
  type Stats,
} from "./api.js";
import { TOOL_SCHEMAS, executeTool, type ToolContext } from "./tools.js";
import { Spinner } from "./ui.js";

export const MAX_TOOL_DEPTH = 8;

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function streamHandlers(spinner: Spinner) {
  let started = false;
  return {
    onContent: (text: string) => {
      if (!started) {
        spinner.stop();
        process.stdout.write(`${BOLD}assistant${RESET}: `);
        started = true;
      }
      process.stdout.write(text);
    },
    flush: () => {
      if (started) process.stdout.write("\n");
    },
    started: () => started,
  };
}

export interface RunOptions {
  model: Model;
  stats: Stats;
  toolCtx: ToolContext;
  messages: Message[]; // mutated in place; pass full conversation
  signal?: AbortSignal;
  onTurn?: () => void; // called after each API response so the caller can refresh the status bar
}

export async function runAgent(opts: RunOptions): Promise<void> {
  const { messages, model, stats, toolCtx, signal, onTurn } = opts;

  for (let depth = 0; depth < MAX_TOOL_DEPTH; depth++) {
    stats.prompts += 1;
    const spinner = new Spinner("thinking");
    spinner.start();
    const handlers = streamHandlers(spinner);
    let resp;
    try {
      resp = await chatStream({
        model,
        messages,
        tools: TOOL_SCHEMAS,
        signal,
        onContent: handlers.onContent,
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
      const interactive = name !== "read_file" && !toolCtx.yolo;
      if (!interactive) toolSpinner.start();
      let result;
      try {
        result = await executeTool(name, argsRaw, toolCtx);
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
  const handlers = streamHandlers(spinner);
  let final;
  try {
    final = await chatStream({
      model,
      messages,
      tools: undefined,
      signal,
      onContent: handlers.onContent,
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

export function formatStatus(stats: Stats, model: Model, yolo: boolean): string {
  const cost = computeCostUsd(stats, model);
  const flags = yolo ? " yolo" : "";
  return `${model}${flags} · $${cost.toFixed(4)}  in: ${stats.prompt_tokens} (hit ${stats.cache_hit_tokens} / miss ${stats.cache_miss_tokens})  out: ${stats.completion_tokens}  tools: ${stats.tool_calls_total}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
