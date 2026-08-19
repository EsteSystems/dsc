// TUI entry. Real agent loop wired through structured events into the
// pub/sub store. The React components in src/tui/* subscribe to store
// changes; this file owns the imperative session/agent setup, queues
// type-ahead while a turn is running, and bridges approvals through the
// ApprovalDialog component.

import React from "react";
import { render, type Instance } from "ink";
import { App } from "./tui/App.js";
import { getState, setState } from "./store.js";
import type { UIMessage } from "./store.js";
import {
  availableModels,
  DEFAULT_MODEL,
  DeepSeekError,
  chat,
  computeCostUsd,
  configPath,
  consumeConfigMigrationNotice,
  getConfig,
  hasApiKey,
  isKnownModel,
  recordUsage,
  type Message,
  type Model,
} from "./api.js";
import { loadInstructions } from "./instructions.js";
import { readPreferences, savePreferences } from "./preferences.js";
import {
  callMCPTool,
  closeAll as closeMCP,
  connectAll as connectMCP,
  type MCPConnection,
} from "./mcp.js";
import {
  runAgent,
  formatCost,
  estimateContextTokens,
} from "./agent.js";
import type { AgentEvents } from "./agent.js";
import type { ToolContext } from "./tools.js";
import { buildOneShotEnvelope } from "./json_output.js";
import * as history from "./history.js";
import * as approval from "./approval.js";
import * as replHistory from "./repl_history.js";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { compactSession } from "./compact.js";
import { resolveAtImages } from "./images.js";
import type { ImageBlock } from "./images.js";
import { formatVersionInfo } from "./version.js";
import { openEditor } from "./editor.js";
import { checkForUpdate } from "./update.js";
import { dispatchSlash, type SlashContext } from "./slash_dispatch.js";
import { ProjectContext } from "./context.js";
import * as memory from "./memory/index.js";
import { MEMORY_TOOL_SCHEMAS, dispatchMemoryTool } from "./memory/tools.js";

/** Parse a numbered task list from the agent's response. Returns empty array
 *  if no clear plan structure was found. */
function parsePlanTasks(text: string): { id: number; text: string; done: boolean }[] {
  const tasks: { id: number; text: string; done: boolean }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (m) {
      tasks.push({ id: parseInt(m[1], 10), text: m[2].trim(), done: false });
    }
  }
  // Only accept if the tasks are sequential (1, 2, 3, ...) — guards against
  // the agent casually writing "1. something" mid-paragraph.
  if (tasks.length < 2) return [];
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].id !== i + 1) return [];
  }
  return tasks;
}

// Auto-compact threshold (token-count of estimated context). Default
// 50K — well below the 1M model limit, but tuned to keep per-turn input
// cost from creeping. Override via DSC_AUTO_COMPACT_AT; set to "0" /
// "off" / "false" to disable. Default 20K — tuned to keep per-turn
// input cost reasonable without losing too much context to summaries.
const AUTO_COMPACT_AT_TOKENS = (() => {
  const raw = process.env.DSC_AUTO_COMPACT_AT;
  if (!raw) return 20_000;
  if (raw === "0" || raw === "off" || raw === "false") return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
})();
const AUTO_COMPACT_KEEP = Number(process.env.DSC_AUTO_COMPACT_KEEP ?? "8") || 8;

interface CliParse {
  prompt?: string;
  help?: boolean;
  version?: boolean;
  yolo?: boolean;
  noResume?: boolean;
  resume?: boolean;
  resumeId?: string;
  model?: Model;
  modelExplicit?: boolean;
  json?: boolean;
}

class CliError extends Error {}

// Full arg parsing for the TUI entry — this is the only entry point now
// that the readline REPL is gone. Anything the old REPL accepted needs to
// be handled here.
function parseArgs(argv: string[]): CliParse {
  const out: CliParse = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yolo" || a === "-y") out.yolo = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-resume") out.noResume = true;
    else if (a === "--resume") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        out.resumeId = v;
        i++;
      }
      out.resume = true;
    } else if (a === "--model" || a === "-m") {
      const v = argv[++i];
      if (!isKnownModel(v)) {
        throw new CliError(
          `unknown model: ${v} (available: ${availableModels().join(", ")})`,
        );
      }
      out.model = v;
      out.modelExplicit = true;
    } else if (a.startsWith("-")) {
      throw new CliError(`unknown flag: ${a}`);
    } else positional.push(a);
  }
  if (positional.length) out.prompt = positional.join(" ");
  return out;
}

