import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ToolSchema } from "./api.js";
import { confirmBash, confirmEdit, confirmWrite } from "./approval.js";

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
      return runBash(args, ctx);
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

async function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
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
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const MAX = 16_000;
      const trim = (s: string) => (s.length > MAX ? s.slice(0, MAX) + `\n…(truncated, ${s.length - MAX} more chars)` : s);
      const parts: string[] = [];
      parts.push(`exit_code: ${timedOut ? "killed (timeout)" : code}`);
      if (stdout) parts.push(`stdout:\n${trim(stdout)}`);
      if (stderr) parts.push(`stderr:\n${trim(stderr)}`);
      if (!stdout && !stderr) parts.push("(no output)");
      resolve({ content: parts.join("\n") });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ content: `error: ${e.message}` });
    });
  });
}
