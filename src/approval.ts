import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { createPatch } from "diff";
import { configPath, getConfig } from "./api.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

/**
 * Payload handed to the active asker. Front-ends decide how to render:
 * the REPL prints title + body to stdout and reads y/N via readline;
 * the TUI mounts an ApprovalDialog whose box renders title + body inline,
 * so no preview bleeds above the dynamic ink frame.
 *
 * `kind` lets the dialog colorize structurally — diffs get red/green per
 * line, commands stay plain, etc. The body is plain text (no ANSI codes)
 * since ink's <Text> doesn't pass through escape sequences.
 */
export interface ApprovalPayload {
  title: string;
  body?: string;
  question: string;
  kind?: "diff" | "preview" | "command" | "url";
  /** Tool name (e.g. "bash", "edit_file"). When the user answers "always",
   *  the caller flips a per-tool session-approval flag so subsequent calls
   *  of this tool skip the dialog until /clear or the process restarts. */
  tool: string;
}

export type ApprovalAnswer = "yes" | "no" | "always";

type Asker = (req: ApprovalPayload) => Promise<string>;
let activeAsker: Asker | null = null;

export function setAsker(fn: Asker | null): void {
  activeAsker = fn;
}

// ── Deny-first approval policy ────────────────────────────────────────────
// Deny rules always win — even under --yolo. Approve rules are persisted when
// the user answers "always" so subsequent sessions skip the prompt for that
// tool until the config entry is removed.

interface ApprovalPolicy {
  denyTools: Set<string>;
  approveTools: Set<string>;
}

function toStringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string"));
}

function readApprovalPolicy(): ApprovalPolicy {
  try {
    const cfg = getConfig();
    const approvals = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).approvals : undefined;
    const obj = approvals && typeof approvals === "object" ? (approvals as Record<string, unknown>) : {};
    return {
      denyTools: toStringSet(obj.deny_tools ?? obj.denyTools),
      approveTools: toStringSet(obj.approve_tools ?? obj.approveTools),
    };
  } catch {
    // Invalid config should not take down approval gating; fail closed with
    // no deny/approve rules and let the interactive prompt decide.
    return { denyTools: new Set(), approveTools: new Set() };
  }
}

/** True when the tool is denied by config. Deny rules always win. */
export function isToolDenied(tool: string): boolean {
  return readApprovalPolicy().denyTools.has(tool);
}

/** True when the tool was permanently approved by a past "always" answer. */
export function isToolPermanentlyApproved(tool: string): boolean {
  return readApprovalPolicy().approveTools.has(tool);
}

/** Persist a tool to config.approvals.approveTools. Never throws — approval
 *  gating shouldn't fail a tool call because a config write raced or failed. */
export async function savePermanentApproval(tool: string): Promise<void> {
  try {
    const p = configPath();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    let existing: Record<string, unknown> = {};
    try {
      let txt = await fsp.readFile(p, "utf8");
      if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1);
      const parsed = JSON.parse(txt);
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      // Missing or unparseable — start fresh.
    }
    const approvals = existing.approvals && typeof existing.approvals === "object"
      ? (existing.approvals as Record<string, unknown>)
      : {};
    const existingList = toStringSet(approvals.approve_tools ?? approvals.approveTools);
    existingList.add(tool);
    approvals.approve_tools = [...existingList];
    existing.approvals = approvals;
    await fsp.writeFile(p, JSON.stringify(existing, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Permanent approval is best-effort; the session-scoped "always" still works.
  }
}

/**
 * Render a payload to ANSI-colored text suitable for stdout. Exported so
 * the REPL asker (which owns the existing readline interface and can't
 * delegate to ask() without re-creating it) can print previews itself.
 */
export function renderApprovalForStdout(req: ApprovalPayload): string {
  const parts: string[] = [`\n${YELLOW}${req.title}${RESET}`];
  if (req.body) parts.push(colorizeForRepl(req.body, req.kind));
  return parts.join("\n");
}

/**
 * Apply per-line ANSI coloring for the REPL stdout path. Mirrors the
 * structural rules the TUI dialog uses, just with escape sequences.
 */
function colorizeForRepl(body: string, kind: ApprovalPayload["kind"]): string {
  if (kind !== "diff") return body;
  return body
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return BOLD + line + RESET;
      if (line.startsWith("@@")) return CYAN + line + RESET;
      if (line.startsWith("+")) return GREEN + line + RESET;
      if (line.startsWith("-")) return RED + line + RESET;
      return line;
    })
    .join("\n");
}

