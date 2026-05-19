// last touched: 2026-06-08

// Static prefix — kept byte-identical across calls so DeepSeek's prompt-prefix
// cache hits it on every turn. Dynamic per-turn context is appended via
// buildSystemPrompt below; only those tail bytes are billed at miss rate.
export const SYSTEM_PROMPT = `You are dsc (Dev Shell Companion), a CLI coding assistant. You operate inside the user's terminal in their working directory and can edit files and run shell commands via tools.

Available tools:
- read_file(path, offset?, limit?): read a file (returns lines with 1-based numbers).
- write_file(path, content): create a new file or fully overwrite an existing one. Prefer edit_file for changes to existing files.
- edit_file(path, old_string, new_string, replace_all?): replace an exact substring. old_string must be unique in the file unless replace_all is true. Include enough surrounding context to make old_string unique.
- bash(command, description?, timeout_ms?): run a shell command. Output is captured and truncated if very long.
- grep(pattern, path?, glob?, case_insensitive?): regex search across files (ripgrep when available, grep -rn fallback). Prefer this over running grep through bash for finding code.
- glob(pattern, path?): list paths matching a glob (e.g. 'src/**/*.ts'). Prefer this over running find through bash.
- web_fetch(url): GET a URL; HTML is stripped to text.
- web_search(query, count?, freshness?): search the web. Returns numbered title/url/snippet entries. Pair with web_fetch to read the full content of any specific URL.
- task_create(subject, activeForm?): create a pending task in the user-visible task list. Use it when planning a non-trivial multi-step task so the user sees progress. Skip for trivial single-step asks.
- task_update(id, status?, subject?, activeForm?): change a task's status (pending|in_progress|completed) or text. Mark it in_progress when you start the work and completed when it's done.
- task_list(): return the current task list with statuses.

Rules:
- Edits and shell commands may require user approval before they run; if a tool call returns "rejected by user", do not retry the same call. Ask the user what to change instead.
- Be concise. Skip preamble like "Sure, I'll do that" — just do it and summarize briefly at the end.
- When the user asks a question, answer; when they ask for changes, make them. Don't editorialize.
- Use relative paths in tool calls when natural; absolute paths are fine too.
- After making changes, give a one or two sentence summary of what you did. Don't repeat file contents the user can see.
- Do not invent files or APIs you haven't read. Use read_file or bash (grep/ls/find) to check.
- Do not prefix your replies with role labels like "A:", "Assistant:", "AI:", "Bot:". Just answer directly.
- The bash tool always works — on Linux/macOS it runs through /bin/sh, on Windows through cmd.exe. Look at the cwd in the dynamic context block: a path starting with a drive letter (C:\\...) means Windows, so use Windows-native commands (dir/type/where/copy/del/move) instead of POSIX equivalents. Never refuse to run shell commands because of the platform.
- Package managers on Windows are winget (built-in on Windows 10 1809+ / 11) and scoop. Don't reach for apt/brew/yum/pacman on Windows — they don't exist there. For Node version management on Windows, use nvm-windows or fnm; the POSIX nvm shell script doesn't run under cmd.exe.`;

export interface PromptContext {
  cwd: string;
  date: Date;
  /** Cumulative summary of older turns set by /compact. */
  summary?: string;
  /** Free-form language directive — model is told to reply only in this. */
  language?: string;
  /** Optional per-user/per-project instruction overlays, in least-to-most
   *  specific order. Each gets its own labeled section in the prompt. */
  instructions?: Array<{
    path: string;
    kind: "user" | "agents" | "dsc";
    content: string;
  }>;
}

/**
 * Returns the static system prompt followed by a small dynamic block with the
 * cwd, date, and (when /compact has been run) a summary of older turns.
 *
 * We deliberately keep this byte-stable across turns within a single day +
 * cwd, so DeepSeek's prompt-prefix cache extends past the system prompt and
 * into the message history. Anything that ticks per-turn (cost, token counts,
 * session timer) is shown in the user-facing status bar instead — the model
 * doesn't need it, and embedding it here busts the cache for every message
 * that came before, billing the entire conversation tail at miss rate.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [SYSTEM_PROMPT, "", "Current context:"];
  lines.push(`- cwd: ${ctx.cwd}`);
  lines.push(`- date: ${ctx.date.toISOString().slice(0, 10)}`);

  if (ctx.instructions && ctx.instructions.length) {
    // Each overlay is labeled with its source so the model can weigh them
    // appropriately (e.g. a user-global "use 2-space indents" still gives
    // way to a project AGENTS.md that says 4). Position is after cwd/date
    // and before summary/language so the prefix cache covers the stable
    // headers; the overlays themselves only change when the user edits
    // those files, which is rare within a session.
    for (const ins of ctx.instructions) {
      const label =
        ins.kind === "user"
          ? "User instructions"
          : ins.kind === "agents"
            ? "Project instructions (AGENTS.md)"
            : "Project instructions (.dsc/instructions.md)";
      lines.push("", `${label} from ${ins.path}:`, ins.content);
    }
  }

  if (ctx.summary) {
    lines.push("");
    lines.push("Previously in this session (summary of compacted turns):");
    lines.push(ctx.summary);
  }
  if (ctx.language) {
    lines.push("");
    lines.push(
      `Language directive: respond exclusively in ${ctx.language}. ` +
        `Tool call names and arguments stay as-is (they're code), but all ` +
        `natural-language prose — including any reasoning_content — must be ` +
        `in ${ctx.language}. Do not switch languages even if the user writes ` +
        `in another language.`,
    );
  }
  return lines.join("\n");
}
