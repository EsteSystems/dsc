import { promises as fs } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ToolSchema } from "./api.js";
import {
  confirmBash,
  confirmEdit,
  confirmFetch,
  confirmWrite,
  type ApprovalAnswer,
} from "./approval.js";
import * as audit from "./audit.js";
import { search as runSearchProvider, formatResults, getProvider, SearchError } from "./search.js";
import { getState, setState, type AgentTask } from "./store.js";

export const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep",
  "glob",
  "web_search",
  // task_* mutate the in-memory task list, not the filesystem — no approval
  // needed and we don't want them blocking on confirm prompts.
  "task_create",
  "task_update",
  "task_list",
]);

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
      name: "multi_edit",
      description:
        "Apply a sequence of edits to a single file in one atomic operation. Edits are applied in order, each operating on the result of the previous one; if any edit fails to match, nothing is written. Prefer this over multiple edit_file calls when making several changes to the same file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          edits: {
            type: "array",
            description: "Edits applied in order. Each: old_string → new_string.",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string", description: "Exact text to replace." },
                new_string: { type: "string", description: "Replacement text." },
                replace_all: {
                  type: "boolean",
                  description: "If true, replace every occurrence (uniqueness not required).",
                },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command. Always works regardless of OS — uses /bin/sh -c on Linux/macOS and cmd.exe /d /s /c on Windows. Pick syntax that matches the host: e.g. `ls` on Linux/macOS vs `dir` on Windows; `cat` vs `type`; `which` vs `where`; `rm` vs `del`; `mv` vs `move`. Package managers on Windows are `winget install <pkg>` (built-in on Windows 10 1809+ / 11) and `scoop install <pkg>` — apt/brew/yum/pacman don't exist there. For Node version management on Windows, use nvm-windows or fnm. Check the cwd in the system prompt to know which platform you're on (paths starting with a drive letter like C:\\ mean Windows). Output is captured and truncated if very long. Long-running interactive commands are not supported.",
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
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for a query. Returns up to 20 results as numbered title/url/snippet entries. Pair with web_fetch to read the full content of any specific URL the search returns.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          count: {
            type: "integer",
            description: "How many results to return (1-20, default 5).",
          },
          freshness: {
            type: "string",
            enum: ["day", "week", "month", "year"],
            description: "Limit to results from the last day/week/month/year.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_create",
      description:
        "Create a pending task in the user-visible task list. Use this when planning a multi-step task so the user can see progress. Returns the new task's id. Don't bother for trivial single-step tasks.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description:
              "Short imperative title, e.g. 'Add ESC abort to the TUI'.",
          },
          activeForm: {
            type: "string",
            description:
              "Optional present-continuous form shown while in_progress, e.g. 'Adding ESC abort'.",
          },
        },
        required: ["subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_update",
      description:
        "Update a task by id. Set status to 'in_progress' before starting the work, 'completed' when done. You can also rewrite subject/activeForm.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task id returned by task_create." },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "New status.",
          },
          subject: { type: "string", description: "Replace the subject." },
          activeForm: {
            type: "string",
            description: "Replace the activeForm string.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_list",
      description:
        "Return the current task list with statuses, one per line.",
      parameters: { type: "object", properties: {} },
    },
  },
];

export interface ToolContext {
  cwd: string;
  yolo: boolean;
  filesTouched: Set<string>;
  sessionId: string;
  /** Tools the user said "always" to in this session. Subsequent calls of
   *  these tools skip the approval dialog. Cleared by /clear and on a
   *  fresh process. Initialized empty if absent for backward compat. */
  sessionApprovals?: Set<string>;
}

export interface ToolResult {
  content: string;
  rejected?: boolean;
  audit?: Record<string, unknown>;
}

/**
 * Bridge between a tool executor and the approval dialog. Returns true if
 * the tool may proceed (the user said yes/always, or this tool is already
 * always-approved for the session, or --yolo is on). On "always", records
 * the tool name in ctx.sessionApprovals so subsequent calls skip the
 * dialog until /clear or process restart.
 */
