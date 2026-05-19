/**
 * Persistent user preferences set via slash commands.
 *
 * Stored at `$XDG_CONFIG_HOME/dsc/preferences.json` (default
 * `~/.config/dsc/preferences.json`) — deliberately a separate file
 * from the API-credential `deepseek.json` so dsc's UI prefs don't
 * mix with secrets and so removing one doesn't affect the other.
 *
 * What's persisted (only toggle-shaped settings the user explicitly
 * sets via slash):
 *
 *   yolo          /yolo
 *   reasoning     /reasoning [on|off]
 *   autoContinue  /auto-continue [N|off]
 *   budgetUsd     /budget [usd|off]
 *
 * What's NOT persisted: anything per-session (model, language,
 * assistant label, session name) — those already live in the session
 * JSON so they ride along with /resume.
 *
 * yolo and an active budget are flagged at boot via a loud system
 * message in the TUI so a forgotten-from-last-launch setting can't
 * silently bypass approvals or abort an unexpected turn.
 */

import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

export interface Preferences {
  yolo?: boolean;
  reasoning?: boolean;
  autoContinue?: number;
  budgetUsd?: number;
}

export function preferencesPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".config");
  return path.join(base, "dsc", "preferences.json");
}

/**
 * Read the saved preferences. Returns an empty object when the file
 * doesn't exist or can't be parsed — we never want a corrupt preferences
 * file to keep dsc from booting.
 */
export async function readPreferences(): Promise<Preferences> {
  let text: string;
  try {
    text = await fsp.readFile(preferencesPath(), "utf8");
  } catch {
    return {};
  }
  // Strip BOM PowerShell might have left.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Preferences = {};
    if (typeof parsed.yolo === "boolean") out.yolo = parsed.yolo;
    if (typeof parsed.reasoning === "boolean") out.reasoning = parsed.reasoning;
    if (typeof parsed.autoContinue === "number" && Number.isFinite(parsed.autoContinue)) {
      out.autoContinue = parsed.autoContinue;
    }
    if (typeof parsed.budgetUsd === "number" && Number.isFinite(parsed.budgetUsd) && parsed.budgetUsd > 0) {
      out.budgetUsd = parsed.budgetUsd;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merge `updates` into the on-disk preferences file. Pass `null` to
 * remove a key (so `/yolo` → off can clear the saved value rather than
 * persist `yolo: false`). Atomic write via tmp + rename so a crashed
 * write can't leave a partial file. Returns the file path written to.
 */
export async function savePreferences(
  updates: { [K in keyof Preferences]: Preferences[K] | null },
): Promise<string> {
  const p = preferencesPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });

  const current = await readPreferences();
  const next: Preferences = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    const k = key as keyof Preferences;
    if (value === null || value === undefined) {
      delete next[k];
    } else {
      (next as Record<string, unknown>)[k] = value;
    }
  }

  const tmp = p + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fsp.rename(tmp, p);
  try {
    await fsp.chmod(p, 0o600);
  } catch {
    // POSIX-only; ignore on Windows
  }
  return p;
}

/** Delete the preferences file entirely. Best-effort. */
export async function clearPreferences(): Promise<void> {
  try {
    await fsp.unlink(preferencesPath());
  } catch {
    // already gone — fine
  }
}
