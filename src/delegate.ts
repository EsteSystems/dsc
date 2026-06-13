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
import type { ToolContext } from "./tools.js";

const DELEGATE_TIMEOUT_MS = 120_000; // 2 minutes max

/**
 * Schema subset for delegated sub-agents — read-only tools only.
 * No bash, no write/edit, no git_commit. git_diff is allowed.
 */
const DELEGATE_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
      description: "Read a file.",
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
        },
        required: ["pattern"],
      },
      description: "Search file contents.",
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
      description: "List files matching a glob.",
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      description: "List directory entries.",
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      parameters: {
        type: "object",
        properties: { staged: { type: "boolean" } },
      },
      description: "Show git diff.",
    },
  },
];

const DELEGATE_SYSTEM = `You are a delegated sub-agent. Your job is to investigate, analyze, and produce a structured report in response to the task below. Rules:

- You have read-only tools: read_file, grep, glob, list_dir, git_diff.
- Be thorough — explore relevant files, patterns, and edge cases.
- Produce a single, self-contained report as your final response.
- Do NOT ask questions or request clarification — produce your best analysis.
- Format as: a brief summary, then detailed findings with file references.

The user's task follows.`;

export interface DelegateResult {
  /** The sub-agent's final report. */
  content: string;
  /** Agent model used. */
  model: Model;
}

/**
 * Run a delegated sub-agent with the given prompt. Only read-only tools
 * are available. No approvals. Times out after 2 minutes.
 */
export async function runDelegate(
  prompt: string,
  cwd: string,
  model: Model = DEFAULT_MODEL,
): Promise<DelegateResult> {
  const messages: Message[] = [
    { role: "system", content: DELEGATE_SYSTEM },
    { role: "user", content: prompt },
  ];

  const stats = newStats();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELEGATE_TIMEOUT_MS);

  const toolCtx: ToolContext = {
    cwd,
    yolo: true, // no approvals in delegation
    filesTouched: new Set<string>(),
    sessionId: `delegate-${randomUUID().slice(0, 8)}`,
    sessionApprovals: new Set<string>(),
  };

  try {
    await runAgent({
      model,
      stats,
      toolCtx,
      messages,
      signal: controller.signal,
      maxAutoContinue: 0,
      extraTools: DELEGATE_TOOL_SCHEMAS,
      events: undefined,
    });
  } catch (e: any) {
    if (e.name === "AbortError" || controller.signal.aborted) {
      return {
        content: "(delegate timed out after 2 minutes)",
        model,
      };
    }
    return {
      content: `(delegate error: ${e.message})`,
      model,
    };
  } finally {
    clearTimeout(timeout);
  }

  // Extract the last assistant message as the report
  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);

  return {
    content: lastAssistant?.content || "(delegate produced no output)",
    model,
  };
}