async function gateApproval(
  ctx: ToolContext,
  toolName: string,
  prompt: () => Promise<ApprovalAnswer>,
): Promise<boolean> {
  if (ctx.yolo) return true;
  if (ctx.sessionApprovals?.has(toolName)) return true;
  const ans = await prompt();
  if (ans === "no") return false;
  if (ans === "always") {
    if (!ctx.sessionApprovals) ctx.sessionApprovals = new Set();
    ctx.sessionApprovals.add(toolName);
  }
  return true;
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

// On Windows, child.kill() only terminates cmd.exe; any grandchildren it
// spawned (npm, vite, tsx workers) inherit stdio and keep running. taskkill
// /T walks the process tree by PPID and ends the whole family; /F is the
// unconditional kill. No-op on non-Windows and when pid is missing. We
// swallow errors so a missing/blocked taskkill doesn't hang the caller —
// in every call site there's a follow-up child.kill() as the fallback.
function killWindowsTree(pid: number | undefined): void {
  if (process.platform !== "win32" || pid === undefined) return;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5_000,
    });
  } catch {
    // Nothing useful to do; the caller's child.kill() is the fallback.
  }
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
    const result: ToolResult = {
      content: `error: invalid arguments JSON: ${argsJson.slice(0, 200)}`,
      audit: { error: "invalid_arguments_json" },
    };
    void writeAudit(name, ctx, result);
    return result;
  }

  let result: ToolResult;
  switch (name) {
    case "read_file":
      result = await readFile(args, ctx);
      break;
    case "write_file":
      result = await writeFile(args, ctx);
      break;
    case "edit_file":
      result = await editFile(args, ctx);
      break;
    case "multi_edit":
      result = await multiEdit(args, ctx);
      break;
    case "bash":
      result = await runBash(args, ctx, signal);
      break;
    case "grep":
      result = await runGrep(args, ctx, signal);
      break;
    case "glob":
      result = await runGlob(args, ctx);
      break;
    case "web_fetch":
      result = await runWebFetch(args, ctx, signal);
      break;
    case "web_search":
      result = await runWebSearch(args, signal);
      break;
    case "task_create":
      result = taskCreate(args);
      break;
    case "task_update":
      result = taskUpdate(args);
      break;
    case "task_list":
      result = taskList();
      break;
    default:
      result = { content: `error: unknown tool '${name}'`, audit: { error: "unknown_tool" } };
  }
  void writeAudit(name, ctx, result);
  return result;
}

function writeAudit(name: string, ctx: ToolContext, result: ToolResult): Promise<void> {
  return audit.record({
    session: ctx.sessionId,
    cwd: ctx.cwd,
    tool: name,
    approved: !result.rejected,
    ...(result.audit ?? {}),
  });
}

