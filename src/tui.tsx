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
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  DeepSeekError,
  apiKeySource,
  computeCostUsd,
  configPath,
  hasApiKey,
  recordUsage,
  saveApiKey,
  saveSearchKey,
  saveSearchProvider,
  type Message,
  type Model,
} from "./api.js";
import { getProvider, getProviderKey } from "./search.js";
import { loadInstructions } from "./instructions.js";
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
import * as history from "./history.js";
import * as approval from "./approval.js";
import * as audit from "./audit.js";
import * as replHistory from "./repl_history.js";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { compactSession } from "./compact.js";
import { formatVersionInfo } from "./version.js";
import { openEditor } from "./editor.js";
import {
  addLocalBinToShellRc,
  checkForUpdate,
  localBinOnPath,
  runUpdate,
  setUserNpmPrefix,
  shellRcPath,
} from "./update.js";
import { copyToClipboard } from "./clipboard.js";

const AUTO_COMPACT_AT_TOKENS = Number(process.env.DSC_AUTO_COMPACT ?? "0") || 0;
const AUTO_COMPACT_KEEP = Number(process.env.DSC_AUTO_COMPACT_KEEP ?? "4") || 4;

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
      if (!AVAILABLE_MODELS.includes(v as Model)) {
        throw new CliError(
          `unknown model: ${v} (available: ${AVAILABLE_MODELS.join(", ")})`,
        );
      }
      out.model = v as Model;
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
        "dsc — CLI coding agent for DeepSeek",
        "",
        "Usage:",
        "  dsc                            Start the TUI",
        "  dsc \"your prompt here\"         One-shot: run and exit",
        "",
        "Flags:",
        "  -m, --model <name>             " + AVAILABLE_MODELS.join(" | "),
        "  -y, --yolo                     Skip approval prompts",
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
  const initialAutoContinue = Number(process.env.DSC_AUTO_CONTINUE ?? "0") || 0;

  const toolCtx: ToolContext = {
    cwd,
    yolo: !!cli.yolo,
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
    mcpConnections.flatMap((c) => c.tools);
  const mcpDispatch = (name: string, args: Record<string, unknown>) =>
    callMCPTool(mcpConnections, name, args);

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
  const promptQueue: string[] = [];

  // Push the freshly-computed numbers into the store; StatusBar reads from
  // there. Called after every onTurn and once per second for the timer.
  const syncStatus = () => {
    setState({
      model,
      contextTokens: estimateContextTokens(messages),
      sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
      inTokens: stats.prompt_tokens,
      outTokens: stats.completion_tokens,
      cacheHitTokens: stats.cache_hit_tokens,
      cacheMissTokens: stats.cache_miss_tokens,
      toolCalls: stats.tool_calls_total,
      queue: promptQueue.slice(),
      queueDepth: promptQueue.length,
      compacted: !!session.compaction,
      cost: computeCostUsd(stats, model),
    });
  };

  setState({
    model,
    yolo: toolCtx.yolo,
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
    // Push the user message into history immediately so it's visible before
    // the model responds.
    setState((s) => ({
      history: [
        ...s.history,
        { id: `u-${s.history.length}`, role: "user", content: userText },
      ],
      busy: true,
    }));
    messages.push({ role: "user", content: userText });
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
  const handleSlash = async (line: string): Promise<boolean> => {
    if (!line.startsWith("/")) return false;
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ");

    switch (cmd) {
      case "exit":
      case "quit":
        clearInterval(timerId);
        process.exit(0);
        return true;
      case "help":
        info(
          [
            "/help                   show this help",
            "/clear                  start a new session",
            "/list                   list sessions for this cwd",
            "/resume [n|name|id]     resume a session",
            "/save <name>            name the current session",
            "/rename <text>          set assistant label for this session",
            "/model [name]           show or switch model",
            "/yolo                   toggle approval mode",
            "/reasoning [on|off]     toggle reasoning display",
            "/lang [name|off]        force the model to reply in a language",
            "/auto-continue [N|off]  auto-grant N extra MAX_TOOL_DEPTH budgets",
            "/cost                   show token usage and cost",
            "/copy                   copy last assistant response to clipboard",
            "/version                show version info",
            "/instructions           list active per-project / per-user instruction overlays",
            "/mcp                    list connected MCP servers and their tools",
            "/compact [keep]         summarize old turns (default keep=4)",
            "/transcript             dump full message log",
            "/audit [path|show N]    audit log info",
            "/queue [clear]          list or clear queued prompts",
            "/export [path]          write current session JSON for transfer",
            "/import <path>          load session JSON; rebinds cwd here (--keep-cwd to skip)",
            "/api-key [key]          show source / save api key to config file",
            "/search [use|key] …     show / switch search provider / save brave|tavily key",
            "/update                 check npm for a newer dsc and install it",
            "/exit                   exit",
          ].join("\n"),
        );
        return true;
      case "clear":
        session = history.newSession(cwd, model);
        messages = session.messages;
        stats = session.stats;
        toolCtx.filesTouched = stats.files_touched;
        toolCtx.sessionId = session.id;
        // Per-tool always-approval is conversation-scoped, so /clear has
        // to drop it — otherwise the user would carry over implicit trust
        // they made to a session they just walked away from.
        toolCtx.sessionApprovals = new Set();
        setState({ history: [], current: null });
        info(`new session started (${session.id})`);
        syncStatus();
        return true;
      case "list": {
        const all = await history.listSessions(cwd);
        if (!all.length) {
          info(`no sessions for ${cwd}`);
        } else {
          info(
            all
              .map((s, i) => {
                const here = s.id === session.id ? "* " : "  ";
                const label = s.name ? `${s.name} (${s.model})` : s.model;
                return `${here}${String(i + 1).padStart(2, " ")}. ${label}  ${formatRelative(s.updated_at)}  (${s.message_count} msgs)  ${s.first_user_message || "—"}`;
              })
              .join("\n"),
          );
        }
        return true;
      }
      case "save":
        if (!arg.trim()) {
          info("error: usage: /save <name>");
        } else {
          session.name = arg.trim();
          await persist();
          info(`session saved as "${session.name}" (id ${session.id})`);
        }
        return true;
      case "rename": {
        const text = arg.trim();
        if (!text) {
          info(`assistant label: "${session.assistantLabel ?? "assistant:"}"`);
        } else if (text === "--reset" || text === "default") {
          delete session.assistantLabel;
          setState({ assistantLabel: "assistant:" });
          await persist();
          info("assistant label reset to default");
        } else {
          session.assistantLabel = text;
          setState({ assistantLabel: text });
          await persist();
          info(`assistant label → "${text}"`);
        }
        return true;
      }
      case "resume": {
        const all = await history.listSessions(cwd);
        if (!all.length) {
          info("no sessions to resume");
          return true;
        }
        let target: history.SessionMeta | null = null;
        if (!arg || arg === "last") {
          target = all[0];
        } else if (/^\d+$/.test(arg)) {
          target = all[parseInt(arg, 10) - 1] ?? null;
          if (!target) info(`error: no session at index ${arg} (have ${all.length})`);
        } else {
          target =
            all.find((s) => s.name === arg) ??
            all.find((s) => s.id === arg) ??
            null;
          if (!target) info(`error: no session with name or id ${arg}`);
        }
        if (target) {
          const loaded = await history.loadSession(target.id);
          if (!loaded) {
            info(`error: failed to load session ${target.id}`);
          } else {
            session = loaded;
            messages = session.messages;
            stats = session.stats;
            model = session.model;
            toolCtx.filesTouched = stats.files_touched;
            toolCtx.sessionId = session.id;
            const userTurns = messages.filter((m) => m.role === "user").length;
            // Rebuild history view from the resumed session.
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
            setState({ history: restored, current: null, model });
            syncStatus();
            info(`resumed ${session.id} (${userTurns} turns, model ${model})`);
          }
        }
        return true;
      }
      case "cost":
        info(formatCost(stats, model));
        return true;
      case "copy": {
        // Copy the most recent assistant response to the OS clipboard. The
        // last *assistant* (not tool, not system, not user) is what the
        // user usually wants — the actual answer text.
        const state = getState();
        let target: UIMessage | undefined;
        for (let i = state.history.length - 1; i >= 0; i--) {
          const m = state.history[i];
          if (m.role === "assistant" && m.content) {
            target = m;
            break;
          }
        }
        if (!target) {
          info("no assistant message to copy");
          return true;
        }
        try {
          await copyToClipboard(target.content);
          info(`copied ${target.content.length} chars to clipboard`);
        } catch (e) {
          info(`error: ${(e as Error).message}`);
        }
        return true;
      }
      case "model":
        if (!arg) {
          info(`current model: ${model}`);
        } else if (!AVAILABLE_MODELS.includes(arg as Model)) {
          info(`error: unknown model: ${arg} (available: ${AVAILABLE_MODELS.join(", ")})`);
        } else {
          model = arg as Model;
          syncStatus();
          info(`model → ${model}`);
          await persist();
        }
        return true;
      case "yolo":
        toolCtx.yolo = !toolCtx.yolo;
        setState({ yolo: toolCtx.yolo });
        info(`yolo: ${toolCtx.yolo}`);
        return true;
      case "reasoning": {
        const cur = getState().reasoning;
        const next = arg === "on" ? true : arg === "off" ? false : !cur;
        setState({ reasoning: next });
        info(`reasoning: ${next ? "on" : "off"}`);
        return true;
      }
      case "queue": {
        const sub = arg.trim().toLowerCase();
        if (sub === "clear" || sub === "drop") {
          const n = promptQueue.length;
          promptQueue.length = 0;
          syncStatus();
          info(`cleared ${n} queued prompt(s)`);
        } else if (promptQueue.length === 0) {
          info("queue is empty");
        } else {
          info(
            promptQueue
              .map((p, i) => `${String(i + 1).padStart(2, " ")}. ${p}`)
              .join("\n"),
          );
        }
        return true;
      }
      case "lang": {
        const text = arg.trim();
        if (!text) {
          info(
            `language: ${session.language ? `"${session.language}"` : "off (any language)"}`,
          );
        } else if (text === "off" || text === "default" || text === "any") {
          delete session.language;
          setState({ language: undefined });
          await persist();
          info("language directive cleared");
        } else {
          session.language = text;
          setState({ language: text });
          await persist();
          info(
            `language → "${text}" (replies will be exclusively in this language)`,
          );
        }
        return true;
      }
      case "auto-continue": {
        const t = arg.trim();
        if (!t) {
          const n = getState().autoContinue;
          info(`auto-continue: ${n === 0 ? "off" : `up to ${n} extra budget(s)`}`);
        } else if (t === "off" || t === "0" || t === "false") {
          setState({ autoContinue: 0 });
          info("auto-continue: off");
        } else {
          const n = parseInt(t, 10);
          if (!Number.isFinite(n) || n < 0) {
            info("error: usage: /auto-continue [N|off]");
          } else {
            setState({ autoContinue: n });
            info(
              `auto-continue: ${n === 0 ? "off" : `up to ${n} extra budget(s)`}`,
            );
          }
        }
        return true;
      }
      case "version":
        info(formatVersionInfo());
        return true;
      case "mcp": {
        // Status / inspection only for now — connections are established
        // at boot. Future: subcommands for reconnect, disable, etc.
        if (mcpConnections.length === 0) {
          info(
            [
              "No MCP servers connected.",
              "",
              "To wire one in, add an `mcp.servers` block to your config:",
              `  ${configPath()}`,
              "",
              "Example (Tavily remote MCP):",
              '  "mcp": {',
              '    "servers": {',
              '      "tavily": {',
              '        "url": "https://mcp.tavily.com/mcp/",',
              '        "headers": { "Authorization": "Bearer ${TAVILY_API_KEY}" }',
              "      }",
              "    }",
              "  }",
              "",
              "Restart dsc after editing — connections are made at boot.",
            ].join("\n"),
          );
          return true;
        }
        const lines: string[] = [];
        for (const c of mcpConnections) {
          lines.push(`── ${c.name} ──`);
          for (const t of c.tools) {
            // t.function.name is namespaced (mcp_<server>_<tool>); strip
            // the prefix for readability.
            const short = t.function.name.replace(/^mcp_[^_]+_/, "");
            lines.push(`  ${short}: ${t.function.description ?? ""}`);
          }
        }
        info(lines.join("\n"));
        return true;
      }
      case "instructions": {
        // Show every overlay the agent currently sees, in the order they
        // appear in the system prompt. Resolved fresh per call so edits
        // since launch are reflected without restarting dsc.
        const overlays = loadInstructions(cwd);
        if (overlays.length === 0) {
          info(
            [
              "No instruction overlays found. dsc looks for:",
              "  ~/.config/dsc/instructions.md  (user-global)",
              "  AGENTS.md                      (project, walked up from cwd)",
              "  .dsc/instructions.md           (project, dsc-specific)",
              "Create any of these to teach the agent project conventions.",
            ].join("\n"),
          );
          return true;
        }
        const sections = overlays.map((ov) => {
          const label =
            ov.kind === "user"
              ? "user"
              : ov.kind === "agents"
                ? "AGENTS.md"
                : ".dsc/instructions.md";
          const lines = ov.content.split("\n");
          const head = lines.slice(0, 20);
          const tail =
            lines.length > 20
              ? `\n… (${lines.length - 20} more lines)`
              : "";
          return `── ${label} @ ${ov.path} ──\n${head.join("\n")}${tail}`;
        });
        info(sections.join("\n\n"));
        return true;
      }
      case "update": {
        // Two-phase: check first so we don't run npm install when we're
        // already current. Force-fetches the latest (ignores the 24h cache
        // because the user explicitly asked) and reports either way.
        info("checking npm for a newer version…");
        try {
          const check = await checkForUpdate({ force: true });
          if (!check.newerAvailable) {
            info(`up to date (${check.current})`);
            return true;
          }
          info(
            `installing ${check.latest} (currently ${check.current}) via npm…`,
          );
          let r = await runUpdate();
          // Auto-recover from EACCES on Linux/macOS: offer to set
          // npm's prefix under ~/.local so the install doesn't need
          // sudo, optionally append the PATH export to the user's
          // shell rc, then retry. The user approves each step.
          const isPermError = /EACCES|EPERM|permission/.test(r.output);
          if (
            !r.ok &&
            isPermError &&
            process.platform !== "win32"
          ) {
            const ans = await approval.confirm({
              title: "Permission error installing dsc",
              body:
                `npm install -g hit a permission error (likely because npm's prefix is system-owned).` +
                `\n\nDurable fix: set npm's global prefix to ~/.local. After this, all` +
                `\n\`npm install -g\` and \`/update\` runs work without sudo.` +
                `\n\nDsc will:` +
                `\n  1. mkdir -p ~/.local/{bin,lib}` +
                `\n  2. npm config set prefix ~/.local` +
                `\n  3. retry the install`,
              question: "Configure user prefix and retry? [y]es / [n]o (Esc rejects) ",
            });
            if (ans !== "no") {
              try {
                const dir = await setUserNpmPrefix();
                info(`set npm prefix to ${dir}; retrying install…`);
                r = await runUpdate();
                if (r.ok && !localBinOnPath()) {
                  const rc = shellRcPath();
                  if (rc) {
                    const pathAns = await approval.confirm({
                      title: "Add ~/.local/bin to PATH",
                      body:
                        `dsc now lives at ~/.local/bin/dsc but that directory isn't on your PATH.` +
                        `\n\nDsc can append the export line to:` +
                        `\n  ${rc}` +
                        `\n\nYou'll need to open a new terminal (or \`source\` the file) for it to take effect.`,
                      question: `Append PATH export to ${rc}? [y]es / [n]o (Esc rejects) `,
                    });
                    if (pathAns !== "no") {
                      try {
                        const edited = await addLocalBinToShellRc();
                        if (edited) {
                          info(
                            `appended PATH export to ${edited}. Open a new terminal or run:` +
                              `\n  source ${edited}`,
                          );
                        } else {
                          info(`(${rc} already has ~/.local/bin in PATH; no edit needed)`);
                        }
                      } catch (e) {
                        info(`error appending to ${rc}: ${(e as Error).message}`);
                      }
                    } else {
                      info(
                        `Add this line to your shell rc manually:\n  export PATH="$HOME/.local/bin:$PATH"`,
                      );
                    }
                  } else {
                    info(
                      `Couldn't autodetect your shell rc. Add this line manually:` +
                        `\n  export PATH="$HOME/.local/bin:$PATH"`,
                    );
                  }
                }
              } catch (e) {
                info(`error: prefix setup failed: ${(e as Error).message}`);
              }
            }
          }
          if (!r.ok) {
            // Either non-permission failure, or the user declined the
            // auto-recovery, or the retry itself failed. Surface npm's
            // own output verbatim — it usually points at the cause.
            const tail =
              isPermError && process.platform !== "win32"
                ? `\n\nQuick one-off if you'd rather: sudo npm install -g @este.systems/dsc@latest`
                : "";
            info(`error: update failed\n${r.output.slice(-1500)}${tail}`);
            return true;
          }
          info(
            `installed ${check.latest}. Exit and re-run \`dsc\` to pick up the new version.`,
          );
        } catch (e) {
          info(`error: update failed: ${(e as Error).message}`);
        }
        return true;
      }
      case "api-key": {
        const text = arg.trim();
        if (!text) {
          // No arg: show where the key is configured (don't print the key
          // itself; that's not the kind of thing /command output should
          // splash to scrollback).
          const src = apiKeySource();
          if (src === "env") {
            info("api key: set via $DEEPSEEK_API_KEY (env)");
          } else if (src === "file") {
            info(`api key: stored in ${configPath()}`);
          } else {
            info(
              `api key: not set\nGet one at https://platform.deepseek.com/api_keys, then run /api-key <key> (or export DEEPSEEK_API_KEY in your shell).`,
            );
          }
          return true;
        }
        try {
          const written = await saveApiKey(text);
          info(`api key saved to ${written}`);
        } catch (e) {
          info(`error: ${(e as Error).message}`);
        }
        return true;
      }
      case "search": {
        // /search                          -> full status
        // /search use <provider>           -> set active provider in config
        // /search key <provider>           -> show that provider's status + URL
        // /search key <provider> <key>     -> save it to config
        const SIGNUP: Record<"brave" | "tavily", string> = {
          brave: "https://api-dashboard.search.brave.com/app/keys",
          tavily: "https://app.tavily.com/",
        };
        const ENV_KEY: Record<"brave" | "tavily", string> = {
          brave: "BRAVE_API_KEY",
          tavily: "TAVILY_API_KEY",
        };
        const keySourceFor = (p: "brave" | "tavily"): "env" | "file" | null => {
          if (process.env[ENV_KEY[p]]) return "env";
          return getProviderKey(p) ? "file" : null;
        };
        const keyStatusLine = (p: "brave" | "tavily"): string => {
          const src = keySourceFor(p);
          const status =
            src === "env"
              ? `set via $${ENV_KEY[p]}`
              : src === "file"
                ? "stored in config"
                : "not set";
          return `  ${p}: ${status}  —  ${SIGNUP[p]}`;
        };

        const tokens = arg.trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0];

        // No subcommand: full status.
        if (!sub) {
          const active = getProvider();
          const activeSrc = process.env.DSC_SEARCH_PROVIDER
            ? "set via $DSC_SEARCH_PROVIDER"
            : "from config";
          info(
            [
              `active provider: ${active}  (${activeSrc})`,
              "",
              "keys:",
              keyStatusLine("brave"),
              keyStatusLine("tavily"),
              "  ddg: no key needed (DuckDuckGo HTML scrape)",
              "",
              "Subcommands:",
              "  /search use <brave|tavily|ddg>      switch active provider",
              "  /search key <provider> [key]        show or save api key",
            ].join("\n"),
          );
          return true;
        }

        if (sub === "use") {
          const name = tokens[1];
          if (!name || (name !== "brave" && name !== "tavily" && name !== "ddg")) {
            info("error: usage: /search use <brave|tavily|ddg>");
            return true;
          }
          try {
            const written = await saveSearchProvider(name);
            // Warn the user if they just selected a provider whose key
            // isn't configured — they'll otherwise hit a 401 on the next
            // web_search and wonder why.
            const needsKey = name === "brave" || name === "tavily";
            const haveKey = needsKey ? !!keySourceFor(name) : true;
            const warn = needsKey && !haveKey
              ? `\n(warning) ${name} has no key set. Run: /search key ${name} <key>`
              : "";
            info(`active search provider → ${name}  (saved to ${written})${warn}`);
          } catch (e) {
            info(`error: ${(e as Error).message}`);
          }
          return true;
        }

        if (sub === "key") {
          const name = tokens[1];
          const keyValue = tokens.slice(2).join(" ");
          if (!name || (name !== "brave" && name !== "tavily")) {
            info("error: usage: /search key <brave|tavily> [key]");
            return true;
          }
          if (!keyValue) {
            info(
              `${name}: ${keySourceFor(name) ?? "not set"}\nsignup: ${SIGNUP[name]}`,
            );
            return true;
          }
          try {
            const written = await saveSearchKey(name, keyValue);
            info(`${name} key saved to ${written}`);
          } catch (e) {
            info(`error: ${(e as Error).message}`);
          }
          return true;
        }

        info(
          `error: unknown subcommand '${sub}' (expected: use | key, or no arg for status)`,
        );
        return true;
      }
      case "audit": {
        const sub = arg.trim();
        if (!sub || sub === "path") {
          info(audit.auditLogPath());
        } else if (sub.startsWith("show")) {
          const nRaw = sub.replace(/^show\s*/, "").trim();
          const limit = (() => {
            const n = nRaw ? parseInt(nRaw, 10) : NaN;
            return Number.isFinite(n) && n > 0 ? n : 10;
          })();
          try {
            const text = await fsp.readFile(audit.auditLogPath(), "utf8");
            const lines = text.split("\n").filter((l) => l.length > 0).slice(-limit);
            info(lines.length ? lines.join("\n") : "(empty)");
          } catch {
            info("(no audit log yet)");
          }
        } else {
          info("error: usage: /audit | /audit path | /audit show [N]");
        }
        return true;
      }
      case "transcript": {
        const archived = session.archivedMessages ?? [];
        if (archived.length === 0 && messages.length === 0) {
          info("(no messages)");
          return true;
        }
        const lines: string[] = [];
        const renderMsg = (m: Message, isArchived: boolean) => {
          const tag = isArchived ? "archived " : "";
          lines.push(`\n${tag}${m.role}`);
          if (m.tool_calls && m.tool_calls.length) {
            for (const tc of m.tool_calls) {
              lines.push(`  → ${tc.function.name}(${truncate(tc.function.arguments, 200)})`);
            }
          }
          if (m.tool_call_id) lines.push(`  ← tool_call_id: ${m.tool_call_id}`);
          if (typeof m.content === "string" && m.content) lines.push(m.content);
        };
        if (archived.length) {
          lines.push(`── archived (${archived.length} messages)`);
          for (const m of archived) renderMsg(m, true);
        }
        if (messages.length) {
          lines.push(`── active (${messages.length} messages)`);
          for (const m of messages) renderMsg(m, false);
        }
        info(lines.join("\n"));
        return true;
      }
      case "compact": {
        const keepRaw = arg ? parseInt(arg, 10) : NaN;
        const keep = Number.isFinite(keepRaw) ? Math.max(0, keepRaw) : 4;
        await runCompaction(keep, false);
        return true;
      }
      case "export": {
        // `/export [path]` — writes the current session JSON. Relative
        // paths resolve against the launch cwd, not against the session's
        // recorded cwd, so it lands where the user actually is. Default
        // target is the cwd, named after /save'd name (or id) and date.
        const dest = arg.trim() || ".";
        const absDest = path.isAbsolute(dest) ? dest : path.resolve(cwd, dest);
        try {
          await persist(); // flush any pending writes before export
          const written = await history.exportSession(session.id, absDest);
          info(`exported to ${written}`);
        } catch (e) {
          info(`error: export failed: ${(e as Error).message}`);
        }
        return true;
      }
      case "import": {
        // `/import <path>` — reads a session JSON, rebinds its cwd to the
        // current directory so auto-resume picks it up here, and loads it
        // as the active session immediately. Keep the previous cwd with
        // `--keep-cwd` (positional flag, kept simple).
        const tokens = arg.trim().split(/\s+/).filter(Boolean);
        const keepCwd = tokens.includes("--keep-cwd");
        const file = tokens.find((t) => !t.startsWith("--"));
        if (!file) {
          info("error: usage: /import <path> [--keep-cwd]");
          return true;
        }
        const absFile = path.isAbsolute(file) ? file : path.resolve(cwd, file);
        try {
          const loaded = await history.importSession(absFile, {
            rebindCwd: keepCwd ? undefined : cwd,
          });
          session = loaded;
          messages = session.messages;
          stats = session.stats;
          model = session.model;
          toolCtx.filesTouched = stats.files_touched;
          toolCtx.sessionId = session.id;
          // Refill the visible history so the user sees the imported
          // conversation right away (same logic the /resume path uses).
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
          setState({ history: restored, current: null, model });
          syncStatus();
          const userTurns = messages.filter((m) => m.role === "user").length;
          const cwdNote = keepCwd ? "" : " (cwd rebound to here)";
          info(
            `imported ${session.id} (${userTurns} turns, model ${model})${cwdNote}`,
          );
        } catch (e) {
          info(`error: import failed: ${(e as Error).message}`);
        }
        return true;
      }
      case "edit": {
        // ink owns the terminal — unmount before spawning $EDITOR so the
        // editor gets a clean screen. We also clear `history` before the
        // unmount, otherwise the freshly-rendered <Static> after remount
        // would emit all prior turns to scrollback a second time. The
        // already-printed scrollback above stays untouched.
        const initial = arg ? arg + "\n" : "";
        setState({ history: [] });
        inkInstance?.unmount();
        const draft = openEditor(initial);
        mountApp();
        if (draft === null) {
          info("error: editor failed");
        } else if (!draft.trim()) {
          info("(empty draft, not sent)");
        } else {
          handleSubmit(draft);
        }
        return true;
      }
      default:
        info(`error: unknown command: /${cmd}`);
        return true;
    }
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
    promptQueue.push(text);
    syncStatus();
    void drain();
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
    messages.push({ role: "user", content: cli.prompt });
    pendingAbort = new AbortController();
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
        // No events: agent writes its assistant header, content, tool
        // arrows, and notices directly to stdout — same as REPL one-shot.
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError" && !pendingAbort?.signal.aborted) {
        process.stderr.write(
          `\n${(e as Error).message ?? "error"}\n`,
        );
      }
    }
    await persist();
    process.stdout.write(`\n${formatCost(stats, model)}\n`);
    process.exit(0);
  }

  mountApp();

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
      "Welcome to dsc — a CLI coding agent for DeepSeek.",
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

function formatRelative(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message ?? e}\n`);
  process.exit(1);
});