async function ask(req: ApprovalPayload): Promise<ApprovalAnswer> {
  let answer: string;
  if (activeAsker) {
    // TUI path: front-end owns rendering of title + body + question. No
    // stdout writes — those would land above ink's dynamic frame as noise.
    answer = (await activeAsker(req)).trim().toLowerCase();
  } else {
    // REPL path: render the preview to stdout ourselves before asking.
    process.stdout.write(`\n${YELLOW}${req.title}${RESET}\n`);
    if (req.body) process.stdout.write(colorizeForRepl(req.body, req.kind) + "\n");
    const rl = readline.createInterface({ input, output });
    try {
      answer = (await rl.question(req.question)).trim().toLowerCase();
    } finally {
      rl.close();
    }
  }
  if (answer === "a" || answer === "always") return "always";
  if (answer === "y" || answer === "yes") return "yes";
  return "no";
}

const PROMPT = "Approve? [y]es / [n]o / [a]lways (Esc rejects) ";

export async function confirmWrite(
  path: string,
  oldContent: string,
  newContent: string,
  existed: boolean,
): Promise<ApprovalAnswer> {
  const verb = existed ? "Overwrite" : "Create";
  let body: string;
  let kind: ApprovalPayload["kind"];
  if (existed) {
    body = createPatch(path, oldContent, newContent, "", "", { context: 3 });
    kind = "diff";
  } else {
    const preview =
      newContent.length > 4000 ? newContent.slice(0, 4000) + "\n…(truncated)" : newContent;
    body = `--- proposed content (${newContent.length} chars) ---\n${preview}`;
    kind = "preview";
  }
  return ask({ tool: "write_file", title: `${verb} ${path}`, body, kind, question: PROMPT });
}

export async function confirmEdit(
  path: string,
  oldContent: string,
  newContent: string,
): Promise<ApprovalAnswer> {
  const body = createPatch(path, oldContent, newContent, "", "", { context: 3 });
  return ask({ tool: "edit_file", title: `Edit ${path}`, body, kind: "diff", question: PROMPT });
}

export async function confirmBash(command: string, description: string): Promise<ApprovalAnswer> {
  const bodyLines: string[] = [];
  if (description) bodyLines.push(description);
  bodyLines.push(`$ ${command}`);
  return ask({
    tool: "bash",
    title: "Run shell command",
    body: bodyLines.join("\n"),
    kind: "command",
    question: PROMPT,
  });
}

export async function confirmFetch(url: string): Promise<ApprovalAnswer> {
  return ask({ tool: "web_fetch", title: "Fetch URL", body: url, kind: "url", question: PROMPT });
}

/**
 * Generic yes/no confirm for slash commands that need to take an action
 * with a clear cost (touch the user's npm config, edit a shell rc, etc.)
 * but aren't tied to a specific tool name. `tool: "confirm"` is a sentinel
 * that won't ever match ctx.sessionApprovals, so "always" collapses to
 * "yes" — callers can treat the result as a simple boolean.
 */
export async function confirm(opts: {
  title: string;
  body?: string;
  question?: string;
  kind?: ApprovalPayload["kind"];
}): Promise<ApprovalAnswer> {
  return ask({
    tool: "confirm",
    title: opts.title,
    body: opts.body,
    kind: opts.kind ?? "command",
    question: opts.question ?? "Proceed? [y]es / [n]o (Esc rejects) ",
  });
}