const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_LINE_LEN = 2000;

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { content: "error: missing 'path'", audit: { error: "missing_path" } };
  const abs = resolvePath(ctx, p);
  if (!(await exists(abs))) {
    return { content: `error: file does not exist: ${abs}`, audit: { path: abs, error: "missing" } };
  }
  // Catch the common case where the agent passes a directory path. Without
  // this, fs.readFile throws EISDIR and the agent has to bounce through a
  // `bash ls` to figure out what's there. Point it at the right tool instead.
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (e) {
    return { content: `error: ${(e as Error).message}`, audit: { path: abs, error: "stat_failed" } };
  }
  if (stat.isDirectory()) {
    return {
      content:
        `error: '${abs}' is a directory, not a file. ` +
        `Use the glob tool to list it: glob({"pattern": "*", "path": "${abs}"}) ` +
        `for top-level entries, or "**/*" for everything recursively.`,
      audit: { path: abs, error: "is_directory" },
    };
  }
  let text: string;
  try {
    text = await fs.readFile(abs, "utf8");
  } catch (e: unknown) {
    return { content: `error: ${(e as Error).message}`, audit: { path: abs, error: "read_failed" } };
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
  return {
    content: body,
    audit: { path: abs, lines_returned: end - start, total_lines: totalLines },
  };
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!p) return { content: "error: missing 'path'", audit: { error: "missing_path" } };
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
  const approved = await gateApproval(ctx, "write_file", () =>
    confirmWrite(abs, oldContent, content, existed),
  );
  if (!approved) {
    return {
      content: "rejected by user",
      rejected: true,
      audit: { path: abs, size: content.length, existed },
    };
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  ctx.filesTouched.add(abs);
  return {
    content: `ok: ${existed ? "overwrote" : "created"} ${abs} (${content.length} chars)`,
    audit: { path: abs, size: content.length, existed },
  };
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  const oldString = String(args.old_string ?? "");
  const newString = String(args.new_string ?? "");
  const replaceAll = Boolean(args.replace_all);
  if (!p) return { content: "error: missing 'path'", audit: { error: "missing_path" } };
  if (oldString === "") {
    return { content: "error: old_string must not be empty", audit: { path: p, error: "empty_old_string" } };
  }

  const abs = resolvePath(ctx, p);
  if (!(await exists(abs))) {
    return { content: `error: file does not exist: ${abs}`, audit: { path: abs, error: "missing" } };
  }
  let current: string;
  try {
    current = await fs.readFile(abs, "utf8");
  } catch (e: unknown) {
    return { content: `error: ${(e as Error).message}`, audit: { path: abs, error: "read_failed" } };
  }
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      content: `error: old_string not found in ${abs}`,
      audit: { path: abs, error: "not_found" },
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      content: `error: old_string is not unique in ${abs} (matches ${occurrences} times). Pass replace_all=true or include more surrounding context.`,
      audit: { path: abs, error: "not_unique", occurrences },
    };
  }
  const updated = replaceAll
    ? current.split(oldString).join(newString)
    : current.replace(oldString, newString);

  const approvedEdit = await gateApproval(ctx, "edit_file", () =>
    confirmEdit(abs, current, updated),
  );
  if (!approvedEdit) {
    return {
      content: "rejected by user",
      rejected: true,
      audit: { path: abs, replacements: occurrences },
    };
  }
  await fs.writeFile(abs, updated, "utf8");
  ctx.filesTouched.add(abs);
  return {
    content: `ok: edited ${abs} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
    audit: { path: abs, replacements: occurrences },
  };
}

interface EditOp {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

/** Parse + validate the `edits` argument into a typed list, or return an
 *  error string describing the first malformed entry. */
function parseEdits(raw: unknown): EditOp[] | string {
  if (!Array.isArray(raw)) return "edits must be an array";
  if (raw.length === 0) return "edits must not be empty";
  const out: EditOp[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== "object") return `edit #${i + 1}: must be an object`;
    const rec = e as Record<string, unknown>;
    const oldStr = typeof rec.old_string === "string" ? rec.old_string : "";
    const newStr = typeof rec.new_string === "string" ? rec.new_string : "";
    if (oldStr === "") return `edit #${i + 1}: old_string must not be empty`;
    out.push({ old_string: oldStr, new_string: newStr, replace_all: Boolean(rec.replace_all) });
  }
  return out;
}

