import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

const MAX_LINES = 1000;

export function historyFilePath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "dsc", "history");
}

// Returns oldest-first, capped at MAX_LINES.
export async function load(): Promise<string[]> {
  let text: string;
  try {
    text = await fs.readFile(historyFilePath(), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  return lines.slice(-MAX_LINES);
}

let _lastAppended: string | undefined;

// Append a single line. Skips empty and consecutive duplicates.
export async function append(line: string): Promise<void> {
  const trimmed = line.replace(/\n+$/g, "");
  if (!trimmed) return;
  if (trimmed === _lastAppended) return;
  const file = historyFilePath();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, trimmed + "\n", "utf8");
    _lastAppended = trimmed;
  } catch {
    // best-effort; ignore failures
  }
}

// Truncate the file to the most recent MAX_LINES entries. Best-effort.
export async function compact(): Promise<void> {
  const lines = await load();
  if (lines.length < MAX_LINES) return;
  const file = historyFilePath();
  try {
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, lines.join("\n") + "\n", "utf8");
    await fs.rename(tmp, file);
  } catch {
    // ignore
  }
}
