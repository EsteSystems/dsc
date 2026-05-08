import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  DeepSeekError,
  configPath,
  hasApiKey,
  type Message,
  type Model,
} from "./api.js";
import { runAgent, formatCost, formatStatus, estimateContextTokens } from "./agent.js";
import type { ToolContext } from "./tools.js";
import * as history from "./history.js";
import * as approval from "./approval.js";
import * as replHistory from "./repl_history.js";
import * as audit from "./audit.js";
import { StatusBar } from "./ui.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";

interface Cli {
  model: Model;
  yolo: boolean;
  prompt?: string;
  help?: boolean;
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
  process.stdout.write(`dsc — Claude-Code-style CLI for DeepSeek

Usage:
  dsc                       Start interactive REPL
  dsc "your prompt here"    One-shot mode: run agent on prompt and exit

Flags:
  -m, --model <name>        Model: ${AVAILABLE_MODELS.join(" | ")} (default: ${DEFAULT_MODEL})
  -y, --yolo                Skip approval prompts for write/edit/bash
      --no-resume           Start a fresh session instead of resuming
      --resume [id]         Resume a session (default: most recent for this cwd)
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
  /list          List sessions in this cwd
  /resume <#>    Resume a session by index from /list (or 'last')
  /audit         Print where the JSONL audit log lives
  /exit          Quit

Audit log:
  Every tool call (bash, edits, reads, fetches, rejections) is recorded
  as one JSON line at ${audit.auditLogPath()}.
  Disable with DSC_NO_AUDIT=1.
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

  const persist = async () => {
    try {
      session.model = model;
      session.messages = messages;
      session.stats = stats;
      await history.saveSession(session);
    } catch (e) {
      process.stderr.write(`${DIM}(history save failed: ${(e as Error).message})${RESET}\n`);
    }
  };

  const statusBar = new StatusBar();
  const sessionStart = Date.now();
  let showReasoning = true;
  const currentStatusLine = () =>
    formatStatus(stats, model, {
      yolo: toolCtx.yolo,
      reasoning: showReasoning,
      contextTokens: estimateContextTokens(messages),
      sessionSeconds: Math.floor((Date.now() - sessionStart) / 1000),
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
        onTurn: refreshStatus,
        showReasoning,
        getStatusLine: currentStatusLine,
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
    refreshStatus();
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
  process.stdout.write(`${DIM}type /help for commands, Ctrl+D to exit${RESET}\n`);
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

  const rl = readline.createInterface({ input, output, historySize: 1000 });
  approval.setAsker((q) => rl.question(q));

  // Seed up/down history from disk (newest first per readline's convention).
  void replHistory.compact();
  const past = await replHistory.load();
  const rlAny = rl as unknown as { history: string[] };
  rlAny.history.length = 0;
  rlAny.history.push(...past.slice().reverse());

  while (true) {
    let line: string;
    try {
      line = await rl.question(`${BOLD}> ${RESET}`);
    } catch {
      break; // Ctrl+D
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
            process.stdout.write(
              `${here}${String(i + 1).padStart(2, " ")}. ${s.model}  ${ago}  (${s.message_count} msgs)  ${DIM}${s.first_user_message || "—"}${RESET}\n`,
            );
          });
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
            target = all.find((s) => s.id === arg) ?? null;
            if (!target) process.stdout.write(`${RED}no session with id ${arg}${RESET}\n`);
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
      } else if (cmd === "audit") {
        process.stdout.write(`${DIM}${audit.auditLogPath()}${RESET}\n`);
      } else {
        process.stdout.write(`${RED}unknown command: /${cmd}${RESET}\n`);
      }
      continue;
    }

    // Snapshot rl.history so approval y/N answers (which readline auto-adds)
    // don't leak into up-arrow recall.
    const histSnapshot = rlAny.history.slice();
    try {
      await runTurn(trimmed);
    } finally {
      rlAny.history.length = 0;
      rlAny.history.push(...histSnapshot);
    }
  }
  approval.setAsker(null);
  rl.close();
  statusBar.disable();
  process.stdout.write(`\n${DIM}${formatCost(stats, model)}${RESET}\n`);
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
  process.stderr.write(`${RED}fatal: ${(e as Error).message}${RESET}\n`);
  process.exit(1);
});
