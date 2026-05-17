// Shared list of slash-command names. Both the REPL completer and the TUI
// TAB-completion read from this — keep the two in sync by editing here.
// Names are without the leading "/".
export const SLASH_COMMANDS: ReadonlyArray<string> = [
  "api-key",
  "audit",
  "auto-continue",
  "clear",
  "compact",
  "copy",
  "cost",
  "edit",
  "exit",
  "export",
  "help",
  "import",
  "instructions",
  "lang",
  "list",
  "model",
  "queue",
  "quit",
  "reasoning",
  "rename",
  "resume",
  "save",
  "search-key",
  "transcript",
  "update",
  "version",
  "yolo",
];

/**
 * Returns `{ matches, completion }` for the given partial input.
 * - `matches`: every `/<cmd>` that begins with the partial (sorted, unique).
 * - `completion`: the longest shared prefix among matches — when there's a
 *   single match it ends with a trailing space so the user can type args
 *   immediately. Empty string when no completion is possible.
 *
 * Only completes the command word itself; we don't currently complete
 * subcommands like `/queue clear` or `/audit show 20`. Keep it simple.
 */
export function completeSlash(line: string): {
  matches: string[];
  completion: string;
} {
  if (!line.startsWith("/")) return { matches: [], completion: "" };
  const partial = line.slice(1);
  if (partial.includes(" ")) return { matches: [], completion: "" };
  const matches = SLASH_COMMANDS.filter((c) => c.startsWith(partial)).map(
    (c) => "/" + c,
  );
  if (matches.length === 0) return { matches: [], completion: "" };
  if (matches.length === 1) return { matches, completion: matches[0] + " " };
  return { matches, completion: longestCommonPrefix(matches) };
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let pre = strs[0];
  for (let i = 1; i < strs.length && pre.length > 0; i++) {
    while (!strs[i].startsWith(pre)) pre = pre.slice(0, -1);
  }
  return pre;
}
