import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ToolSchema } from "./api.js";
import { confirmBash, confirmEdit, confirmFetch, confirmWrite } from "./approval.js";

export const READ_ONLY_TOOLS = new Set(["read_file", "grep", "glob"]);

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the local filesystem. Returns up to 2000 lines by default with 1-based line numbers prefixed; pass offset/limit to page through larger files. Lines longer than 2000 chars are truncated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path to the file." },
          offset: { type: "integer", description: "1-based line number to start reading from." },
          limit: { type: "integer", description: "Maximum number of lines to return." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or fully overwrite an existing one. Use only when creating new files or rewriting in full; prefer edit_file otherwise.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          content: { type: "string", description: "Complete file contents." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact substring in an existing file. old_string must appear exactly once unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          old_string: { type: "string", description: "Exact text to replace." },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "If true, replace every occurrence (uniqueness not required).",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command via /bin/sh. Output is captured and returned (truncated if very long). Long-running interactive commands are not supported.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run." },
          description: { type: "string", description: "Short description of why." },
          timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 60000)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents for a regex pattern. Uses ripgrep (rg) when available, falls back to grep -rn. Output is line-limited; narrow scope with path/glob if it overflows.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern (rg/grep -E syntax)." },
          path: { type: "string", description: "File or directory to search (default: cwd)." },
          glob: {
            type: "string",
            description:
              "Optional glob filter, e.g. '*.ts' or '!**/node_modules/**'. Passed as --glob to rg or --include to grep.",
          },
          case_insensitive: { type: "boolean", description: "Case-insensitive match." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "List filesystem paths matching a glob pattern (e.g. 'src/**/*.ts'). Returns up to 500 paths.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern." },
          path: { type: "string", description: "Base directory (default: cwd)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "Fetch a URL via HTTP(S) GET. HTML responses are stripped to readable text. Response is size-capped.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL (http or https)." },
        },
        required: ["url"],
      },
    },
  },
];

export interface ToolContext {
  cwd: string;
  yolo: boolean;
  filesTouched: Set<string>;
}

export interface ToolResult {
  content: string;
  rejected?: boolean;
}

function resolvePath(ctx: ToolContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function withLineNumbers(text: string, offset = 1): string {
  const lines = text.split("\n");
  const width = String(offset + lines.length - 1).length;
  return lines.map((l, i) => `${String(offset + i).padStart(width, " ")}\t${l}`).join("\n");
}

export async function executeTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return { content: `error: invalid arguments JSON: ${argsJson.slice(0, 200)}` };
  }

  switch (name) {
    case "read_file":
      return readFile(args, ctx);
    case "write_file":
      return writeFile(args, ctx);
    case "edit_file":
      return editFile(args, ctx);
    case "bash":
      return runBash(args, ctx, signal);
    case "grep":
      return runGrep(args, ctx, signal);
    case "glob":
      return runGlob(args, ctx);
    case "web_fetch":
      return runWebFetch(args, ctx, signal);
    default:
      return { content: `error: unknown tool '${name}'` };
  }
}

