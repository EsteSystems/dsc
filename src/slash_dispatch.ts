// Slash-command dispatcher, lifted out of tui.tsx so it's (a) unit-testable
// and (b) reusable by `dsc serve` over the wire (Phase 2 of the headless
// plan). The dispatcher owns all parsing, routing, and user-facing message
// formatting; it reaches the front-end only through the injected SlashContext
// — `emit` (the output sink, was tui's `info()`), a handful of getters for
// session-level state, and a few action callbacks for things that are
// genuinely front-end-specific (swapping the active session + rebuilding the
// view, spawning $EDITOR, exiting). Everything else (preferences, history,
// search/api-key config, update, audit, instructions) is plain module calls
// shared by every front-end.

import {
  availableModels,
  computeCostUsd,
  configPath,
  getCustomCommands,
  isKnownModel,
  modelAvailable,
  modelSpec,
  PROVIDER_KEY_INFO,
  providerKeySource,
  saveProviderKey,
  saveSearchKey,
  saveSearchProvider,
  type Message,
  type Model,
  type ProviderId,
  type Stats,
} from "./api.js";
import { formatCost } from "./agent.js";
import { getProvider, getProviderKey } from "./search.js";
import { loadInstructions } from "./instructions.js";
import {
  clearPreferences,
  preferencesPath,
  readPreferences,
  savePreferences,
} from "./preferences.js";
import * as history from "./history.js";
import type { SessionState } from "./history.js";
import * as approval from "./approval.js";
import * as audit from "./audit.js";
import { getState, setState, type PlanState } from "./store.js";
import { formatVersionInfo } from "./version.js";
import {
  addLocalBinToShellRc,
  checkForUpdate,
  localBinOnPath,
  runUpdate,
  setUserNpmPrefix,
  shellRcPath,
} from "./update.js";
import { copyToClipboard } from "./clipboard.js";
import type { MCPConnection } from "./mcp.js";
import type { ToolContext } from "./tools.js";
import { formatRelative } from "./history.js";
import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** Options for the front-end's session-swap action (used by /clear, /resume,
 *  /import). `resetApprovals` drops per-tool "always" grants (/clear);
 *  `rebuildView` repopulates the visible conversation from the session's
 *  messages (/resume, /import) vs. starting empty (/clear). */
export interface ApplySessionOptions {
  resetApprovals?: boolean;
  rebuildView?: boolean;
}

/**
 * Everything the dispatcher needs from its host front-end. The TUI wires
 * these to its imperative locals; `dsc serve` will wire them to its protocol
 * + session state. Reads go through getters (the values are reassigned
 * across /clear, /resume, /import in the host); writes go through actions.
 */
export interface SlashContext {
  cwd: string;
  /** Output sink — one dim system line per call (was tui's `info()`). */
  emit: (text: string) => void;

  // --- reads (host reassigns the underlying values, so these are getters) ---
  getModel: () => Model;
  getStats: () => Stats;
  getSession: () => SessionState;
  getMessages: () => Message[];
  getToolCtx: () => ToolContext;
  getQueue: () => string[];
  getBudget: () => { usd: number | null; warned: boolean };
  getMcpConnections: () => MCPConnection[];

  // --- actions ---
  setModel: (m: Model) => void;
  setBudget: (usd: number | null, warned: boolean) => void;
  persist: () => Promise<void>;
  syncStatus: () => void;
  compact: (keep: number, auto: boolean) => Promise<void>;
  /** Run text as the next user prompt (used by /edit). */
  submit: (text: string) => void;
  /** Swap the active session and refresh the front-end's view. */
  applySession: (next: SessionState, opts: ApplySessionOptions) => void;
  /** Spawn $EDITOR with initial content; returns the saved draft or null on
   *  failure. The host owns terminal control (ink unmount/remount). */
  runEditor: (initial: string) => string | null;
  /** Quit the process cleanly (host clears timers etc). */
  exit: () => void;
  /** Active /plan session — null when no plan is in progress. */
  getPlan: () => PlanState | null;
  setPlan: (p: PlanState | null) => void;
  /** Run a bash command and return its combined stdout+stderr output.
   *  Used by custom slash commands; no approval gating (the user already
   *  opted in by typing the slash). */
  runBashCommand: (command: string) => Promise<string>;
}

