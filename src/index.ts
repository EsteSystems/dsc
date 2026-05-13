import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fsp } from "node:fs";
import { openEditor } from "./editor.js";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  DeepSeekError,
  configPath,
  hasApiKey,
  recordUsage,
  type Message,
  type Model,
} from "./api.js";
import { runAgent, formatCost, formatStatus, estimateContextTokens } from "./agent.js";
import type { ToolContext } from "./tools.js";
import * as history from "./history.js";
import * as approval from "./approval.js";
import * as replHistory from "./repl_history.js";
import * as audit from "./audit.js";
import { compactSession } from "./compact.js";
import { Spinner, StatusBar } from "./ui.js";
import { formatVersionInfo } from "./version.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";

interface Cli {
  model: Model;
  yolo: boolean;
  prompt?: string;
  help?: boolean;
  version?: boolean;
  resume: boolean;
  resumeId?: string;
  modelExplicit: boolean;
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = { model: DEFAULT_MODEL, yolo: false, resume: true, modelExplicit: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yolo" || a === "-y") {
      out.yolo = true;
    } else if (a === "--model" || a === "-m") {
      const v = argv[++i];
      if (!AVAILABLE_MODELS.includes(v as Model)) {
        throw new Error(`unknown model: ${v} (available: ${AVAILABLE_MODELS.join(", ")})`);
      }
      out.model = v as Model;
      out.modelExplicit = true;
    } else if (a === "--no-resume") {
      out.resume = false;
    } else if (a === "--resume") {
      const v = argv[i + 1];
      if (v && !v.startsWith("-")) {
        out.resumeId = v;
        i++;
      }
      out.resume = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--version" || a === "-v") {
      out.version = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length) out.prompt = positional.join(" ");
  return out;
}

function printHelp() {
  process.stdout.write(`dsc — CLI coding agent for DeepSeek

Usage:
  dsc                       Start interactive REPL
  dsc "your prompt here"    One-shot mode: run agent on prompt and exit

Flags:
  -m, --model <name>        Model: ${AVAILABLE_MODELS.join(" | ")} (default: ${DEFAULT_MODEL})
  -y, --yolo                Skip approval prompts for write/edit/bash
      --no-resume           Start a fresh session instead of resuming
      --resume [id]         Resume a session (default: most recent for this cwd)
  -v, --version             Print version (dsc, Node, platform/arch) and exit
  -h, --help                Show this help

API key (in priority order):
  $DEEPSEEK_API_KEY         Env var, takes precedence if set
  ${configPath()}
                            JSON file. Accepted shapes:
                              {"api_key": "sk-..."}
                              {"env": {"DEEPSEEK_API_KEY": "sk-..."}}
                              {"env": {"ANTHROPIC_AUTH_TOKEN": "sk-..."}}  (claude-switcher compat)

REPL commands:
  /clear         Start a new session (current one stays on disk)
  /cost          Show token usage and estimated cost
  /model         Show or switch model (e.g. /model deepseek-v4-flash)
  /yolo          Toggle approval mode
  /reasoning [on|off]
                 Show or hide reasoning_content streamed by thinking models
                 (toggle when no arg)
  /lang [name|off]
                 Force the model to reply exclusively in <name> (e.g. en,
                 ro, fr, Chinese, "formal English"). No arg prints the
                 current setting; 'off' clears the directive.
  /auto-continue [N|off]
                 When the agent hits MAX_TOOL_DEPTH without finishing, auto-grant
                 up to N more budgets instead of stopping. No arg prints the
                 current setting. Initial value comes from DSC_AUTO_CONTINUE
                 env var; default 0 (manual continue).
  /list          List sessions in this cwd
  /save <name>   Give the current session a friendly name (used by /resume
                 and shown in /list).
  /rename <text> Replace the "assistant:" prefix on streamed turns with
                 <text> (a name, glyph, or anything you like). No arg
                 prints the current label; --reset / default restores it.
  /resume <ref>  Resume a session by index from /list, by /save'd name,
                 by id, or 'last' for the most recent.
  /audit [path|show [N]]
                 Default / 'path': print the JSONL audit log path.
                 'show [N]': render the last N entries inline (default 10).
  /queue [clear] Show or clear the type-ahead queue (lines you typed while
                 a turn was running).
  /version       Print dsc + Node + platform versions (useful for bug reports).
  /transcript    Print the full conversation, including any messages that
                 /compact previously archived (kept on disk, not sent to
                 the API).
  /compact [N]   Summarize older turns into a synthetic block (kept in the
                 system prompt) and move them to the archive (visible via
                 /transcript). Keeps the last N user turns verbatim
                 (default N=4). Cumulative across re-runs.
  /edit [text]   Compose the next prompt in $EDITOR (good for paste-heavy
                 or multi-line input). Optional initial text seeds the buffer.
  /exit          Quit

Multi-line input:
  End a line with a single \\ to continue on the next line (bash-style).
  An even number of trailing backslashes is treated as literal.
  For paste-heavy or longer drafts, use /edit.

Audit log:
  Every tool call (bash, edits, reads, fetches, rejections) is recorded
  as one JSON line at ${audit.auditLogPath()}.
  Disable with DSC_NO_AUDIT=1.

Auto-compact:
  When estimated context tokens exceed DSC_AUTO_COMPACT_AT (default 50000;
  set to 0 / off / false to disable), dsc runs /compact 4 automatically
  after the current turn. Manual /compact still works regardless.

Auto-continue:
  When the agent hits MAX_TOOL_DEPTH=24 tool calls in a turn without
  finishing, dsc stops and asks you to type 'continue' to grant another
  budget. Set DSC_AUTO_CONTINUE=N to silently grant up to N extra budgets
  (≈24×N more tool calls) before stopping. Same toggle via /auto-continue.
`);
}