async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const p = String(args.path ?? "");
  if (!p) return { content: "error: missing 'path'", audit: { error: "missing_path" } };
  const edits = parseEdits(args.edits);
  if (typeof edits === "string") {
    return { content: `error: ${edits}`, audit: { path: p, error: "bad_edits" } };
  }

  const abs = resolvePath(ctx, p);
  if (!(await exists(abs))) {
    return { content: `error: file does not exist: ${abs}`, audit: { path: abs, error: "missing" } };
  }
  let original: string;
  try {
    original = await fs.readFile(abs, "utf8");
  } catch (e: unknown) {
    return { content: `error: ${(e as Error).message}`, audit: { path: abs, error: "read_failed" } };
  }

  // Apply every edit in memory first; a failure anywhere writes nothing, so
  // the file is never left half-patched. Each edit sees the prior edits'
  // result, matching how a human would stack them.
  let current = original;
  let totalReplacements = 0;
  for (let i = 0; i < edits.length; i++) {
    const { old_string, new_string, replace_all } = edits[i];
    const occurrences = current.split(old_string).length - 1;
    if (occurrences === 0) {
      return {
        content: `error: edit #${i + 1}: old_string not found${i > 0 ? " (after applying earlier edits)" : ""}`,
        audit: { path: abs, error: "not_found", edit: i + 1 },
      };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        content: `error: edit #${i + 1}: old_string is not unique (matches ${occurrences} times). Pass replace_all=true or add surrounding context.`,
        audit: { path: abs, error: "not_unique", edit: i + 1, occurrences },
      };
    }
    current = replace_all
      ? current.split(old_string).join(new_string)
      : current.replace(old_string, new_string);
    totalReplacements += replace_all ? occurrences : 1;
  }

  if (current === original) {
    return {
      content: `error: edits produced no change to ${abs}`,
      audit: { path: abs, error: "no_change" },
    };
  }

  const approved = await gateApproval(ctx, "multi_edit", () => confirmEdit(abs, original, current));
  if (!approved) {
    return {
      content: "rejected by user",
      rejected: true,
      audit: { path: abs, edits: edits.length, replacements: totalReplacements },
    };
  }
  await fs.writeFile(abs, current, "utf8");
  ctx.filesTouched.add(abs);
  return {
    content: `ok: applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${abs} (${totalReplacements} replacement${totalReplacements === 1 ? "" : "s"})`,
    audit: { path: abs, edits: edits.length, replacements: totalReplacements },
  };
}

async function runBash(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return { content: "error: missing 'command'", audit: { error: "missing_command" } };
  const timeoutMs = Number(args.timeout_ms) > 0 ? Math.floor(Number(args.timeout_ms)) : 60_000;
  const approvedBash = await gateApproval(ctx, "bash", () =>
    confirmBash(command, String(args.description ?? "")),
  );
  if (!approvedBash) {
    return {
      content: "rejected by user",
      rejected: true,
      audit: { command, timeout_ms: timeoutMs },
    };
  }
  return new Promise<ToolResult>((resolve) => {
    // `shell: true` makes Node pick the platform's default: /bin/sh -c on
    // POSIX, cmd.exe /d /s /c on Windows. Lets the same `bash` tool work
    // across Linux/macOS/Windows without us shelling out to a hardcoded path.
    //
    // stdio = ["ignore", "pipe", "pipe"]: don't open a stdin pipe. On
    // Windows in particular, cmd.exe / powershell spawn grandchildren that
    // inherit stdio handles — keeping stdin open lets those grandchildren
    // claim it and prevent `close` from ever firing, even after the
    // immediate child has exited. windowsHide skips the flashed console.
    const child = spawn(command, [], {
      cwd: ctx.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killWindowsTree(child.pid);
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => {
      interrupted = true;
      killWindowsTree(child.pid);
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      const MAX = 16_000;
      const trim = (s: string) =>
        s.length > MAX ? s.slice(0, MAX) + `\n…(truncated, ${s.length - MAX} more chars)` : s;
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
      resolve({
        content: parts.join("\n"),
        audit: {
          command,
          exit: interrupted ? "interrupted" : timedOut ? "timeout" : (code ?? null),
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
        },
      });
    };

    // On `exit` the process has finished; on `close` its stdio is also
    // fully drained. Grandchildren that inherit stdio (the Windows hang)
    // can keep `close` from firing even after exit. So: prefer `close`
    // when it arrives quickly, otherwise force-settle 500ms after exit
    // with whatever output we already have.
    let graceTimer: NodeJS.Timeout = setTimeout(() => {}, 0);
    clearTimeout(graceTimer);
    child.on("exit", (code) => {
      graceTimer = setTimeout(() => {
        // close didn't fire in time — clean exit but stray grandchildren
        // are holding stdio open. Kill the tree so they don't keep working
        // after we return "done" to the agent.
        killWindowsTree(child.pid);
        // Detach our listeners on the stdio streams so leftover data from
        // grandchildren doesn't keep this process tree alive.
        try {
          child.stdout?.destroy();
        } catch {}
        try {
          child.stderr?.destroy();
        } catch {}
        settle(code);
      }, 500);
    });
    child.on("close", (code) => settle(code));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ content: `error: ${e.message}`, audit: { command, error: "spawn_failed" } });
    });
  });
}