const HELP_LINES = [
  "/help                   show this help",
  "/clear                  start a new session",
  "/list                   list sessions for this cwd",
  "/resume [n|name|id]     resume a session",
  "/save <name>            name the current session",
  "/rename <text>          set assistant label for this session",
  "/model [name]           show available models or switch (routes to its provider)",
  "/yolo                   toggle approval mode",
  "/reasoning [on|off]     toggle reasoning display",
  "/lang [name|off]        force the model to reply in a language",
  "/auto-continue [N|off]  auto-grant N extra MAX_TOOL_DEPTH budgets",
  "/cost                   show token usage and cost",
  "/budget [usd|off]       set per-session USD ceiling (warn at 80%, abort at 100%)",
  "/copy                   copy last assistant response to clipboard",
  "/version                show version info",
  "/instructions           list active per-project / per-user instruction overlays",
  "/mcp                    list connected MCP servers and their tools",
  "/preferences [reset]    show or clear persisted slash-set settings",
  "/compact [keep]         summarize old turns (default keep=4)",
  "/transcript             dump full message log",
  "/audit [path|show N]    audit log info",
  "/queue [clear]          list or clear queued prompts",
  "/export [path]          write current session JSON for transfer",
  "/import <path>          load session JSON; rebinds cwd here (--keep-cwd to skip)",
  "/api-key [provider] [key]  show key status / save a provider's api key",
  "/search [use|key] …     show / switch search provider / save brave|tavily key",
  "/update                 check npm for a newer dsc and install it",
  "/edit [text]            open $EDITOR; the saved buffer becomes the next prompt",
  "/review [n]             critically review the last (or Nth-last) assistant response",
  "/exit                   exit",
  "/plan <description>     create a step-by-step plan; /plan:go to execute",
  "/plan:show              show current plan and progress",
  "/plan:go                execute the next pending plan task",
  "/plan:done              mark the current plan task complete",
  "/plan:skip [n]          skip a plan task",
  "/plan:clear             discard the active plan",
  "",
  "Define custom slash commands under \"commands\" in ~/.config/dsc/config.json:",
  '  { "commands": { "build": "npm run build", "test": "npm test" } }',
  "/build  → runs the command and prints output",
];

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Dispatch one input line. Returns true when the line was a recognized slash
 * command and got handled (or rejected) — the caller should not forward it to
 * the agent. Returns false for non-slash input and lets the caller decide.
 */