async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${RED}${(e as Error).message}${RESET}\n`);
    process.exit(2);
  }
  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.version) {
    process.stdout.write(formatVersionInfo() + "\n");
    return;
  }

  // Auto-compact threshold (token-count of estimated context). Set to 0 to
  // disable. Default 50K — well below the 1M model limit, but tuned to keep
  // per-turn input cost from creeping. Override via DSC_AUTO_COMPACT_AT.
  const AUTO_COMPACT_AT_TOKENS = (() => {
    const raw = process.env.DSC_AUTO_COMPACT_AT;
    if (!raw) return 50_000;
    if (raw === "0" || raw === "off" || raw === "false") return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 50_000;
  })();
  const AUTO_COMPACT_KEEP = 4;

  // Auto-continue: how many times to silently grant another tool-call
  // budget when the agent hits MAX_TOOL_DEPTH without converging. 0 (default)
  // keeps today's behavior — stop and ask the user to type 'continue'.
  const initialAutoContinue = (() => {
    const raw = process.env.DSC_AUTO_CONTINUE;
    if (!raw) return 0;
    if (raw === "0" || raw === "off" || raw === "false") return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  if (!hasApiKey()) {
    process.stderr.write(`${RED}No DeepSeek API key found.${RESET}\n`);
    process.stderr.write(`Either export DEEPSEEK_API_KEY, or create ${configPath()} containing:\n`);
    process.stderr.write(`  {"api_key": "sk-..."}\n`);
    process.stderr.write(`(also accepts {"env": {"ANTHROPIC_AUTH_TOKEN": "sk-..."}} for claude-switcher compat)\n`);
    process.exit(1);
  }

  const cwd = process.cwd();

  // Migrate old per-cwd file to the new sessions dir if present.
  await history.migrateLegacyIfPresent(cwd, cli.model);

  let session: history.SessionState = history.newSession(cwd, cli.model);
  // The system prompt is rebuilt per turn inside runAgent so cwd/date/status
  // are always current — we no longer persist a stale copy at messages[0].

  let restoredTurns = 0;
  if (cli.resume) {
    let target: history.SessionMeta | null = null;
    if (cli.resumeId) {
      const loaded = await history.loadSession(cli.resumeId);
      if (loaded) {
        session = loaded;
        target = { id: loaded.id } as history.SessionMeta;
      } else {
        process.stderr.write(`${RED}session not found: ${cli.resumeId}${RESET}\n`);
        process.exit(1);
      }
    } else {
      target = await history.mostRecentForCwd(cwd);
      if (target) {
        const loaded = await history.loadSession(target.id);
        if (loaded) session = loaded;
      }
    }
    restoredTurns = session.messages.filter((m) => m.role === "user").length;
  }

  let messages: Message[] = session.messages;
  let stats = session.stats;
  let model: Model = cli.modelExplicit ? cli.model : session.model;

  const toolCtx: ToolContext = {
    cwd,
    yolo: cli.yolo,
    filesTouched: stats.files_touched,
    sessionId: session.id,
  };

  // Single-in-flight, coalescing save. Multiple persist() calls during one
  // save's RTT collapse into one re-save at the end with the latest state.
  // Awaiting persist() returns when *all* queued state is on disk.
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
        } catch (e) {
          process.stderr.write(
            `${DIM}(history save failed: ${(e as Error).message})${RESET}\n`,
          );
        }
      }
      savePromise = null;
    })();
    return savePromise;
  };

  const statusBar = new StatusBar();
  const sessionStart = Date.now();
  let showReasoning = true;
  let autoContinue = initialAutoContinue;
  // Declared up here (before currentStatusLine references it) so the early
  // refreshStatus() right after statusBar.enable doesn't hit the TDZ.
  const promptQueue: string[] = [];
  const currentStatusLine = () =>
    formatStatus(stats, model, {
      yolo: toolCtx.yolo,
      reasoning: showReasoning,
      contextTokens: estimateContextTokens(messages),
      sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
      compacted: !!session.compaction,
      queued: promptQueue.length,
    });
  const refreshStatus = () => statusBar.render(currentStatusLine());

  let pendingAbort: AbortController | null = null;

  const formatApiError = (e: DeepSeekError): string => {
    if (e.status === 401) {
      return `API key rejected (401). Check $DEEPSEEK_API_KEY or ${configPath()}.`;
    }
    if (e.status === 429) return "Rate-limited (429). Try again in a moment.";
    if (e.status === 400 && e.body) {
      let detail = e.body;
      try {
        const parsed = JSON.parse(e.body);
        detail = parsed?.error?.message ?? detail;
      } catch {}
      return `Bad request (400): ${detail}`;
    }
    return e.message;
  };

  const runTurn = async (userText: string) => {
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
          refreshStatus();
          // Make every committed message durable. Coalesces if a save is in
          // flight, so back-to-back tool turns don't queue N saves.
          void persist();
        },
        showReasoning,
        getStatusLine: currentStatusLine,
        getSummary: () => session.compaction?.summary,
        assistantLabel: session.assistantLabel,
        maxAutoContinue: autoContinue,
        language: session.language,
      });
    } catch (e) {
      if ((e as Error).name === "AbortError" || pendingAbort?.signal.aborted) {
        process.stderr.write(`\n${DIM}(interrupted)${RESET}\n`);
      } else if (e instanceof DeepSeekError) {
        process.stderr.write(`\n${RED}${formatApiError(e)}${RESET}\n`);
        if (e.body && e.status !== 400) {
          process.stderr.write(`${DIM}${e.body.slice(0, 1000)}${RESET}\n`);
        }
      } else {
        process.stderr.write(`\n${RED}${(e as Error).message}${RESET}\n`);
      }
    } finally {
      pendingAbort = null;
    }
    // No final refreshStatus here — the last onTurn inside runAgent already
    // printed the post-push status; re-printing would just double the bar.
    await persist();
  };

  // One-shot mode
  if (cli.prompt) {
    await runTurn(cli.prompt);
    process.stdout.write(`\n${DIM}${formatCost(stats, model)}${RESET}\n`);
    return;
  }

  // REPL
  process.stdout.write(`${BOLD}dsc${RESET} ${DIM}(${model}${cli.yolo ? ", yolo" : ""})${RESET}  `);
  process.stdout.write(`${DIM}type /help for commands, ESC to interrupt a turn, Ctrl+D to exit${RESET}\n`);
  if (restoredTurns > 0) {
    process.stdout.write(`${DIM}restored ${restoredTurns}-turn history (use /clear to reset)${RESET}\n`);
  }

  statusBar.enable();
  refreshStatus();
  const cleanup = () => statusBar.disable();
  process.on("exit", cleanup);

  let lastSigintMs = 0;
  process.on("SIGINT", () => {
    if (pendingAbort && !pendingAbort.signal.aborted) {
      pendingAbort.abort();
      return;
    }
    const now = Date.now();
    if (now - lastSigintMs < 1000) {
      cleanup();
      process.exit(130);
    }
    lastSigintMs = now;
    process.stdout.write(`\n${DIM}(press Ctrl+C again within 1s to exit)${RESET}\n`);
  });

  const rl = readline.createInterface({
    input,
    output,
    historySize: 1000,
    completer: completeSlashCommand,
  });

  // Approval calls rl.question — while one is pending, lines that come back
  // are the user's y/N answer, not new prompts. The queue listener checks this
  // flag and stays out of the way so the answer doesn't get queued.
  let approvalActive = false;
  approval.setAsker(async (q) => {
    approvalActive = true;
    try {
      return await rl.question(q);
    } finally {
      approvalActive = false;
    }
  });

  // Type-ahead queue listener: while a turn is running, captured 'line'
  // events get pushed into promptQueue (declared earlier in this function).
  const bufferDuringTurn = (line: string) => {
    if (approvalActive) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    promptQueue.push(trimmed);
    process.stdout.write(
      `${DIM}(queued — ${promptQueue.length} pending)${RESET}\n`,
    );
    refreshStatus();
  };

  // ESC interrupts the current turn — more intuitive than Ctrl+C for "stop
  // what the agent is doing right now". readline already puts stdin in raw
  // mode and emits 'keypress' events for terminal input, so we just listen.
  // Standalone ESC fires after a short disambiguation delay; ESC-prefixed
  // sequences (arrow keys etc) come through as their named keys instead.
  const onKeypress = (_str: string | undefined, key: { name?: string } | undefined) => {
    if (
      key?.name === "escape" &&
      pendingAbort &&
      !pendingAbort.signal.aborted
    ) {
      pendingAbort.abort();
    }
  };
  process.stdin.on("keypress", onKeypress);
  // Also catch readline's own SIGINT path for Ctrl+C — defends against the
  // case where readline intercepts the signal before our process.on handler.
  rl.on("SIGINT", () => {
    if (pendingAbort && !pendingAbort.signal.aborted) {
      pendingAbort.abort();
    }
  });

  // Seed up/down history from disk (newest first per readline's convention).
  void replHistory.compact();
  const past = await replHistory.load();
  const rlAny = rl as unknown as { history: string[] };
  rlAny.history.length = 0;
  rlAny.history.push(...past.slice().reverse());

  while (true) {
    let line: string;
    if (promptQueue.length) {
      // Drain the type-ahead queue before prompting again. Show what we're
      // about to run so the user can tell it's not a fresh prompt.
      line = promptQueue.shift()!;
      process.stdout.write(`${DIM}── from queue:${RESET} ${line}\n`);
      refreshStatus();
    } else {
      try {
        line = await readPromptInput(rl);
      } catch {
        break; // Ctrl+D
      }
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Persist the user's submitted line to the on-disk history file. Slash
    // commands are recorded too — recalling "/resume 3" is useful.
    void replHistory.append(trimmed);

    if (trimmed.startsWith("/")) {
      const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "exit" || cmd === "quit") {
        break;
      } else if (cmd === "help") {
        printHelp();
      } else if (cmd === "clear") {
        // Start a brand-new session; old session stays on disk. System prompt
        // is rebuilt per turn so we don't seed messages with one.
        session = history.newSession(cwd, model);
        messages = session.messages;
        stats = session.stats;
        toolCtx.filesTouched = stats.files_touched;
        toolCtx.sessionId = session.id;
        refreshStatus();
        process.stdout.write(`${DIM}new session started (${session.id})${RESET}\n`);
      } else if (cmd === "list") {
        const all = await history.listSessions(cwd);
        if (!all.length) {
          process.stdout.write(`${DIM}no sessions for ${cwd}${RESET}\n`);
        } else {
          all.forEach((s, i) => {
            const ago = formatRelative(s.updated_at);
            const here = s.id === session.id ? `${BOLD}*${RESET} ` : "  ";
            const label = s.name ? `${BOLD}${s.name}${RESET} (${s.model})` : s.model;
            process.stdout.write(
              `${here}${String(i + 1).padStart(2, " ")}. ${label}  ${ago}  (${s.message_count} msgs)  ${DIM}${s.first_user_message || "—"}${RESET}\n`,
            );
          });
        }
      } else if (cmd === "save") {
        const name = arg.trim();
        if (!name) {
          process.stdout.write(`${RED}usage: /save <name>${RESET}\n`);
        } else {
          session.name = name;
          await persist();
          process.stdout.write(
            `${DIM}session saved as "${name}" (id ${session.id})${RESET}\n`,
          );
        }
      } else if (cmd === "rename") {
        const text = arg.trim();
        if (!text) {
          const cur = session.assistantLabel ?? "assistant:";
          process.stdout.write(`${DIM}assistant label: "${cur}"${RESET}\n`);
        } else if (text === "--reset" || text === "default") {
          delete session.assistantLabel;
          await persist();
          process.stdout.write(`${DIM}assistant label reset to default${RESET}\n`);
        } else {
          session.assistantLabel = text;
          await persist();
          process.stdout.write(`${DIM}assistant label → "${text}"${RESET}\n`);
        }
      } else if (cmd === "resume") {
        const all = await history.listSessions(cwd);
        if (!all.length) {
          process.stdout.write(`${DIM}no sessions to resume${RESET}\n`);
        } else {
          let target: history.SessionMeta | null = null;
          if (!arg || arg === "last") {
            target = all[0];
          } else if (/^\d+$/.test(arg)) {
            const idx = parseInt(arg, 10) - 1;
            target = all[idx] ?? null;
            if (!target) process.stdout.write(`${RED}no session at index ${arg} (have ${all.length})${RESET}\n`);
          } else {
            // Match by name first (most-recent wins on tie since `all` is
            // sorted desc by updated_at), then fall back to id.
            target =
              all.find((s) => s.name === arg) ??
              all.find((s) => s.id === arg) ??
              null;
            if (!target)
              process.stdout.write(
                `${RED}no session with name or id ${arg}${RESET}\n`,
              );
          }
          if (target) {
            const loaded = await history.loadSession(target.id);
            if (!loaded) {
              process.stdout.write(`${RED}failed to load session ${target.id}${RESET}\n`);
            } else {
              session = loaded;
              messages = session.messages;
              stats = session.stats;
              model = session.model;
              toolCtx.filesTouched = stats.files_touched;
              toolCtx.sessionId = session.id;
              refreshStatus();
              const userTurns = messages.filter((m) => m.role === "user").length;
              process.stdout.write(`${DIM}resumed ${session.id} (${userTurns} turns, model ${model})${RESET}\n`);
            }
          }
        }
      } else if (cmd === "cost") {
        process.stdout.write(`${DIM}${formatCost(stats, model)}${RESET}\n`);
      } else if (cmd === "model") {
        if (!arg) {
          process.stdout.write(`${DIM}current model: ${model}${RESET}\n`);
        } else if (!AVAILABLE_MODELS.includes(arg as Model)) {
          process.stdout.write(`${RED}unknown model: ${arg} (available: ${AVAILABLE_MODELS.join(", ")})${RESET}\n`);
        } else {
          model = arg as Model;
          refreshStatus();
          process.stdout.write(`${DIM}model -> ${model}${RESET}\n`);
          await persist();
        }
      } else if (cmd === "yolo") {
        toolCtx.yolo = !toolCtx.yolo;
        refreshStatus();
        process.stdout.write(`${DIM}yolo: ${toolCtx.yolo}${RESET}\n`);
      } else if (cmd === "reasoning") {
        if (arg === "on") showReasoning = true;
        else if (arg === "off") showReasoning = false;
        else showReasoning = !showReasoning; // toggle when no arg
        refreshStatus();
        process.stdout.write(`${DIM}reasoning: ${showReasoning ? "on" : "off"}${RESET}\n`);
      } else if (cmd === "queue") {
        const sub = arg.trim().toLowerCase();
        if (sub === "clear" || sub === "drop") {
          const n = promptQueue.length;
          promptQueue.length = 0;
          refreshStatus();
          process.stdout.write(`${DIM}cleared ${n} queued prompt(s)${RESET}\n`);
        } else if (promptQueue.length === 0) {
          process.stdout.write(`${DIM}queue is empty${RESET}\n`);
        } else {
          promptQueue.forEach((p, i) =>
            process.stdout.write(
              `${DIM}${String(i + 1).padStart(2, " ")}.${RESET} ${p}\n`,
            ),
          );
        }
      } else if (cmd === "lang") {
        const text = arg.trim();
        if (!text) {
          process.stdout.write(
            `${DIM}language: ${session.language ? `"${session.language}"` : "off (any language)"}${RESET}\n`,
          );
        } else if (text === "off" || text === "default" || text === "any") {
          delete session.language;
          await persist();
          process.stdout.write(`${DIM}language directive cleared${RESET}\n`);
        } else {
          session.language = text;
          await persist();
          process.stdout.write(`${DIM}language → "${text}" (replies will be exclusively in this language)${RESET}\n`);
        }
      } else if (cmd === "auto-continue") {
        const trimmed = arg.trim();
        if (!trimmed) {
          process.stdout.write(
            `${DIM}auto-continue: ${autoContinue === 0 ? "off" : `up to ${autoContinue} extra budget(s)`}${RESET}\n`,
          );
        } else if (trimmed === "off" || trimmed === "0" || trimmed === "false") {
          autoContinue = 0;
          process.stdout.write(`${DIM}auto-continue: off${RESET}\n`);
        } else {
          const n = parseInt(trimmed, 10);
          if (!Number.isFinite(n) || n < 0) {
            process.stdout.write(`${RED}usage: /auto-continue [N|off]${RESET}\n`);
          } else {
            autoContinue = n;
            process.stdout.write(
              `${DIM}auto-continue: ${n === 0 ? "off" : `up to ${n} extra budget(s)`}${RESET}\n`,
            );
          }
        }
      } else if (cmd === "version") {
        process.stdout.write(`${DIM}${formatVersionInfo()}${RESET}\n`);
      } else if (cmd === "audit") {
        const sub = arg.trim();
        if (sub.startsWith("show")) {
          const nRaw = sub.replace(/^show\s*/, "").trim();
          const n = nRaw ? parseInt(nRaw, 10) : NaN;
          const limit = Number.isFinite(n) && n > 0 ? n : 10;
          await renderAuditEntries(limit);
        } else if (!sub || sub === "path") {
          process.stdout.write(`${DIM}${audit.auditLogPath()}${RESET}\n`);
        } else {
          process.stdout.write(
            `${RED}usage: /audit | /audit path | /audit show [N]${RESET}\n`,
          );
        }
      } else if (cmd === "transcript") {
        const archived = session.archivedMessages ?? [];
        if (archived.length === 0 && messages.length === 0) {
          process.stdout.write(`${DIM}(no messages)${RESET}\n`);
        } else {
          if (archived.length > 0) {
            process.stdout.write(
              `${DIM}── archived (${archived.length} messages)${RESET}\n`,
            );
            for (const m of archived) renderTranscriptMessage(m, true);
          }
          if (messages.length > 0) {
            process.stdout.write(`${DIM}── active (${messages.length} messages)${RESET}\n`);
            for (const m of messages) renderTranscriptMessage(m, false);
          }
        }
      } else if (cmd === "compact") {
        const keepRaw = arg ? parseInt(arg, 10) : NaN;
        const keep = Number.isFinite(keepRaw) ? Math.max(0, keepRaw) : 4;
        await runCompaction(keep, false);
      } else if (cmd === "edit") {
        const draft = openEditor(arg ? arg + "\n" : "");
        if (draft === null) {
          process.stdout.write(`${RED}editor failed${RESET}\n`);
        } else if (!draft.trim()) {
          process.stdout.write(`${DIM}(empty draft, not sent)${RESET}\n`);
        } else {
          process.stdout.write(`${DIM}── editor draft (${draft.length} chars):${RESET}\n`);
          process.stdout.write(draft.replace(/\n/g, "\n  ") + "\n");
          process.stdout.write(`${DIM}──${RESET}\n`);
          void replHistory.append(draft);
          await runTurnWithHistorySnapshot(draft);
        }
      } else {
        process.stdout.write(`${RED}unknown command: /${cmd}${RESET}\n`);
      }
      continue;
    }

    await runTurnWithHistorySnapshot(trimmed);
  }

  async function runTurnWithHistorySnapshot(text: string): Promise<void> {
    // Snapshot rl.history so approval y/N answers (which readline auto-adds)
    // don't leak into up-arrow recall.
    const histSnapshot = rlAny.history.slice();
    // Listen for 'line' events while the turn runs so type-ahead lands in
    // promptQueue instead of being lost.
    rl.on("line", bufferDuringTurn);
    try {
      await runTurn(text);
    } finally {
      rl.off("line", bufferDuringTurn);
      rlAny.history.length = 0;
      rlAny.history.push(...histSnapshot);
    }
    // After every turn, kick off an auto-compaction if ctx is over budget.
    if (AUTO_COMPACT_AT_TOKENS > 0) {
      const ctx = estimateContextTokens(messages);
      if (ctx > AUTO_COMPACT_AT_TOKENS) {
        await runCompaction(AUTO_COMPACT_KEEP, true);
      }
    }
  }

  async function runCompaction(keep: number, auto: boolean): Promise<void> {
    const beforeMessages = messages.length;
    const beforeChars = messages.reduce(
      (n, m) => n + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    if (auto) {
      process.stdout.write(
        `${DIM}── auto-compact (ctx > ${AUTO_COMPACT_AT_TOKENS} tokens)${RESET}\n`,
      );
    }
    const spinner = new Spinner("compacting");
    spinner.start();
    try {
      const result = await compactSession(session, keep, model);
      spinner.stop();
      if (!result) {
        if (!auto) {
          process.stdout.write(
            `${DIM}nothing to compact (need more than ${keep} user turns)${RESET}\n`,
          );
        }
        return;
      }
      // Move the summarized messages into the on-disk archive so /transcript
      // can still show them. They're no longer sent to the API.
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
      const summaryChars = result.summary.length;
      process.stdout.write(
        `${DIM}compacted ${result.turnsRemoved} user turn(s); messages ${beforeMessages} → ${messages.length}; chars ${beforeChars} → ${afterChars} + ${summaryChars} summary${RESET}\n`,
      );
      refreshStatus();
      await persist();
    } catch (e) {
      spinner.stop();
      if (e instanceof DeepSeekError) {
        process.stderr.write(
          `${RED}compaction failed: ${formatApiError(e)}${RESET}\n`,
        );
      } else {
        process.stderr.write(
          `${RED}compaction failed: ${(e as Error).message}${RESET}\n`,
        );
      }
    }
  }
  approval.setAsker(null);
  process.stdin.removeListener("keypress", onKeypress);
  rl.close();
  statusBar.disable();
  process.stdout.write(`\n${DIM}${formatCost(stats, model)}${RESET}\n`);
}

async function renderAuditEntries(limit: number): Promise<void> {
  let text: string;
  try {
    text = await fsp.readFile(audit.auditLogPath(), "utf8");
  } catch {
    process.stdout.write(`${DIM}(no audit log yet)${RESET}\n`);
    return;
  }
  const lines = text.split("\n").filter((l) => l.length > 0).slice(-limit);
  if (lines.length === 0) {
    process.stdout.write(`${DIM}(empty)${RESET}\n`);
    return;
  }
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof entry.ts === "string" ? entry.ts.slice(11, 19) : "";
    const ok =
      entry.approved === false
        ? `${RED}✗${RESET}`
        : entry.error
          ? `${RED}!${RESET}`
          : `${DIM}✓${RESET}`;
    const tool = String(entry.tool ?? "?");
    const summary = summarizeAuditEntry(entry);
    process.stdout.write(
      `${DIM}${ts}${RESET}  ${ok} ${BOLD}${tool.padEnd(11)}${RESET}  ${summary}\n`,
    );
  }
}

function summarizeAuditEntry(e: Record<string, unknown>): string {
  const trim = (v: unknown, n = 80): string => {
    const s = typeof v === "string" ? v : "";
    return s.length <= n ? s : s.slice(0, n) + "…";
  };
  switch (e.tool) {
    case "bash":
      return trim(e.command, 100);
    case "write_file":
    case "edit_file":
    case "read_file":
      return trim(e.path);
    case "grep":
      return `"${trim(e.pattern, 40)}" in ${trim(e.path, 40)}`;
    case "glob":
      return trim(e.pattern);
    case "web_search":
      return `"${trim(e.query, 80)}"`;
    case "web_fetch":
      return trim(e.url, 100);
    default:
      return "";
  }
}

// Slash commands the REPL recognizes. Used both for tab completion and as
// a single source of truth for what's accepted (kept in sync with the if/
// else chain in main()).
const SLASH_COMMANDS: ReadonlyArray<string> = [
  "audit",
  "auto-continue",
  "clear",
  "compact",
  "cost",
  "edit",
  "exit",
  "help",
  "lang",
  "list",
  "model",
  "queue",
  "quit",
  "reasoning",
  "rename",
  "resume",
  "save",
  "transcript",
  "version",
  "yolo",
];

// readline-style completer: returns [matches, substringMatched]. We complete
// the slash-command name only; subcommand args (e.g. /resume <name>) are not
// completed yet — keep it simple and predictable.
function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const partial = line.slice(1);
  if (partial.includes(" ")) return [[], line]; // past the command word
  const matches = SLASH_COMMANDS.filter((c) => c.startsWith(partial)).map(
    (c) => "/" + c,
  );
  return [matches, line];
}

function renderTranscriptMessage(m: Message, archived: boolean): void {
  const tag = archived ? `${DIM}archived${RESET} ` : "";
  const role = m.role;
  const color =
    role === "user" ? "\x1b[36m" : role === "assistant" ? "\x1b[35m" : DIM;
  const content = typeof m.content === "string" ? m.content : "";
  process.stdout.write(`\n${tag}${BOLD}${color}${role}${RESET}\n`);
  if (m.tool_calls && m.tool_calls.length) {
    for (const tc of m.tool_calls) {
      process.stdout.write(
        `${DIM}  → ${tc.function.name}(${truncateForTranscript(tc.function.arguments, 200)})${RESET}\n`,
      );
    }
  }
  if (m.tool_call_id) {
    process.stdout.write(`${DIM}  ← tool_call_id: ${m.tool_call_id}${RESET}\n`);
  }
  if (content) process.stdout.write(content + "\n");
}

function truncateForTranscript(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
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

/**
 * Read one logical user prompt, supporting bash-style backslash continuation:
 * an odd number of trailing backslashes on a submitted line means "continue
 * on the next line"; the last backslash is consumed and replaced with a
 * literal newline. An even count (e.g. \\) is treated as literal trailing
 * backslashes and the line submits.
 */
async function readPromptInput(rl: readline.Interface): Promise<string> {
  const FIRST = `${BOLD}> ${RESET}`;
  const CONT = `${DIM}… ${RESET}`;
  let buf = "";
  let prompt = FIRST;
  while (true) {
    const line = await rl.question(prompt);
    const trailing = (line.match(/\\+$/) || [""])[0].length;
    if (trailing % 2 === 1) {
      buf += line.slice(0, -1) + "\n";
      prompt = CONT;
      continue;
    }
    buf += line;
    return buf;
  }
}

/**
 * Open $EDITOR (preferring $VISUAL) on a temp .md file seeded with `initial`.
 * Returns the file's contents on save, or null if the editor failed to launch.
 * Empty/whitespace-only results are returned as "" so the caller can decide
 * whether to skip the turn.
 */
main().catch((e) => {
  process.stderr.write(`${RED}fatal: ${(e as Error).message}${RESET}\n`);
  process.exit(1);
});
