import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export function auditLogPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "dsc", "audit.log");
}

let _dirEnsured = false;

export async function record(entry: Record<string, unknown>): Promise<void> {
  if (process.env.DSC_NO_AUDIT === "1") return;
  const file = auditLogPath();
  try {
    if (!_dirEnsured) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      _dirEnsured = true;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await fs.appendFile(file, line, "utf8");
  } catch {
    // best-effort; never fail a tool call because of audit log issues
  }
}
