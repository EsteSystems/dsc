import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Per-project / per-user instruction overlays. The contents of each file
 * we discover are appended to the system prompt so the model gets project
 * conventions, style notes, and personal preferences without anyone having
 * to type them every turn.
 *
 * Discovery order (least-specific first, most-specific last — later
 * entries effectively override earlier ones because they appear closer to
 * the agent's current turn in the prompt):
 *
 *   1. ~/.config/dsc/instructions.md  (or $XDG_CONFIG_HOME/dsc/instructions.md)
 *      User-global. Personal style preferences, default response language,
 *      "always use ripgrep over grep", etc.
 *
 *   2. AGENTS.md  (walked up from cwd to filesystem root)
 *      The convergent multi-agent convention. Shared with other agents
 *      (Claude Code, Cursor, etc.) that read AGENTS.md. Project-level.
 *
 *   3. .dsc/instructions.md  (walked up from cwd)
 *      Dsc-specific project instructions. Use this when you have rules
 *      that only apply when working through dsc and not other agents.
 *
 * All three are optional. A blank file is treated as absent.
 */

const FILE_SIZE_CAP = 64 * 1024; // 64 KB per file — generous; refuse pathological ones

export interface InstructionFile {
  /** Absolute path to the file. */
  path: string;
  /** One of "user" | "agents" | "dsc" — drives the section header label. */
  kind: "user" | "agents" | "dsc";
  /** Trimmed file content. Won't be empty (callers filter blanks). */
  content: string;
}

function userConfigInstructionsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".config");
  return path.join(base, "dsc", "instructions.md");
}

function readIfPresent(p: string): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile()) return null;
    if (st.size > FILE_SIZE_CAP) {
      // Refuse to embed something huge — that's a bug or attack vector,
      // not a normal instruction file. Skip with no error so the agent
      // still works; the user just won't see the overlay take effect.
      return null;
    }
  } catch {
    return null;
  }
  try {
    const txt = readFileSync(p, "utf8").replace(/^﻿/, "").trim();
    return txt.length > 0 ? txt : null;
  } catch {
    return null;
  }
}

/**
 * Walk up from `start` looking for `relative` (e.g. "AGENTS.md" or
 * ".dsc/instructions.md"). Returns the first match's absolute path, or
 * null. Stops at the filesystem root.
 */
function walkUp(start: string, relative: string): string | null {
  let dir = path.resolve(start);
  // Guard against pathological cycles / weird filesystems by bounding
  // the walk to 40 levels.
  for (let i = 0; i < 40; i++) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Discover all instruction overlays applicable to `cwd`, in the order
 * they should appear in the system prompt (user-global first, project
 * AGENTS.md, then dsc-specific). Returns an empty array when nothing
 * is found.
 */
export function loadInstructions(cwd: string): InstructionFile[] {
  const out: InstructionFile[] = [];

  const userPath = userConfigInstructionsPath();
  const userContent = readIfPresent(userPath);
  if (userContent) out.push({ path: userPath, kind: "user", content: userContent });

  const agentsPath = walkUp(cwd, "AGENTS.md");
  if (agentsPath) {
    const c = readIfPresent(agentsPath);
    if (c) out.push({ path: agentsPath, kind: "agents", content: c });
  }

  const dscPath = walkUp(cwd, path.join(".dsc", "instructions.md"));
  if (dscPath) {
    const c = readIfPresent(dscPath);
    if (c) out.push({ path: dscPath, kind: "dsc", content: c });
  }

  return out;
}
