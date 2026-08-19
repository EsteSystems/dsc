/**
 * Agent delegation — spawn a read-only sub-agent for audit/exploration.
 *
 * Minimal implementation: runs the agent loop with a constrained tool set
 * (read-only), no approvals, and a timeout. Returns the sub-agent's final
 * response as a structured report.
 */

import { randomUUID } from "node:crypto";
import { runAgent } from "./agent.js";
import { newStats, DEFAULT_MODEL, type Model, type Message, type ToolSchema } from "./api.js";
import { filterToolSchemas, type ToolContext } from "./tools.js";

const DELEGATE_TIMEOUT_MS = 120_000; // 2 minutes max

/**
 * Schema subset for delegated sub-agents — read-only tools only.
 * No bash, no write/edit, no git_commit. git_diff is allowed.
 */
const DELEGATE_ALLOWED_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "git_diff",
]);
const DELEGATE_TOOL_SCHEMAS: ToolSchema[] = filterToolSchemas(DELEGATE_ALLOWED_TOOLS);

const DELEGATE_SYSTEM = `You are a delegated sub-agent. Your job is to investigate, analyze, and produce a structured report in response to the task below. Rules:

- You have read-only tools: read_file, grep, glob, list_dir, git_diff.
- Be thorough — explore relevant files, patterns, and edge cases.
- Produce a single, self-contained report as your final response.
- Do NOT ask questions or request clarification — produce your best analysis.
- Format as: a brief summary, then detailed findings with file references.

The user's task follows.`;

const PLAN_SYSTEM = `You are a planning sub-agent. You may inspect the codebase with read-only tools, but you must NOT edit files or run commands. Produce a concrete, ordered implementation plan for the task below.

Rules:
- Investigate the relevant files first.
- Keep each step small enough to execute in one turn and verify independently.
- Number every step: 1. ... 2. ... (no nested bullets).
- Prefer steps that change or verify one concern at a time.
- If the task needs no code changes, say so in a single line.
- Do NOT ask questions or request clarification — produce your best plan.

The user's task follows.`;

export interface DelegateResult {
  /** The sub-agent's final report. */
  content: string;
  /** Agent model used. */
  model: Model;
}

interface SubagentOptions {
  prompt: string;
  cwd: string;
  model: Model;
  system: string;
  toolSchemas: ToolSchema[];
  /** Short label used for session ids and timeout/error text. */
  kind: string;
}

/** Shared isolated-context runner. Each sub-agent gets its own message list,
 *  read-only schema, no approvals, and a hard timeout. */
async function runSubagent(opts: SubagentOptions): Promise<DelegateResult> {
  const messages: Message[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];

  const stats = newStats();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);

  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    yolo: true, // no approvals in subagents
    filesTouched: new Set<string>(),
    sessionId: `${opts.kind}-${randomUUID().slice(0, 8)}`,
    sessionApprovals: new Set<string>(),
  };

  try {
    await runAgent({
      model: opts.model,
      stats,
      toolCtx,
      messages,
      signal: controller.signal,
      maxAutoContinue: 0,
      toolSchemas: opts.toolSchemas,
      events: undefined,
    });
  } catch (e: any) {
    if (e.name === "AbortError" || controller.signal.aborted) {
      return { content: `(${opts.kind} timed out after 2 minutes)`, model: opts.model };
    }
    return { content: `(${opts.kind} error: ${e.message})`, model: opts.model };
  } finally {
    clearTimeout(timeout);
  }

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);

  return {
    content: lastAssistant?.content || `(${opts.kind} produced no output)`,
    model: opts.model,
  };
}

/**
 * Run a delegated read-only exploration sub-agent.
 */
export function runDelegate(
  prompt: string,
  cwd: string,
  model: Model = DEFAULT_MODEL,
): Promise<DelegateResult> {
  return runSubagent({
    prompt,
    cwd,
    model,
    system: DELEGATE_SYSTEM,
    toolSchemas: DELEGATE_TOOL_SCHEMAS,
    kind: "delegate",
  });
}

/**
 * Run an isolated planning sub-agent. Read-only schema; returns a numbered
 * plan the main agent (or the user) can execute step by step.
 */
export function runPlanAgent(
  prompt: string,
  cwd: string,
  model: Model = DEFAULT_MODEL,
): Promise<DelegateResult> {
  return runSubagent({
    prompt,
    cwd,
    model,
    system: PLAN_SYSTEM,
    toolSchemas: DELEGATE_TOOL_SCHEMAS,
    kind: "plan-agent",
  });
}