let _hasRg: boolean | undefined;
function hasRipgrep(): boolean {
  if (_hasRg !== undefined) return _hasRg;
  // POSIX has `which`, Windows has `where`. Pick the right one.
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, ["rg"], { stdio: "ignore" });
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
      const auditBase = { pattern, path: searchPath, glob, case_insensitive: ci, engine: cmd };
      if (interrupted) {
        return resolve({ content: "interrupted", audit: { ...auditBase, exit: "interrupted" } });
      }
      // grep/rg exit 1 when no matches — treat as a clean "no matches" result.
      if (code === 1 && !stdout) {
        return resolve({ content: "(no matches)", audit: { ...auditBase, matches: 0 } });
      }
      if (code !== 0 && code !== null && !stdout) {
        return resolve({
          content: `error: ${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          audit: { ...auditBase, error: `exit_${code}` },
        });
      }
      let out = stdout.trim();
      const matches = out ? out.split("\n").length : 0;
      if (out.length > GREP_MAX_OUTPUT) {
        out = out.slice(0, GREP_MAX_OUTPUT) + `\n…(truncated; narrow the search with path or glob)`;
      }
      resolve({ content: out || "(no matches)", audit: { ...auditBase, matches } });
    });
    child.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      resolve({ content: `error: ${e.message}`, audit: { pattern, error: "spawn_failed" } });
    });
  });
}

const GLOB_LIMIT = 500;

async function runGlob(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return { content: "error: missing 'pattern'", audit: { error: "missing_pattern" } };
  const cwd = args.path ? resolvePath(ctx, String(args.path)) : ctx.cwd;
  const matches: string[] = [];
  try {
    // fs.promises.glob is available in Node 22+.
    const fsAny = fs as unknown as { glob: (p: string, o: { cwd: string }) => AsyncIterable<string> };
    if (typeof fsAny.glob !== "function") {
      return {
        content: "error: fs.glob unavailable; need Node 22+. Use bash with `find` instead.",
        audit: { error: "fs_glob_unavailable" },
      };
    }
    for await (const p of fsAny.glob(pattern, { cwd })) {
      matches.push(p);
      if (matches.length >= GLOB_LIMIT) break;
    }
  } catch (e) {
    return { content: `error: ${(e as Error).message}`, audit: { pattern, base: cwd, error: "glob_failed" } };
  }
  if (!matches.length) {
    return { content: "(no matches)", audit: { pattern, base: cwd, matches: 0 } };
  }
  matches.sort();
  let out = matches.join("\n");
  if (matches.length === GLOB_LIMIT) out += `\n…(reached ${GLOB_LIMIT}-path cap; narrow the pattern)`;
  return { content: out, audit: { pattern, base: cwd, matches: matches.length } };
}

const FETCH_MAX = 50_000;

async function runWebFetch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const url = String(args.url ?? "");
  if (!url) return { content: "error: missing 'url'", audit: { error: "missing_url" } };
  if (!/^https?:\/\//i.test(url)) {
    return { content: "error: url must start with http:// or https://", audit: { url, error: "bad_scheme" } };
  }
  const approvedFetch = await gateApproval(ctx, "web_fetch", () => confirmFetch(url));
  if (!approvedFetch) {
    return { content: "rejected by user", rejected: true, audit: { url } };
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "dsc/0.1", Accept: "text/html,text/plain,*/*" },
      signal,
      redirect: "follow",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { content: "interrupted", audit: { url, error: "interrupted" } };
    }
    return { content: `error: ${(e as Error).message}`, audit: { url, error: "fetch_failed" } };
  }
  if (!res.ok) {
    return {
      content: `error: HTTP ${res.status} ${res.statusText}`,
      audit: { url, status: res.status },
    };
  }
  const ct = res.headers.get("content-type") ?? "";
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { content: `error: ${(e as Error).message}`, audit: { url, status: res.status, error: "read_failed" } };
  }
  const rawBytes = text.length;
  if (/html|xml/i.test(ct)) text = stripHtml(text);
  if (text.length > FETCH_MAX) {
    text = text.slice(0, FETCH_MAX) + `\n…(truncated, ${text.length - FETCH_MAX} more chars)`;
  }
  return {
    content: text || "(empty body)",
    audit: { url, status: res.status, content_type: ct, bytes: rawBytes },
  };
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

async function runWebSearch(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) return { content: "error: missing 'query'", audit: { error: "missing_query" } };
  const count = Number(args.count) > 0 ? Math.min(20, Math.floor(Number(args.count))) : 5;
  const freshness =
    args.freshness === "day" ||
    args.freshness === "week" ||
    args.freshness === "month" ||
    args.freshness === "year"
      ? args.freshness
      : undefined;
  const provider = getProvider();
  try {
    const results = await runSearchProvider({ query, count, freshness, signal });
    return {
      content: formatResults(results),
      audit: {
        provider,
        query: query.slice(0, 200),
        count,
        freshness: freshness ?? null,
        results: results.length,
      },
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return {
        content: "interrupted",
        audit: { provider, query: query.slice(0, 200), error: "interrupted" },
      };
    }
    if (e instanceof SearchError) {
      return {
        content: `error: ${e.message}`,
        audit: {
          provider,
          query: query.slice(0, 200),
          error: e.status ? `http_${e.status}` : "search_failed",
        },
      };
    }
    return {
      content: `error: ${(e as Error).message}`,
      audit: { provider, query: query.slice(0, 200), error: "search_failed" },
    };
  }
}

// --- Agent task list -------------------------------------------------------
//
// task_create / task_update / task_list are agent-bookkeeping tools that
// mutate the in-memory store. The TUI's AgentTaskList component subscribes
// to the store and renders pending/in-progress/completed bullets above the
// prompt. In REPL mode the list isn't rendered, but the tools still work —
// the agent can still call task_list to recall what it planned.

let nextTaskId = 1;

function taskCreate(args: Record<string, unknown>): ToolResult {
  const subject = typeof args.subject === "string" ? args.subject.trim() : "";
  if (!subject) {
    return { content: "error: subject is required", audit: { error: "missing_subject" } };
  }
  const activeForm = typeof args.activeForm === "string" ? args.activeForm : undefined;
  const id = String(nextTaskId++);
  const t: AgentTask = { id, subject, status: "pending", activeForm };
  setState((s) => ({ agentTasks: [...s.agentTasks, t] }));
  return {
    content: `ok: created task ${id} (${subject})`,
    audit: { task_id: id, subject, status: "pending" },
  };
}

function taskUpdate(args: Record<string, unknown>): ToolResult {
  const id = typeof args.id === "string" ? args.id : String(args.id ?? "");
  if (!id) return { content: "error: id is required", audit: { error: "missing_id" } };
  const state = getState();
  const idx = state.agentTasks.findIndex((t) => t.id === id);
  if (idx === -1) {
    return { content: `error: no task with id ${id}`, audit: { error: "not_found", id } };
  }
  const cur = state.agentTasks[idx];
  const next: AgentTask = { ...cur };
  if (typeof args.subject === "string" && args.subject.trim()) {
    next.subject = args.subject.trim();
  }
  if (typeof args.activeForm === "string") {
    next.activeForm = args.activeForm;
  }
  if (typeof args.status === "string") {
    if (args.status === "pending" || args.status === "in_progress" || args.status === "completed") {
      next.status = args.status;
    } else {
      return {
        content: `error: invalid status '${args.status}' (must be pending|in_progress|completed)`,
        audit: { error: "invalid_status", id, status: args.status },
      };
    }
  }
  setState((s) => {
    const arr = s.agentTasks.slice();
    arr[idx] = next;
    return { agentTasks: arr };
  });
  return {
    content: `ok: task ${id} → ${next.status} (${next.subject})`,
    audit: { task_id: id, status: next.status, subject: next.subject },
  };
}

function taskList(): ToolResult {
  const tasks = getState().agentTasks;
  if (tasks.length === 0) {
    return { content: "(no tasks)", audit: { count: 0 } };
  }
  const lines = tasks.map(
    (t) => `${t.id}. [${t.status}] ${t.subject}`,
  );
  return {
    content: lines.join("\n"),
    audit: { count: tasks.length },
  };
}
