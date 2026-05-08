import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  DeepSeekError,
  configPath,
  hasApiKey,
  newStats,
  type Message,
  type Model,
} from "./api.js";
import { runAgent, formatCost, formatStatus } from "./agent.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { ToolContext } from "./tools.js";
import * as history from "./history.js";
import * as approval from "./approval.js";
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
      --no-resume           Don't auto-load .dsc-history.json from cwd
  -h, --help                Show this help

API key (in priority order):
  $DEEPSEEK_API_KEY         Env var, takes precedence if set
  ${configPath()}
                            JSON file. Accepted shapes:
                              {"api_key": "sk-..."}
                              {"env": {"DEEPSEEK_API_KEY": "sk-..."}}
                              {"env": {"ANTHROPIC_AUTH_TOKEN": "sk-..."}}  (claude-switcher compat)

REPL commands:
  /clear     Reset conversation
  /cost      Show token usage and estimated cost
  /model     Show or switch model (e.g. /model deepseek-v4-flash)
  /yolo      Toggle approval mode
  /exit      Quit
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
  let stats = newStats();
  let messages: Message[] = [{ role: "system", content: SYSTEM_PROMPT }];
  let model: Model = cli.model;

  let restoredTurns = 0;
  if (cli.resume) {
    const loaded = await history.load(cwd);
    if (loaded) {
      messages = loaded.messages;
      stats = loaded.stats;
      if (!cli.modelExplicit) model = loaded.model;
      restoredTurns = messages.filter((m) => m.role === "user").length;
    }
  }

  const toolCtx: ToolContext = {
    cwd,
    yolo: cli.yolo,
    filesTouched: stats.files_touched,
  };

  const persist = async () => {
    try {
      await history.save(cwd, messages, stats, model);
    } catch (e) {
      process.stderr.write(`${DIM}(history save failed: ${(e as Error).message})${RESET}\n`);
    }
  };

  const statusBar = new StatusBar();
  const refreshStatus = () => statusBar.render(formatStatus(stats, model, toolCtx.yolo));

  const runTurn = async (userText: string) => {
    messages.push({ role: "user", content: userText });
    try {
      await runAgent({ model, stats, toolCtx, messages, onTurn: refreshStatus });
    } catch (e) {
      if (e instanceof DeepSeekError) {
        process.stderr.write(`${RED}${e.message}${RESET}\n`);
        if (e.body) process.stderr.write(`${DIM}${e.body.slice(0, 1000)}${RESET}\n`);
      } else {
        process.stderr.write(`${RED}${(e as Error).message}${RESET}\n`);
      }
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
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const rl = readline.createInterface({ input, output });
  approval.setAsker((q) => rl.question(q));

  while (true) {
    let line: string;
    try {
      line = await rl.question(`${BOLD}> ${RESET}`);
    } catch {
      break; // Ctrl+D
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("/")) {
      const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "exit" || cmd === "quit") {
        break;
      } else if (cmd === "help") {
        printHelp();
      } else if (cmd === "clear") {
        messages.length = 0;
        messages.push({ role: "system", content: SYSTEM_PROMPT });
        stats = newStats();
        toolCtx.filesTouched = stats.files_touched;
        await history.clear(cwd);
        refreshStatus();
        process.stdout.write(`${DIM}history cleared${RESET}\n`);
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
      } else {
        process.stdout.write(`${RED}unknown command: /${cmd}${RESET}\n`);
      }
      continue;
    }

    await runTurn(trimmed);
  }
  approval.setAsker(null);
  rl.close();
  statusBar.disable();
  process.stdout.write(`\n${DIM}${formatCost(stats, model)}${RESET}\n`);
}

main().catch((e) => {
  process.stderr.write(`${RED}fatal: ${(e as Error).message}${RESET}\n`);
  process.exit(1);
});