async function main() {
  let cli: CliParse;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  if (cli.version) {
    process.stdout.write(formatVersionInfo() + "\n");
    process.exit(0);
  }
  if (cli.help) {
    process.stdout.write(
      [
        "dsc — Dev Shell Companion (CLI coding agent for DeepSeek)",
        "",
        "Usage:",
        "  dsc                            Start the TUI",
        "  dsc \"your prompt here\"         One-shot: run and exit",
        "  dsc serve [--port <n>]         Headless WebSocket daemon (default 127.0.0.1:9090)",
        "",
        "Flags:",
        "  -m, --model <name>             " + availableModels().join(" | "),
        "  -y, --yolo                     Skip approval prompts",
        "      --json                     Emit a JSON envelope (one-shot only)",
        "      --no-resume                Don't auto-resume the latest session",
        "      --resume [id]              Resume the most recent (or by id)",
        "  -v, --version                  Print version and exit",
        "  -h, --help                     Show this help",
      ].join("\n") + "\n",
    );
    process.exit(0);
  }

  // First-launch UX: don't hard-exit when there's no API key. Boot the
  // TUI and surface a one-line system message telling the user how to
  // set one via /api-key. Submitting a turn before setting the key will
  // surface DeepSeekError, which we already render as a system error.
  const startupKeyMissing = !hasApiKey();

  const cwd = process.cwd();
  await history.migrateLegacyIfPresent(cwd, DEFAULT_MODEL);

  let session = history.newSession(cwd, DEFAULT_MODEL);
  if (cli.resumeId) {
    // Explicit --resume <id>: load that session by id, error out if it
    // doesn't exist rather than silently falling back to a new session.
    const loaded = await history.loadSession(cli.resumeId);
    if (!loaded) {
      process.stderr.write(`session not found: ${cli.resumeId}\n`);
      process.exit(1);
    }
    session = loaded;
  } else if (!cli.noResume) {
    // Auto-resume most recent for this cwd; otherwise fresh.
    const target = await history.mostRecentForCwd(cwd);
    if (target) {
      const loaded = await history.loadSession(target.id);
      if (loaded) session = loaded;
    }
  }

  // Reassigned by /clear and /resume — keep `let` so handlers can swap them
  // out for the new session's arrays without restarting the process.
  let messages: Message[] = session.messages;
  let stats = session.stats;
  // --model on the command line overrides the session's stored model.
  // Without --model, the session's model wins so resuming preserves what
  // the user picked last time.
  let model: Model = cli.modelExplicit && cli.model ? cli.model : session.model;

  // Persisted UI preferences (yolo / reasoning / auto-continue / budget).
  // Precedence: command-line flags > saved preferences > defaults. The
  // env-var DSC_AUTO_CONTINUE still beats both for backwards compat with
  // scripted invocations.
  const savedPrefs = await readPreferences();
  const envAutoContinue = Number(process.env.DSC_AUTO_CONTINUE ?? "0") || 0;
  const initialAutoContinue = envAutoContinue || savedPrefs.autoContinue || 0;

  const toolCtx: ToolContext = {
    cwd,
    // --yolo on the command line forces it on; otherwise honor saved
    // preference; otherwise off.
    yolo: cli.yolo === true ? true : savedPrefs.yolo === true,
    filesTouched: stats.files_touched,
    sessionId: session.id,
    sessionApprovals: new Set(),
  };

  // MCP connections live here so /mcp, runTurn, and the close-on-exit
  // hook can all reach them. Populated by connectMCP() once at boot,
  // mutated by /mcp reconnect (future). When no `mcp.servers` block is
  // in the config this is just an empty array — no network, no cost.
  let mcpConnections: MCPConnection[] = [];
  const mcpExtraTools = (): import("./api.js").ToolSchema[] =>
    mcpConnections.flatMap((c) => c.tools)
      .concat(memoryEnabled ? MEMORY_TOOL_SCHEMAS : []);
  const mcpDispatch = (name: string, args: Record<string, unknown>) => {
    if (memoryEnabled && name.startsWith("mcp_memory_")) {
      return dispatchMemoryTool(name, args);
    }
    return callMCPTool(mcpConnections, name, args, {
      sessionApprovals: toolCtx.sessionApprovals,
    });
  };

  // Project-context index: chunks AGENTS.md, README.md, etc. and
  // injects relevant paragraphs before each agent turn.  Re-indexed
  // when the session resets (/clear, /resume).

  const projectCtx = new ProjectContext();
  await projectCtx.build(cwd);

  // Coalescing save (same shape as REPL).
  let savePromise: Promise<void> | null = null;
  let savePending = false;
  const persist = (): Promise<void> => {
    savePending = true;
    if (savePromise) return savePromise;
    savePromise = (async () => {
      while (savePending) {
        savePending = false;
        try {
          session.model = model;
          session.messages = messages;
          session.stats = stats;
          await history.saveSession(session);
        } catch {
          // Swallow — the next turn will retry; no stderr in TUI mode.
        }
      }
      savePromise = null;
    })();
    return savePromise;
  };

  const sessionStart = Date.now();

  // Per-session USD cost ceiling. `null` = no limit (default).
  // `/budget` toggles. We pre-turn-check the spend against this and
  // abort the next prompt when over; `budgetWarned` keeps the 80%
  // notice from firing on every status tick.
  let budgetUsd: number | null = savedPrefs.budgetUsd ?? null;
  let budgetWarned = false;
  const promptQueue: string[] = [];
  const promptImages = new Map<string, ImageBlock[]>();

  // Push the freshly-computed numbers into the store; StatusBar reads from
  // there. Called after every onTurn and once per second for the timer.
  const syncStatus = () => {
    const cost = computeCostUsd(stats, model);
    setState({
      model,
      contextTokens: estimateContextTokens(messages),
      lastPromptTokens: stats.last_prompt_tokens,
      sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
      inTokens: stats.prompt_tokens,
      outTokens: stats.completion_tokens,
      cacheHitTokens: stats.cache_hit_tokens,
      cacheMissTokens: stats.cache_miss_tokens,
      toolCalls: stats.tool_calls_total,
      queue: promptQueue.slice(),
      queueDepth: promptQueue.length,
      compacted: !!session.compaction,
      cost,
    });
    // 80% budget warning. Fires once per /budget set; resetting or
    // changing the budget clears the flag so the next threshold gets
    // its own notice. Skipped when no budget is configured.
    if (budgetUsd !== null && !budgetWarned && cost >= budgetUsd * 0.8) {
      const pct = Math.round((cost / budgetUsd) * 100);
      info(
        `budget warning: $${cost.toFixed(4)} of $${budgetUsd.toFixed(2)} (${pct}%). Next turn aborts at $${budgetUsd.toFixed(2)}.`,
      );
      budgetWarned = true;
    }
  };

  setState({
    model,
    yolo: toolCtx.yolo,
    // savedPrefs.reasoning may be undefined; the store defaults to true
    // anyway. Explicit `reasoning: false` from prefs is the only path
    // that flips this on boot.
    reasoning: savedPrefs.reasoning ?? true,
    assistantLabel: session.assistantLabel ?? "assistant:",
    language: session.language,
    autoContinue: initialAutoContinue,
  });

  // Seed history from the restored session so prior turns are visible.
  if (messages.length) {
    const restored: UIMessage[] = [];
    for (const m of messages) {
      if (m.role === "system") continue;
      restored.push({
        id: `r-${restored.length}`,
        role: m.role as UIMessage["role"],
        content: typeof m.content === "string" ? m.content : "",
        tool_call_id: m.tool_call_id,
      });
    }
    setState({ history: restored });
  }

  syncStatus();
  // 1-second tick so the session timer in StatusBar advances even when idle.
  const timerId = setInterval(syncStatus, 1000);

  // Install the approval asker — routes confirm* calls through the
  // ApprovalDialog component. The structured payload (title + body + kind)
  // goes into the dialog so the diff/preview renders inline in the yellow
  // bordered box rather than bleeding above ink's dynamic frame.
  approval.setAsker(
    (req) =>
      new Promise<string>((resolve) => {
        setState({
          approval: {
            title: req.title,
            body: req.body ?? "",
            kind: req.kind,
            question: req.question,
            resolve,
          },
        });
      }),
  );

  // Wire events: agent → store.
  const events: AgentEvents = {
    onAssistantStart: (turnId) => {
      setState({
        current: { id: turnId, role: "assistant", content: "", reasoning: "" },
      });
    },
    onAssistantContent: (turnId, chunk) => {
      setState((s) => {
        const cur = s.current && s.current.id === turnId
          ? s.current
          : { id: turnId, role: "assistant" as const, content: "", reasoning: "" };
        return { current: { ...cur, content: (cur.content ?? "") + chunk } };
      });
    },
    onAssistantReasoning: (turnId, chunk) => {
      setState((s) => {
        const cur = s.current && s.current.id === turnId
          ? s.current
          : { id: turnId, role: "assistant" as const, content: "", reasoning: "" };
        return { current: { ...cur, reasoning: (cur.reasoning ?? "") + chunk } };
      });
    },
    onAssistantFinal: (turnId, msg) => {
      // Move from `current` into the static history (so it's selectable).
      // Only skip when the turn was purely a tool dispatch (content empty,
      // reasoning empty, and tool_calls present) — those produce visible
      // tool messages of their own, so an "(no content)" placeholder would
      // be noise. A truly empty turn (no content, no reasoning, no tool
      // calls) still gets a marker so the user knows the agent stopped
      // rather than wondering whether something silently broke.
      const hasText =
        (msg.content && msg.content.length) ||
        (msg.reasoning && msg.reasoning.length);
      const isToolOnly = !hasText && msg.tool_calls && msg.tool_calls.length;
      setState((s) => {
        const next: Partial<typeof s> = { current: null };
        if (isToolOnly) {
          // pure tool dispatch — tool messages will appear separately
        } else if (hasText) {
          next.history = [
            ...s.history,
            {
              id: turnId,
              role: "assistant",
              content: msg.content,
              reasoning: msg.reasoning,
              tool_calls: msg.tool_calls,
            },
          ];
        } else {
          // Genuinely empty turn — show a marker rather than appearing to
          // hang. Most often hit when an upstream filter or network drop
          // cuts the stream before any tokens arrive.
          next.history = [
            ...s.history,
            {
              id: turnId,
              role: "system",
              content: "(model returned no content)",
            },
          ];
        }
        return next;
      });
    },
    onToolStart: (_callId, name, args) => {
      setState({ task: formatTaskLabel(name, args) });
    },
    onToolEnd: (callId, name, content, rejected) => {
      setState((s) => ({
        task: null,
        history: [
          ...s.history,
          {
            id: callId,
            role: "tool",
            content,
            tool_call_id: callId,
            tool_name: rejected ? `${name} (rejected)` : name,
          },
        ],
      }));
    },
    onNotice: (text) => {
      setState((s) => ({
        history: [
          ...s.history,
          { id: `n-${s.history.length}`, role: "system", content: text },
        ],
      }));
    },
  };

  let pendingAbort: AbortController | null = null;

  const runTurn = async (userText: string) => {
    // Pre-turn budget check. We block at the *start* of the next turn
    // rather than mid-stream — letting a turn that's already in flight
    // finish is the less surprising behavior.
    if (budgetUsd !== null) {
      // Snapshot the mutable let into a const so TS keeps the non-null
      // narrowing across the setState closure below.
      const limit = budgetUsd;
      const cost = computeCostUsd(stats, model);
      if (cost >= limit) {
        // Echo the user's prompt so it doesn't look like input was
        // swallowed, then explain why nothing's happening.
        setState((s) => ({
          history: [
            ...s.history,
            { id: `u-${s.history.length}`, role: "user", content: userText },
            {
              id: `e-${s.history.length + 1}`,
              role: "system",
              content: `error: budget reached ($${cost.toFixed(4)} >= $${limit.toFixed(2)}). /budget off to lift, /budget <amount> to raise.`,
            },
          ],
        }));
        return;
      }
    }

    // Inject relevant project context from indexed files (AGENTS.md,
    // README.md, and recently-touched files).  The history shows the
    // original user text; the model sees context-enriched.
    const ctxSnippets = projectCtx.search(userText);
    const memCtx = memory.autoQueryContext(userText);
    const enhancedText =
      ctxSnippets.length > 0 || memCtx
        ? (ctxSnippets.length > 0
            ? "Relevant project context:\n\n" + ctxSnippets.join("\n\n") + "\n\n"
            : "") +
          (memCtx ? memCtx + "\n\n" : "") +
          "---\nUser: " +
          userText
        : userText;

    // Push the user message into history immediately so it's visible before
    // the model responds.
    setState((s) => ({
      history: [
        ...s.history,
        { id: `u-${s.history.length}`, role: "user", content: userText },
      ],
      busy: true,
    }));
    messages.push({ role: "user", content: enhancedText, ...(promptImages.has(userText) ? { images: promptImages.get(userText) } : {}) });
    promptImages.delete(userText);
    pendingAbort = new AbortController();
    try {
      await runAgent({
        model,
        stats,
        toolCtx,
        messages,
        signal: pendingAbort.signal,
        onTurn: () => {
          syncStatus();
          void persist();
        },
        showReasoning: getState().reasoning,
        getSummary: () => session.compaction?.summary,
        assistantLabel: session.assistantLabel,
        maxAutoContinue: getState().autoContinue,
        language: session.language,
        events,
        extraTools: mcpExtraTools(),
        dispatchExtraTool: mcpDispatch,
      });
    } catch (e) {
      const text =
        (e as Error).name === "AbortError" || pendingAbort?.signal.aborted
          ? "(interrupted)"
          : e instanceof DeepSeekError
            ? `API error ${e.status ?? ""}: ${e.message}`
            : `error: ${(e as Error).message ?? e}`;
      setState((s) => ({
        history: [
          ...s.history,
          { id: `e-${s.history.length}`, role: "system", content: text },
        ],
      }));
    } finally {
      pendingAbort = null;
      setState({ busy: false, task: null });
    }
    await persist();
    // Index any files the agent touched this turn for future context queries.
    for (const f of toolCtx.filesTouched) {
      await projectCtx.addFile(cwd, f);
    }
    // Store the agent's last response as memory propositions (fire-and-forget).
    if (memoryEnabled) {
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant?.content) {
        memory
          .storePropositions(lastAssistant.content, session.id + "-assistant")
          .catch(() => {});
      }
    }
  };

  // Drain queued prompts after each turn so back-to-back submissions run in
  // order without overlapping turns.
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (promptQueue.length) {
        const next = promptQueue.shift()!;
        syncStatus();
        await runTurn(next);
        // If the user requested a plan, try to parse the last assistant message
        const pt = getState().planRequestTitle;
        if (pt) {
          const last = [...messages].reverse().find(
            (m) => m.role === "assistant" && typeof m.content === "string",
          );
          if (last && typeof last.content === "string") {
            const tasks = parsePlanTasks(last.content);
            if (tasks.length > 0) {
              setState({ plan: { title: pt, tasks }, planRequestTitle: null });
            } else {
              setState({ planRequestTitle: null });
            }
          }
        }
        if (AUTO_COMPACT_AT_TOKENS > 0) {
          const ctx = estimateContextTokens(messages);
          if (ctx > AUTO_COMPACT_AT_TOKENS) {
            await runCompaction(AUTO_COMPACT_KEEP, true);
          }
        }
      }
    } finally {
      draining = false;
    }
  };

  // Persisted REPL history — both REPL and TUI share this on-disk file so
  // arrow-up recall works across sessions and across the two front-ends.
  const promptHistory = await replHistory.load();

  // Forward declarations so handleSlash can reference the ink instance and
  // remount helper for /edit (which unmounts ink, runs $EDITOR, remounts).
  // These get assigned just before the first render at the bottom of main().
  let inkInstance: Instance | null = null;
  const mountApp = () => {
    inkInstance = render(
      <App
        onSubmit={handleSubmit}
        onAbort={handleAbort}
        history={promptHistory}
      />,
    );
  };

  // Push a one-line dim system notice into history (used for slash-command
  // output — the dim styling comes from History's role==="system" treatment).
  const info = (text: string) => {
    setState((s) => ({
      history: [
        ...s.history,
        { id: `i-${s.history.length}`, role: "system", content: text },
      ],
    }));
  };

  const runCompaction = async (keep: number, auto: boolean): Promise<void> => {
    const beforeMessages = messages.length;
    const beforeChars = messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    if (auto) info(`── auto-compact (ctx > ${AUTO_COMPACT_AT_TOKENS} tokens)`);
    // Flip busy so the StatusBar shows the spinner — compaction is a
    // single-shot API call that can take 5–15s on long sessions and was
    // silent before this.
    setState({ busy: true, task: "compacting" });
    try {
      const result = await compactSession(session, keep, model);
      if (!result) {
        if (!auto) info(`nothing to compact (need more than ${keep} user turns)`);
        return;
      }
      session.archivedMessages = [
        ...(session.archivedMessages ?? []),
        ...result.droppedMessages,
      ];
      session.messages = result.remainingMessages;
      messages = session.messages;
      session.compaction = {
        summary: result.summary,
        compacted_at: Date.now(),
        turns_removed:
          (session.compaction?.turns_removed ?? 0) + result.turnsRemoved,
      };
      stats.prompts += 1;
      recordUsage(stats, result.usage);
      const afterChars = messages.reduce(
        (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      info(
        `compacted ${result.turnsRemoved} user turn(s); messages ${beforeMessages} → ${messages.length}; chars ${beforeChars} → ${afterChars} + ${result.summary.length} summary`,
      );
      syncStatus();
      await persist();
    } catch (e) {
      info(
        e instanceof DeepSeekError
          ? `error: compaction failed: ${e.message}`
          : `error: compaction failed: ${(e as Error).message}`,
      );
    } finally {
      setState({ busy: false, task: null });
    }
  };

  // Returns true if the input was a recognized slash command and got handled
  // (or rejected) — caller should not forward it to the agent. Returns false
  // for non-slash input and unknown commands (caller decides what to do).
  // Slash-command dispatch lives in src/slash_dispatch.ts now (shared with
  // `dsc serve`). We wire the dispatcher's SlashContext to this front-end's
  // imperative locals: getters read the (reassignable) session state, actions
  // mutate it + drive ink. `emit` is the `info()` system-line sink.
  const slashContext: SlashContext = {
    cwd,
    emit: info,
    getModel: () => model,
    getStats: () => stats,
    getSession: () => session,
    getMessages: () => messages,
    getToolCtx: () => toolCtx,
    getQueue: () => promptQueue,
    getBudget: () => ({ usd: budgetUsd, warned: budgetWarned }),
    getMcpConnections: () => mcpConnections,
    setModel: (m) => {
      model = m;
    },
    setBudget: (usd, warned) => {
      budgetUsd = usd;
      budgetWarned = warned;
    },
    persist,
    syncStatus,
    compact: runCompaction,
    submit: (text) => handleSubmit(text),
    applySession: (next, opts) => {
      session = next;
      messages = next.messages;
      stats = next.stats;
      model = next.model;
      toolCtx.filesTouched = stats.files_touched;
      toolCtx.sessionId = next.id;
      // Per-tool always-approval is conversation-scoped, so /clear drops it —
      // otherwise the user carries implicit trust into a session they walked
      // away from.
      if (opts.resetApprovals) toolCtx.sessionApprovals = new Set();
      if (opts.rebuildView) {
        // Rebuild the visible history from the (resumed/imported) session.
        const restored: UIMessage[] = [];
        for (const m of messages) {
          if (m.role === "system") continue;
          restored.push({
            id: `r-${restored.length}`,
            role: m.role as UIMessage["role"],
            content: typeof m.content === "string" ? m.content : "",
            tool_call_id: m.tool_call_id,
          });
        }
        setState({ history: restored, current: null, model, plan: null });
      } else {
        setState({ history: [], current: null, model, plan: null });
      }
      syncStatus();
      void projectCtx.build(cwd); // re-index on session reset
    },
    runEditor: (initial) => {
      // ink owns the terminal — unmount before spawning $EDITOR so the editor
      // gets a clean screen. Clear `history` first so the post-remount
      // <Static> doesn't re-emit prior turns to scrollback. Already-printed
      // scrollback above stays untouched.
      setState({ history: [] });
      inkInstance?.unmount();
      const draft = openEditor(initial);
      mountApp();
      return draft;
    },
    exit: () => {
      clearInterval(timerId);
      process.exit(0);
    },
    getPlan: () => getState().plan,
    setPlan: (p) => setState({ plan: p }),
    runBashCommand: (command) =>
      new Promise<string>((resolve) => {
        const child = spawn(command, [], {
          cwd,
          shell: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (out += d.toString()));
        child.on("close", () => {
          const MAX = 16_000;
          resolve(
            out.length > MAX
              ? out.slice(0, MAX) + `\n…(truncated, ${out.length - MAX} more chars)`
              : out,
          );
        });
        child.on("error", (e) => resolve(`error: ${e.message}`));
      }),
  };

  // Returns true if the input was a recognized slash command and got handled
  // (or rejected) — caller should not forward it to the agent. Returns false
  // for non-slash input and unknown commands (caller decides what to do).
  const handleSlash = (line: string): Promise<boolean> => dispatchSlash(line, slashContext);

  /** Scan `text` for `@path` (and `@path:line` / `@path:start-end`) references,
   *  read each file, and prepend their contents to the prompt. References that
   *  don't resolve to readable files are replaced with a one-line error note.
   *  Returns the original text if no `@`-references were found. */
  const resolveAtFiles = async (text: string): Promise<string> => {
    const re = /(?:^|\s)@(\S+)/g;
    const refs: { raw: string; path: string; start?: number; end?: number }[] = [];
    for (const m of text.matchAll(re)) {
      const raw = m[1];
      const lm = raw.match(/^(.+?):(\d+)(?:-(\d+))?$/);
      if (lm) {
        refs.push({ raw, path: lm[1], start: Number(lm[2]), end: lm[3] ? Number(lm[3]) : undefined });
      } else {
        refs.push({ raw, path: raw });
      }
    }
    if (refs.length === 0) return text;

    const blocks: string[] = [];
    for (const ref of refs) {
      try {
        const abs = path.resolve(cwd, ref.path);
        const s = await fsp.stat(abs);
        if (s.isDirectory()) {
          blocks.push(`(skipped ${ref.path} — directory)`);
          continue;
        }
        let content = await fsp.readFile(abs, "utf-8");
        const totalLines = content.split("\n").length;
        if (ref.start) {
          const lines = content.split("\n");
          if (ref.end) {
            content = lines.slice(ref.start - 1, ref.end).join("\n");
          } else {
            content = lines.slice(ref.start - 1).join("\n");
          }
        }
        const MAX = 50_000;
        if (content.length > MAX) {
          content = content.slice(0, MAX) + `\n…(truncated, ${content.length - MAX} more chars)`;
        }
        const range = ref.start ? ` lines ${ref.start}${ref.end ? `-${ref.end}` : "+"}` : "";
        blocks.push(`File ${ref.path} (${totalLines} lines${range}):\n${content}`);
      } catch {
        blocks.push(`(could not read ${ref.path})`);
      }
    }
    if (blocks.length === 0) return text;
    // Strip @references from the original text
    let clean = text;
    for (const ref of refs) {
      clean = clean.replace(new RegExp(`@${ref.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\  const handleSubmit = (text: string) => {")}`, "g"), "");
    }
    clean = clean.trim().replace(/\s+/g, " ");
    return blocks.join("\n\n") + "\n\n" + (clean ? `User: ${clean}` : "");
  };

  const handleSubmit = (text: string) => {
    // Persist every submitted line — slash commands included, since
    // recalling "/resume 3" via arrow-up is useful.
    if (text.trim()) {
      promptHistory.push(text);
      void replHistory.append(text);
    }
    if (text.startsWith("/")) {
      // Echo the command into history so the user can see which command
      // produced the system-line output that follows. Without this the
      // info() lines look orphaned — especially when you scroll back
      // and there's no record of what triggered each one.
      setState((s) => ({
        history: [
          ...s.history,
          { id: `u-${s.history.length}`, role: "user", content: text },
        ],
      }));
      void handleSlash(text);
      return;
    }
    void resolveAtImages(text, cwd).then(async ({ text: cleanText, images }) => {
      const resolved = await resolveAtFiles(cleanText);
      promptQueue.push(resolved);
      if (images.length > 0) promptImages.set(resolved, images);
      syncStatus();
      void drain();
    });
  };

  const handleAbort = () => {
    if (pendingAbort && !pendingAbort.signal.aborted) {
      pendingAbort.abort();
    }
  };

  if (cli.prompt) {
    // One-shot: run the agent against the prompt with stdout-mode output
    // (no events, no ink) and exit. Session state still loads + persists so
    // subsequent interactive runs see the new turn.
    clearInterval(timerId);
    // Migration notice goes to stderr so stdout stays clean for piping.
    const migratedFromOneShot = consumeConfigMigrationNotice();
    if (migratedFromOneShot) {
      process.stderr.write(
        `migrated config: copied ${migratedFromOneShot} → ${configPath()}\n`,
      );
    }
    const { text: cleanOneShot, images: imgOneShot } = await resolveAtImages(cli.prompt, cwd);
    const resolvedOneShot = await resolveAtFiles(cleanOneShot);
    messages.push({ role: "user", content: resolvedOneShot, ...(imgOneShot.length ? { images: imgOneShot } : {}) });
    pendingAbort = new AbortController();

    let oneShotEvents: AgentEvents | undefined;
    const oneShotToolCalls: Array<{ id: string; name: string; args: string; content: string; rejected: boolean }> = [];
    const startedArgs = new Map<string, string>();
    let oneShotResult = "";
    if (cli.json) {
      oneShotEvents = {
        onAssistantStart: () => {},
        onAssistantContent: () => {},
        onAssistantReasoning: () => {},
        onAssistantFinal: (_id, msg) => {
          oneShotResult = msg.content;
        },
        onToolStart: (id, name, args) => {
          startedArgs.set(id, args);
        },
        onToolEnd: (id, name, content, rejected) => {
          oneShotToolCalls.push({ id, name, args: startedArgs.get(id) ?? "", content, rejected });
        },
        onNotice: () => {},
      };
    }

    const startedAt = Date.now();
    let runError: string | undefined;
    try {
      await runAgent({
        model,
        stats,
        toolCtx,
        messages,
        signal: pendingAbort.signal,
        onTurn: () => void persist(),
        showReasoning: getState().reasoning,
        getSummary: () => session.compaction?.summary,
        assistantLabel: session.assistantLabel,
        maxAutoContinue: getState().autoContinue,
        language: session.language,
        extraTools: mcpExtraTools(),
        dispatchExtraTool: mcpDispatch,
        // No events in plain one-shot mode: agent writes its assistant header,
        // content, tool arrows, and notices directly to stdout. JSON mode
        // supplies events so the agent emits nothing and we serialize the
        // structured result below.
        events: oneShotEvents,
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError" || pendingAbort?.signal.aborted;
      runError = aborted ? "aborted" : ((e as Error).message ?? "error");
      if (!aborted) {
        process.stderr.write(`\n${runError}\n`);
      }
    }
    const durationMs = Date.now() - startedAt;
    await persist();

    if (cli.json) {
      process.stdout.write(
        JSON.stringify(
          buildOneShotEnvelope({
            ok: !runError,
            error: runError,
            result: oneShotResult,
            toolCalls: oneShotToolCalls,
            stats,
            model,
            durationMs,
            sessionId: session.id,
          }),
        ) + "\n",
      );
    } else {
      process.stdout.write(`\n${formatCost(stats, model)}\n`);
    }
    process.exit(0);
  }

  mountApp();

  // Surface a one-time notice when the config was just copied forward
  // from the legacy ~/.config/deepseek/deepseek.json location. The copy
  // already happened lazily inside hasApiKey() above; we only print.
  // The legacy file is left intact in case the user has tooling reading it.
  const migratedFrom = consumeConfigMigrationNotice();
  if (migratedFrom) {
    info(
      `migrated config: copied ${migratedFrom} → ${configPath()}. The old file was left in place; safe to delete once you've confirmed the new one works.`,
    );
  }

  // One-time welcome panel. Stamped via a touch-file under XDG_STATE_HOME
  // so we never nag the same user twice. New users get an orientation
  // (key, /help, hotkeys); the more-targeted "no API key" reminder fires
  // on every subsequent launch when no key is configured.
  const stateDir = ((): string => {
    const xdg = process.env.XDG_STATE_HOME;
    const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
    return path.join(base, "dsc");
  })();
  const welcomeStamp = path.join(stateDir, "welcomed");
  let alreadyWelcomed = false;
  try {
    await fsp.access(welcomeStamp);
    alreadyWelcomed = true;
  } catch {
    // first launch
  }

  if (!alreadyWelcomed) {
    const lines: string[] = [
      "Welcome to dsc — Dev Shell Companion. A CLI coding agent in your terminal.",
      "",
      "  /help            full command list (TAB completes any /command)",
      "  Up / Down        recall past prompts",
      "  ESC              abort a running turn",
      "  Ctrl+D           exit",
    ];
    if (startupKeyMissing) {
      lines.push(
        "",
        "To get started, save your API key:",
        "  /api-key sk-...   (get one at https://platform.deepseek.com/api_keys)",
        "  or: export DEEPSEEK_API_KEY in your shell",
      );
    }
    info(lines.join("\n"));
    try {
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(welcomeStamp, new Date().toISOString(), "utf8");
    } catch {
      // best-effort; missing perms just means the welcome shows again
    }
  } else if (startupKeyMissing) {
    // Targeted nudge for returning users who somehow lost their key.
    info(
      `No DeepSeek API key found. Run "/api-key <key>" to save one to ${configPath()}, or export DEEPSEEK_API_KEY in your shell.`,
    );
  }

  // Surface any instruction overlays the agent picked up, so the user
  // knows project conventions are being injected into the prompt without
  // having to ask /instructions. Cheap: loadInstructions hits at most
  // three local files.
  const overlays = loadInstructions(cwd);
  if (overlays.length > 0) {
    const labels = overlays
      .map((ov) =>
        ov.kind === "user"
          ? "user"
          : ov.kind === "agents"
            ? "AGENTS.md"
            : ".dsc/instructions.md",
      )
      .join(", ");
    info(`loaded instruction overlays: ${labels}  (/instructions to inspect)`);
  }

  // Loud announcements for persisted preferences that have real cost
  // or safety implications. yolo: approvals are off — bypass anything
  // the model decides. budget: a previously-set ceiling can abort a
  // turn unexpectedly. The "warning:" prefix triggers the red treatment
  // in History's MessageRow.
  if (toolCtx.yolo) {
    info(
      "warning: yolo is on — write/edit/bash/web_fetch run without approval. /yolo to disable.",
    );
  }
  if (budgetUsd !== null) {
    info(
      `warning: budget set to ${budgetUsd.toFixed(2)} (saved from a previous session). /budget off to clear, /budget <amount> to change.`,
    );
  }


  // Connect any configured MCP servers in the background. We don't block
  // boot — the user can interact with built-in tools immediately, and
  // MCP-provided tools become available the moment connectAll resolves.
  // If a turn starts before MCP is ready, that turn just doesn't see
  // those tools; subsequent turns do.
  void (async () => {
    try {
      const { connections, errors } = await connectMCP();
      mcpConnections = connections;
      if (connections.length > 0) {
        const summary = connections
          .map((c) => `${c.name} (${c.tools.length} tools)`)
          .join(", ");
        info(`mcp connected: ${summary}  (/mcp to inspect)`);
      }
      for (const e of errors) {
        info(`error: mcp server '${e.name}' failed: ${e.error}`);
      }
    } catch (e) {
      info(`error: mcp connect failed: ${(e as Error).message}`);
    }
  })();

  // Native memory graph (replaces the Python mcp-memory server).
  // Enabled via `"memory": { "enabled": true }` in config.json.
  const memConfig = getConfig();
  const memoryEnabled = !!(memConfig && typeof memConfig === "object" &&
    (memConfig as any).memory && (memConfig as any).memory.enabled);
  if (memoryEnabled) {
    memory.setEnabled(true);
    memory.setModel(model);
    // Shim the non-streaming chat for proposition extraction and
    // relationship classification (background, not on the critical path).
    memory.setApiCall(async (m, msgs, _maxTokens) => {
      const res = await chat({
        model: m,
        messages: msgs as any,
      });
      return res.choices?.[0]?.message?.content ?? "";
    });
    info("memory: graph enabled (native, no Python subprocess)");
  }

  // One-time notice for upgraders who haven't enabled memory yet.
  if (!memoryEnabled && !(savedPrefs as any).memoryNoticeShown) {
    info(
      "new: native memory graph — dsc can now store knowledge across sessions.\n" +
        '  Add "memory": { "enabled": true } to ~/.config/dsc/config.json to activate.\n' +
        "  If you were using the Python mcp-memory server, remove its block from\n" +
        "  mcp.servers to avoid duplicate tools. (notice won't repeat)",
    );
    void (savePreferences as any)({ memoryNoticeShown: true }).catch(() => {});
  }

  // Fire-and-forget update probe. Uses the 24h cache by default so a
  // chatty notice doesn't appear on every launch — only once per day,
  // when the registry says we're behind. Failures are swallowed silently.
  void (async () => {
    try {
      const check = await checkForUpdate();
      if (check.newerAvailable) {
        info(
          `update available: ${check.latest} (you have ${check.current}). Run /update to install.`,
        );
      }
    } catch {
      // best-effort; offline launches shouldn't yell at the user
    }
  })();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// Render the "what tool is running" label shown in the status bar (right
// side) and TaskLine. Without this, we'd dump the raw JSON arguments
// inline — `bash({"command":"npm test","description":"running tests"})` —
// which reads like the command leaked into the bar. Per-tool extraction
// picks the one field a user actually cares about.
function formatTaskLabel(name: string, argsJson: string): string {
  let primary: string | undefined;
  try {
    const a = JSON.parse(argsJson) as Record<string, unknown>;
    const pick = (k: string) =>
      typeof a[k] === "string" ? (a[k] as string) : undefined;
    switch (name) {
      case "bash":
        primary = pick("command");
        break;
      case "read_file":
      case "write_file":
      case "edit_file":
        primary = pick("path");
        break;
      case "grep":
      case "glob":
        primary = pick("pattern");
        break;
      case "web_fetch":
        primary = pick("url");
        break;
      case "web_search":
        primary = pick("query");
        break;
      case "task_create":
        primary = pick("subject");
        break;
      case "task_update": {
        const id = pick("id") ?? String(a.id ?? "");
        const status = pick("status");
        primary = status ? `${id} → ${status}` : id;
        break;
      }
    }
  } catch {
    // Falls through to the bare tool name if the args weren't JSON.
  }
  if (!primary) return name;
  return `${name}: ${truncate(primary, 60)}`;
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message ?? e}\n`);
  process.exit(1);
});