export async function dispatchSlash(line: string, ctx: SlashContext): Promise<boolean> {
  if (!line.startsWith("/")) return false;
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const { emit } = ctx;

  switch (cmd) {
    case "exit":
    case "quit":
      ctx.exit();
      return true;
    case "help":
      emit(HELP_LINES.join("\n"));
      return true;
    case "clear": {
      const next = history.newSession(ctx.cwd, ctx.getModel());
      ctx.applySession(next, { resetApprovals: true, rebuildView: false });
      emit(`new session started (${next.id})`);
      return true;
    }
    case "list": {
      const all = await history.listSessions(ctx.cwd);
      if (!all.length) {
        emit(`no sessions for ${ctx.cwd}`);
      } else {
        const activeId = ctx.getSession().id;
        emit(
          all
            .map((s, i) => {
              const here = s.id === activeId ? "* " : "  ";
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
        emit("error: usage: /save <name>");
      } else {
        const session = ctx.getSession();
        session.name = arg.trim();
        await ctx.persist();
        emit(`session saved as "${session.name}" (id ${session.id})`);
      }
      return true;
    case "rename": {
      const text = arg.trim();
      const session = ctx.getSession();
      if (!text) {
        emit(`assistant label: "${session.assistantLabel ?? "assistant:"}"`);
      } else if (text === "--reset" || text === "default") {
        delete session.assistantLabel;
        setState({ assistantLabel: "assistant:" });
        await ctx.persist();
        emit("assistant label reset to default");
      } else {
        session.assistantLabel = text;
        setState({ assistantLabel: text });
        await ctx.persist();
        emit(`assistant label → "${text}"`);
      }
      return true;
    }
    case "resume": {
      const all = await history.listSessions(ctx.cwd);
      if (!all.length) {
        emit("no sessions to resume");
        return true;
      }
      let target: history.SessionMeta | null = null;
      if (!arg || arg === "last") {
        target = all[0];
      } else if (/^\d+$/.test(arg)) {
        target = all[parseInt(arg, 10) - 1] ?? null;
        if (!target) emit(`error: no session at index ${arg} (have ${all.length})`);
      } else {
        target = all.find((s) => s.name === arg) ?? all.find((s) => s.id === arg) ?? null;
        if (!target) emit(`error: no session with name or id ${arg}`);
      }
      if (target) {
        const loaded = await history.loadSession(target.id);
        if (!loaded) {
          emit(`error: failed to load session ${target.id}`);
        } else {
          ctx.applySession(loaded, { rebuildView: true });
          const userTurns = loaded.messages.filter((m) => m.role === "user").length;
          emit(`resumed ${loaded.id} (${userTurns} turns, model ${loaded.model})`);
        }
      }
      return true;
    }
    case "cost":
      emit(formatCost(ctx.getStats(), ctx.getModel()));
      return true;
    case "budget": {
      const text = arg.trim().toLowerCase();
      const { usd: budgetUsd, warned: budgetWarned } = ctx.getBudget();
      if (!text) {
        const cost = computeCostUsd(ctx.getStats(), ctx.getModel());
        if (budgetUsd === null) {
          emit(
            `budget: not set  (spent: $${cost.toFixed(4)})\n/budget <usd> to set a limit, /budget off to clear`,
          );
        } else {
          const pct = budgetUsd > 0 ? Math.round((cost / budgetUsd) * 100) : 0;
          emit(
            `budget: $${budgetUsd.toFixed(2)}  spent: $${cost.toFixed(4)} (${pct}%)  warned: ${budgetWarned ? "yes" : "no"}`,
          );
        }
        return true;
      }
      if (text === "off" || text === "none" || text === "0") {
        ctx.setBudget(null, false);
        void savePreferences({ budgetUsd: null });
        emit("budget cleared  (saved)");
        return true;
      }
      const n = parseFloat(text);
      if (!Number.isFinite(n) || n <= 0) {
        emit("error: usage: /budget <amount-usd> | off");
        return true;
      }
      // Reset the warning flag so the user gets a fresh 80% notice against the
      // new limit even if they're already over it.
      ctx.setBudget(n, false);
      void savePreferences({ budgetUsd: n });
      emit(`budget: $${n.toFixed(2)} (warn at 80%, abort the next turn at 100%)  (saved)`);
      return true;
    }
    case "copy": {
      const state = getState();
      let target: (typeof state.history)[number] | undefined;
      for (let i = state.history.length - 1; i >= 0; i--) {
        const m = state.history[i];
        if (m.role === "assistant" && m.content) {
          target = m;
          break;
        }
      }
      if (!target) {
        emit("no assistant message to copy");
        return true;
      }
      try {
        await copyToClipboard(target.content);
        emit(`copied ${target.content.length} chars to clipboard`);
      } catch (e) {
        emit(`error: ${(e as Error).message}`);
      }
      return true;
    }
    case "model":
      if (!arg) {
        emit(`current model: ${ctx.getModel()}\navailable: ${availableModels().join(", ")}`);
      } else if (!isKnownModel(arg)) {
        emit(`error: unknown model: ${arg} (available: ${availableModels().join(", ")})`);
      } else if (!modelAvailable(arg)) {
        // Registered but its provider has no key — point the user at /api-key.
        const prov = modelSpec(arg).provider;
        const info = PROVIDER_KEY_INFO[prov];
        emit(
          `error: ${arg} needs the ${info?.label ?? prov} API key. ` +
            `Set $${info?.envVar ?? "<KEY>"} or run /api-key ${prov} <key>.`,
        );
      } else {
        ctx.setModel(arg);
        ctx.syncStatus();
        emit(`model → ${arg}`);
        await ctx.persist();
      }
      return true;
    case "yolo": {
      const toolCtx = ctx.getToolCtx();
      toolCtx.yolo = !toolCtx.yolo;
      setState({ yolo: toolCtx.yolo });
      void savePreferences({ yolo: toolCtx.yolo });
      emit(`yolo: ${toolCtx.yolo}  (saved to ${preferencesPath()})`);
      return true;
    }
    case "reasoning": {
      const cur = getState().reasoning;
      const next = arg === "on" ? true : arg === "off" ? false : !cur;
      setState({ reasoning: next });
      void savePreferences({ reasoning: next });
      emit(`reasoning: ${next ? "on" : "off"}  (saved)`);
      return true;
    }
    case "queue": {
      const sub = arg.trim().toLowerCase();
      const queue = ctx.getQueue();
      if (sub === "clear" || sub === "drop") {
        const n = queue.length;
        queue.length = 0;
        ctx.syncStatus();
        emit(`cleared ${n} queued prompt(s)`);
      } else if (queue.length === 0) {
        emit("queue is empty");
      } else {
        emit(queue.map((p, i) => `${String(i + 1).padStart(2, " ")}. ${p}`).join("\n"));
      }
      return true;
    }
    case "lang": {
      const text = arg.trim();
      const session = ctx.getSession();
      if (!text) {
        emit(`language: ${session.language ? `"${session.language}"` : "off (any language)"}`);
      } else if (text === "off" || text === "default" || text === "any") {
        delete session.language;
        setState({ language: undefined });
        await ctx.persist();
        emit("language directive cleared");
      } else {
        session.language = text;
        setState({ language: text });
        await ctx.persist();
        emit(`language → "${text}" (replies will be exclusively in this language)`);
      }
      return true;
    }
    case "auto-continue": {
      const t = arg.trim();
      if (!t) {
        const n = getState().autoContinue;
        emit(`auto-continue: ${n === 0 ? "off" : `up to ${n} extra budget(s)`}`);
      } else if (t === "off" || t === "0" || t === "false") {
        setState({ autoContinue: 0 });
        void savePreferences({ autoContinue: null });
        emit("auto-continue: off  (saved)");
      } else {
        const n = parseInt(t, 10);
        if (!Number.isFinite(n) || n < 0) {
          emit("error: usage: /auto-continue [N|off]");
        } else {
          setState({ autoContinue: n });
          void savePreferences({ autoContinue: n });
          emit(`auto-continue: ${n === 0 ? "off" : `up to ${n} extra budget(s)`}  (saved)`);
        }
      }
      return true;
    }
    case "version":
      emit(formatVersionInfo());
      return true;
    case "preferences": {
      const sub = arg.trim().toLowerCase();
      if (sub === "reset") {
        await clearPreferences();
        emit(
          `preferences file deleted (${preferencesPath()}). Current session keeps its in-memory settings; next launch starts with defaults.`,
        );
        return true;
      }
      if (sub && sub !== "show") {
        emit("error: usage: /preferences [show|reset]");
        return true;
      }
      const saved = await readPreferences();
      const lines: string[] = [`preferences: ${preferencesPath()}`];
      const keys: (keyof typeof saved)[] = ["yolo", "reasoning", "autoContinue", "budgetUsd"];
      const present = keys.filter((k) => saved[k] !== undefined);
      if (present.length === 0) {
        lines.push("  (no preferences saved; defaults apply)");
      } else {
        for (const k of present) {
          lines.push(`  ${k}: ${JSON.stringify(saved[k])}`);
        }
      }
      emit(lines.join("\n"));
      return true;
    }
    case "mcp": {
      const conns = ctx.getMcpConnections();
      if (conns.length === 0) {
        emit(
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
      for (const c of conns) {
        lines.push(`── ${c.name} ──`);
        for (const t of c.tools) {
          const short = t.function.name.replace(/^mcp_[^_]+_/, "");
          lines.push(`  ${short}: ${t.function.description ?? ""}`);
        }
      }
      emit(lines.join("\n"));
      return true;
    }
    case "instructions": {
      const overlays = loadInstructions(ctx.cwd);
      if (overlays.length === 0) {
        emit(
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
          ov.kind === "user" ? "user" : ov.kind === "agents" ? "AGENTS.md" : ".dsc/instructions.md";
        const lines = ov.content.split("\n");
        const head = lines.slice(0, 20);
        const tail = lines.length > 20 ? `\n… (${lines.length - 20} more lines)` : "";
        return `── ${label} @ ${ov.path} ──\n${head.join("\n")}${tail}`;
      });
      emit(sections.join("\n\n"));
      return true;
    }
    case "update": {
      emit("checking npm for a newer version…");
      try {
        const check = await checkForUpdate({ force: true });
        if (!check.newerAvailable) {
          emit(`up to date (${check.current})`);
          return true;
        }
        emit(`installing ${check.latest} (currently ${check.current}) via npm…`);
        let r = await runUpdate();
        if (!r.ok && /ETARGET/i.test(r.output)) {
          emit("tarball not on all CDN edges yet (ETARGET); retrying in 8s…");
          await new Promise((res) => setTimeout(res, 8000));
          r = await runUpdate();
        }
        const isPermError = /EACCES|EPERM|permission/.test(r.output);
        if (!r.ok && isPermError && process.platform !== "win32") {
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
              emit(`set npm prefix to ${dir}; retrying install…`);
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
                        emit(
                          `appended PATH export to ${edited}. Open a new terminal or run:` +
                            `\n  source ${edited}`,
                        );
                      } else {
                        emit(`(${rc} already has ~/.local/bin in PATH; no edit needed)`);
                      }
                    } catch (e) {
                      emit(`error appending to ${rc}: ${(e as Error).message}`);
                    }
                  } else {
                    emit(
                      `Add this line to your shell rc manually:\n  export PATH="$HOME/.local/bin:$PATH"`,
                    );
                  }
                } else {
                  emit(
                    `Couldn't autodetect your shell rc. Add this line manually:` +
                      `\n  export PATH="$HOME/.local/bin:$PATH"`,
                  );
                }
              }
            } catch (e) {
              emit(`error: prefix setup failed: ${(e as Error).message}`);
            }
          }
        }
        if (!r.ok) {
          const tail =
            isPermError && process.platform !== "win32"
              ? `\n\nQuick one-off if you'd rather: sudo npm install -g @este.systems/dsc@latest`
              : "";
          emit(`error: update failed\n${r.output.slice(-1500)}${tail}`);
          return true;
        }
        emit(`installed ${check.latest}. Exit and re-run \`dsc\` to pick up the new version.`);
      } catch (e) {
        emit(`error: update failed: ${(e as Error).message}`);
      }
      return true;
    }
    case "api-key": {
      // /api-key                      → status for every provider
      // /api-key <key>                → save DeepSeek key (back-compat)
      // /api-key <provider>           → that provider's status + signup
      // /api-key <provider> <key>     → save that provider's key
      const providerIds = Object.keys(PROVIDER_KEY_INFO) as ProviderId[];
      const statusLine = (p: ProviderId): string => {
        const info = PROVIDER_KEY_INFO[p]!;
        const src = providerKeySource(p);
        const status =
          src === "env" ? `set via $${info.envVar}` : src === "file" ? "stored in config" : "not set";
        return `  ${p}: ${status}  —  ${info.signup}`;
      };

      const tokens = arg.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        emit(
          [
            `api keys (config: ${configPath()}):`,
            ...providerIds.map(statusLine),
            "",
            "Save: /api-key [provider] <key>   (provider defaults to deepseek)",
          ].join("\n"),
        );
        return true;
      }

      const first = tokens[0] as ProviderId;
      const named = providerIds.includes(first);
      const provider: ProviderId = named ? first : "deepseek";
      const keyValue = (named ? tokens.slice(1) : tokens).join(" ");

      if (!keyValue) {
        // `/api-key <provider>` with no key — show its status + how to set it.
        const info = PROVIDER_KEY_INFO[provider]!;
        emit(
          providerKeySource(provider)
            ? statusLine(provider)
            : `${provider}: not set\nsignup: ${info.signup}\nsave with: /api-key ${provider} <key> (or export $${info.envVar})`,
        );
        return true;
      }
      try {
        const written = await saveProviderKey(provider, keyValue);
        emit(`${provider} key saved to ${written}`);
      } catch (e) {
        emit(`error: ${(e as Error).message}`);
      }
      return true;
    }
    case "search": {
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
          src === "env" ? `set via $${ENV_KEY[p]}` : src === "file" ? "stored in config" : "not set";
        return `  ${p}: ${status}  —  ${SIGNUP[p]}`;
      };

      const tokens = arg.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];

      if (!sub) {
        const active = getProvider();
        const activeSrc = process.env.DSC_SEARCH_PROVIDER
          ? "set via $DSC_SEARCH_PROVIDER"
          : "from config";
        emit(
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
          emit("error: usage: /search use <brave|tavily|ddg>");
          return true;
        }
        try {
          const written = await saveSearchProvider(name);
          const needsKey = name === "brave" || name === "tavily";
          const haveKey = needsKey ? !!keySourceFor(name) : true;
          const warn =
            needsKey && !haveKey
              ? `\n(warning) ${name} has no key set. Run: /search key ${name} <key>`
              : "";
          emit(`active search provider → ${name}  (saved to ${written})${warn}`);
        } catch (e) {
          emit(`error: ${(e as Error).message}`);
        }
        return true;
      }

      if (sub === "key") {
        const name = tokens[1];
        const keyValue = tokens.slice(2).join(" ");
        if (!name || (name !== "brave" && name !== "tavily")) {
          emit("error: usage: /search key <brave|tavily> [key]");
          return true;
        }
        if (!keyValue) {
          emit(`${name}: ${keySourceFor(name) ?? "not set"}\nsignup: ${SIGNUP[name]}`);
          return true;
        }
        try {
          const written = await saveSearchKey(name, keyValue);
          emit(`${name} key saved to ${written}`);
        } catch (e) {
          emit(`error: ${(e as Error).message}`);
        }
        return true;
      }

      emit(`error: unknown subcommand '${sub}' (expected: use | key, or no arg for status)`);
      return true;
    }
    case "audit": {
      const sub = arg.trim();
      if (!sub || sub === "path") {
        emit(audit.auditLogPath());
      } else if (sub.startsWith("show")) {
        const nRaw = sub.replace(/^show\s*/, "").trim();
        const limit = (() => {
          const n = nRaw ? parseInt(nRaw, 10) : NaN;
          return Number.isFinite(n) && n > 0 ? n : 10;
        })();
        try {
          const text = await fsp.readFile(audit.auditLogPath(), "utf8");
          const lines = text.split("\n").filter((l) => l.length > 0).slice(-limit);
          emit(lines.length ? lines.join("\n") : "(empty)");
        } catch {
          emit("(no audit log yet)");
        }
      } else {
        emit("error: usage: /audit | /audit path | /audit show [N]");
      }
      return true;
    }
    case "transcript": {
      const session = ctx.getSession();
      const messages = ctx.getMessages();
      const archived = session.archivedMessages ?? [];
      if (archived.length === 0 && messages.length === 0) {
        emit("(no messages)");
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
      emit(lines.join("\n"));
      return true;
    }
    case "compact": {
      const keepRaw = arg ? parseInt(arg, 10) : NaN;
      const keep = Number.isFinite(keepRaw) ? Math.max(0, keepRaw) : 4;
      await ctx.compact(keep, false);
      return true;
    }
    case "export": {
      const dest = arg.trim() || ".";
      const absDest = path.isAbsolute(dest) ? dest : path.resolve(ctx.cwd, dest);
      try {
        await ctx.persist();
        const written = await history.exportSession(ctx.getSession().id, absDest);
        emit(`exported to ${written}`);
      } catch (e) {
        emit(`error: export failed: ${(e as Error).message}`);
      }
      return true;
    }
    case "import": {
      const tokens = arg.trim().split(/\s+/).filter(Boolean);
      const keepCwd = tokens.includes("--keep-cwd");
      const file = tokens.find((t) => !t.startsWith("--"));
      if (!file) {
        emit("error: usage: /import <path> [--keep-cwd]");
        return true;
      }
      const absFile = path.isAbsolute(file) ? file : path.resolve(ctx.cwd, file);
      try {
        const loaded = await history.importSession(absFile, {
          rebindCwd: keepCwd ? undefined : ctx.cwd,
        });
        ctx.applySession(loaded, { rebuildView: true });
        const userTurns = loaded.messages.filter((m) => m.role === "user").length;
        const cwdNote = keepCwd ? "" : " (cwd rebound to here)";
        emit(`imported ${loaded.id} (${userTurns} turns, model ${loaded.model})${cwdNote}`);
      } catch (e) {
        emit(`error: import failed: ${(e as Error).message}`);
      }
      return true;
    }
    case "edit": {
      const initial = arg ? arg + "\n" : "";
      const draft = ctx.runEditor(initial);
      if (draft === null) {
        emit("error: editor failed");
      } else if (!draft.trim()) {
        emit("(empty draft, not sent)");
      } else {
        ctx.submit(draft);
      }
      return true;
    }

    case "review": {
      // Find the last assistant message (or Nth-last if specified).
      const msgs = ctx.getMessages();
      const n = arg.trim() ? Math.max(1, parseInt(arg.trim(), 10) || 1) : 1;
      const assistants = msgs.filter((m) => m.role === "assistant");
      if (!assistants.length) {
        emit("no assistant responses to review");
        return true;
      }
      const target = assistants[assistants.length - Math.min(n, assistants.length)];
      const content = typeof target.content === "string" ? target.content : "(non-text content)";
      ctx.submit(
        `Critically review your last response. Identify any errors, omissions, unclear explanations, or suboptimal code. Then provide an improved version.\n\nYour response to review:\n---\n${content}\n---`,
      );
      emit("reviewing…");
      return true;
    }

    // ── /plan family ───────────────────────────────────────────────────

    case "plan": {
      const desc = arg.trim();
      if (!desc) {
        emit("usage: /plan <description> — create a step-by-step plan");
        emit("  /plan:show  — display current plan");
        emit("  /plan:go    — execute next pending task");
        emit("  /plan:done  — mark current task complete + go next");
        emit("  /plan:skip [n] — skip task N (defaults to current)");
        emit("  /plan:clear — discard the plan");
        return true;
      }
      setState({ planRequestTitle: desc });
      ctx.submit(
        `Create a step-by-step implementation plan for: ${desc}.\n` +
          "Output a numbered list, one concrete task per line.\n" +
          "Format exactly:\n" +
          "1. First task description\n" +
          "2. Second task description\n" +
          "Output NOTHING else besides the numbered list.",
      );
      emit("generating plan…");
      return true;
    }

    case "plan:show": {
      const plan = ctx.getPlan();
      if (!plan) { emit("no active plan. use /plan <description> to create one."); return true; }
      const lines: string[] = [];
      lines.push(`plan: ${plan.title} (${plan.tasks.filter(t => t.done).length}/${plan.tasks.length} done)`);
      for (const t of plan.tasks) {
        const mark = t.done ? "✓" : "◌";
        lines.push(`  ${mark} ${t.id}. ${t.text}`);
      }
      emit(lines.join("\n"));
      return true;
    }

    case "plan:go": {
      const plan = ctx.getPlan();
      if (!plan) { emit("no active plan. use /plan <description> to create one."); return true; }
      const next = plan.tasks.find(t => !t.done);
      if (!next) { emit("all tasks complete."); return true; }
      ctx.submit(
        `Execute task ${next.id}/${plan.tasks.length} of the plan "${plan.title}":\n` +
          `"${next.text}"\n` +
          "Execute ONLY this task. Report what you did when done.",
      );
      return true;
    }

    case "plan:done": {
      const plan = ctx.getPlan();
      if (!plan) { emit("no active plan."); return true; }
      const cur = plan.tasks.find(t => !t.done);
      if (!cur) { emit("all tasks already complete."); return true; }
      cur.done = true;
      ctx.setPlan({ ...plan, tasks: [...plan.tasks] });
      const remaining = plan.tasks.filter(t => !t.done);
      if (remaining.length === 0) {
        emit("all tasks complete.");
      } else {
        emit(`task ${cur.id} marked done. ${remaining.length} remaining. /plan:go for next.`);
      }
      return true;
    }

    case "plan:skip": {
      const plan = ctx.getPlan();
      if (!plan) { emit("no active plan."); return true; }
      const n = arg.trim() ? parseInt(arg.trim(), 10) : plan.tasks.find(t => !t.done)?.id;
      if (!n || !plan.tasks.find(t => t.id === n)) {
        emit(`task ${n ?? "?"} not found. use /plan:show to see task numbers.`);
        return true;
      }
      const task = plan.tasks.find(t => t.id === n)!;
      task.done = true;
      ctx.setPlan({ ...plan, tasks: [...plan.tasks] });
      emit(`skipped task ${n}: ${task.text}`);
      return true;
    }

    case "plan:clear": {
      ctx.setPlan(null);
      setState({ planRequestTitle: null });
      emit("plan discarded.");
      return true;
    }
    default: {
      // Check user-defined custom slash commands from config before giving up.
      const custom = getCustomCommands();
      if (custom && custom[cmd]) {
        emit(`running: ${custom[cmd]}`);
        try {
          const out = await ctx.runBashCommand(custom[cmd]);
          emit(out || "(no output)");
        } catch (e) {
          emit(`error: ${(e as Error).message}`);
        }
        return true;
      }
      emit(`error: unknown command: /${cmd}`);
      return true;
    }
  }
}