const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LINE_LEN = 2000;

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { content: "error: missing 'path'" };
  const abs = resolvePath(ctx, p);
  if (!(await exists(abs))) return { content: `error: file does not exist: ${abs}` };
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e: unknown) {
    return { content: `error: ${(e as Error).message}` };
  }
  const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 1;
  const limitProvided = Number(args.limit) > 0;
  const limit = limitProvided ? Math.floor(Number(args.limit)) : READ_DEFAULT_LIMIT;
  const allLines = text.split("\n");
  const totalLines = allLines.length;
  const start = Math.min(offset - 1, totalLines);
  const end = Math.min(start + limit, totalLines);
  const slice = allLines.slice(start, end).map((l) =>
    l.length > READ_MAX_LINE_LEN ? l.slice(0, READ_MAX_LINE_LEN) + "…(truncated long line)" : l,
  );
  let body = withLineNumbers(slice.join("\n"), offset);
  if (end < totalLines) {
    body += `\n…(showing lines ${offset}–${end} of ${totalLines}; pass offset/limit to read more)`;
  }
  return { content: body };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!p) return { content: "error: missing 'path'" };
  const abs = resolvePath(ctx, p);
  const existed = await exists(abs);
  let oldContent = "";
  if (existed) {
    try {
      oldContent = await fs.readFile(abs, "utf8");
    } catch {
      // fall through; treat as new
    }
  }
  if (!ctx.yolo) {
    const ok = await confirmWrite(abs, oldContent, content, existed);
    if (!ok) return { content: "rejected by user", rejected: true };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  ctx.filesTouched.add(abs);
  return { content: `ok: ${existed ? "overwrote" : "created"} ${abs} (${content.length} chars)` };
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all);
  if (!p) return { content: "error: missing 'path'" };
  if (oldString === "") return { content: "error: old_string must not be empty" };

  const abs = resolvePath(ctx, p);
  if (!(await exists(abs))) return { content: `error: file does not exist: ${abs}` };
  let current: string;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch (e: unknown) {
    return { content: `error: ${(e as Error).message}` };
  }
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) {
    return { content: `error: old_string not found in ${abs}` };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      content: `error: old_string is not unique in ${abs} (matches ${occurrences} times). Pass replace_all=true or include more surrounding context.`,
    };
  }
  const updated = replaceAll
    ? current.split(oldString).join(newString)
    : current.replace(oldString, newString);

  if (!ctx.yolo) {
    const ok = await confirmEdit(abs, current, updated);
    if (!ok) return { content: "rejected by user", rejected: true };
  }
  await fs.writeFile(abs, updated, "utf8");
  ctx.filesTouched.add(abs);
  return {
    content: `ok: edited ${abs} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
  };
}

async function runBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return { content: "error: missing 'command'" };
  const timeoutMs = Number(args.timeout_ms) > 0 ? Math.floor(Number(args.timeout_ms)) : 60_000;
  if (!ctx.yolo) {
    const ok = await confirmBash(command, String(args.description ?? ""));
    if (!ok) return { content: "rejected by user", rejected: true };
  }
  return new Promise<ToolResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: ctx.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const MAX = 16_000;
      const trim = (s: string) => (s.length > MAX ? s.slice(0, MAX) + `\n…(truncated, ${s.length - MAX} more chars)` : s);
      const parts: string[] = [];
      const exitDesc = interrupted
        ? "killed (interrupted)"
        : timedOut
          ? "killed (timeout)"
          : String(code);
      parts.push(`exit_code: ${exitDesc}`);
      if (stdout) parts.push(`stdout:\n${trim(stdout)}`);
      if (stderr) parts.push(`stderr:\n${trim(stderr)}`);
      if (!stdout && !stderr) parts.push("(no output)");
      resolve({ content: parts.join("\n") });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ content: `error: ${e.message}` });
    });
  });
}

let _hasRg: boolean | undefined;
function hasRipgrep(): boolean {
  if (_hasRg !== undefined) return _hasRg;
  const r = spawnSync("which", ["rg"], { stdio: "ignore" });
  _hasRg = r.status === 0;
  return _hasRg;
}

const GREP_MAX_OUTPUT = 16_000;

async function runGrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { content: "error: missing 'pattern'" };
  const searchPath = args.path ? resolvePath(ctx, String(args.path)) : ctx.cwd;
  const ci = Boolean(args.case_insensitive);
  const glob = args.glob ? String(args.glob) : null;

  let cmd: string;
  let cmdArgs: string[];
  if (hasRipgrep()) {
    cmd = "rg";
    cmdArgs = ["--no-heading", "--line-number", "--max-count=200", "--color=never"];
    if (ci) cmdArgs.push("-i");
    if (glob) cmdArgs.push("--glob", glob);
    cmdArgs.push("--", pattern, searchPath);
  } else {
    cmd = "grep";
    cmdArgs = ["-rn", "-E"];
    if (ci) cmdArgs.push("-i");
    if (glob) cmdArgs.push(`--include=${glob}`);
    cmdArgs.push("-e", pattern, searchPath);
  }

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: ctx.cwd });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    const onAbort = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > GREP_MAX_OUTPUT * 2) child.kill("SIGTERM");
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (interrupted) return resolve({ content: "interrupted" });
      // grep/rg exit 1 when no matches — treat as a clean "no matches" result.
      if (code === 1 && !stdout) return resolve({ content: "(no matches)" });
      if (code !== 0 && code !== null && !stdout) {
        return resolve({ content: `error: ${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}` });
      }
      let out = stdout.trim();
      if (out.length > GREP_MAX_OUTPUT) {
        out = out.slice(0, GREP_MAX_OUTPUT) + `\n…(truncated; narrow the search with path or glob)`;
      }
      resolve({ content: out || "(no matches)" });
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ content: `error: ${e.message}` });
    });
  });
}

const GLOB_LIMIT = 500;

async function runGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { content: "error: missing 'pattern'" };
  const cwd = args.path ? resolvePath(ctx, String(args.path)) : ctx.cwd;
  const matches: string[] = [];
  try {
    // fs.promises.glob is available in Node 22+.
    const fsAny = fs as unknown as { glob: (p: string, o: { cwd: string }) => AsyncIterable<string> };
    if (typeof fsAny.glob !== "function") {
      return { content: "error: fs.glob unavailable; need Node 22+. Use bash with `find` instead." };
    }
    for await (const p of fsAny.glob(pattern, { cwd })) {
      matches.push(p);
      if (matches.length >= GLOB_LIMIT) break;
    }
  } catch (e) {
    return { content: `error: ${(e as Error).message}` };
  }
  if (!matches.length) return { content: "(no matches)" };
  matches.sort();
  let out = matches.join("\n");
  if (matches.length === GLOB_LIMIT) out += `\n…(reached ${GLOB_LIMIT}-path cap; narrow the pattern)`;
  return { content: out };
}

const FETCH_MAX = 50_000;

async function runWebFetch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const url = String(args.url ?? "");
  if (!url) return { content: "error: missing 'url'" };
  if (!/^https?:\/\//i.test(url)) {
    return { content: "error: url must start with http:// or https://" };
  }
  if (!ctx.yolo) {
    const ok = await confirmFetch(url);
    if (!ok) return { content: "rejected by user", rejected: true };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "dsc/0.1", Accept: "text/html,text/plain,*/*" },
      signal,
      redirect: "follow",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return { content: "interrupted" };
    return { content: `error: ${(e as Error).message}` };
  }
  if (!res.ok) {
    return { content: `error: HTTP ${res.status} ${res.statusText}` };
  }
  const ct = res.headers.get("content-type") ?? "";
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { content: `error: ${(e as Error).message}` };
  }
  if (/html|xml/i.test(ct)) text = stripHtml(text);
  if (text.length > FETCH_MAX) {
    text = text.slice(0, FETCH_MAX) + `\n…(truncated, ${text.length - FETCH_MAX} more chars)`;
  }
  return { content: text || "(empty body)" };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6]|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
