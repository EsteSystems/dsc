import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  newStats,
  type Message,
  type Model,
  type Stats,
} from "./api.js";

export const LEGACY_HISTORY_FILE = ".dsc-history.json";

/** Human-friendly "Ns/Nm/Nh/Nd ago" for a session's updated_at timestamp.
 *  Used by /list (in the slash dispatcher) to show session recency. */
export function formatRelative(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function sessionsDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "share");
  return path.join(base, "dsc", "sessions");
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model: Model;
  created_at: number;
  updated_at: number;
  message_count: number;
  first_user_message: string;
  /** User-assigned name (via /save). Optional; resume can use it as an alias. */
  name?: string;
  /** Session id this was forked from, if any. */
  forked_from?: string;
}

interface SessionFileV2 {
  version: 2;
  id: string;
  cwd: string;
  model: Model;
  created_at: number;
  updated_at: number;
  messages: Message[];
  stats: Omit<Stats, "files_touched"> & { files_touched: string[] };
  compaction?: CompactionState;
  /** Messages that have been summarized away by /compact. Never sent to
   *  the API; preserved on disk so /transcript can show the full history. */
  archivedMessages?: Message[];
  /** User-assigned name set via /save. */
  name?: string;
  /** Custom prefix shown before streamed assistant turns (default `assistant:`). */
  assistantLabel?: string;
  /** Free-form language directive injected into the system prompt
   *  (e.g. "en", "ro", "Romanian", "formal English"). The model is told
   *  to reply exclusively in this language. */
  language?: string;
  /** Session id this was forked from. */
  forked_from?: string;
}

export interface CompactionState {
  summary: string;
  compacted_at: number;
  turns_removed: number;
}

// v1 was the per-cwd ./.dsc-history.json shape
interface SessionFileV1 {
  version: 1;
  model: Model;
  messages: Message[];
  stats: Omit<Stats, "files_touched"> & { files_touched: string[] };
}

export interface SessionState {
  id: string;
  cwd: string;
  model: Model;
  messages: Message[];
  stats: Stats;
  created_at: number;
  compaction?: CompactionState;
  /** Messages that have been summarized away by /compact. Never sent to
   *  the API; preserved so /transcript can render the full history. */
  archivedMessages?: Message[];
  /** Friendly name set by /save; usable in /resume in addition to id/index. */
  name?: string;
  /** Custom prefix shown before streamed assistant turns (default `assistant:`). */
  assistantLabel?: string;
  /** Force replies in a specific language (free-form). */
  language?: string;
  /** Session id this was forked from. */
  forked_from?: string;
}

function newSessionId(): string {
  return `${Date.now()}-${randomBytes(2).toString("hex")}`;
}

function statsFromPersisted(s: SessionFileV2["stats"] | undefined): Stats {
  const stats = newStats();
  if (!s) return stats;
  stats.prompts = s.prompts ?? 0;
  stats.responses = s.responses ?? 0;
  stats.prompt_tokens = s.prompt_tokens ?? 0;
  stats.completion_tokens = s.completion_tokens ?? 0;
  stats.total_tokens = s.total_tokens ?? 0;
  stats.cache_hit_tokens = s.cache_hit_tokens ?? 0;
  stats.cache_miss_tokens = s.cache_miss_tokens ?? 0;
  stats.tool_calls_total = s.tool_calls_total ?? 0;
  stats.tool_calls_by_name = { ...(s.tool_calls_by_name ?? {}) };
  stats.files_touched = new Set(Array.isArray(s.files_touched) ? s.files_touched : []);
  return stats;
}

function statsToPersisted(stats: Stats): SessionFileV2["stats"] {
  return {
    prompts: stats.prompts,
    responses: stats.responses,
    prompt_tokens: stats.prompt_tokens,
    completion_tokens: stats.completion_tokens,
    total_tokens: stats.total_tokens,
    cache_hit_tokens: stats.cache_hit_tokens,
    cache_miss_tokens: stats.cache_miss_tokens,
    tool_calls_total: stats.tool_calls_total,
    tool_calls_by_name: { ...stats.tool_calls_by_name },
    files_touched: Array.from(stats.files_touched),
  };
}

export function newSession(cwd: string, model: Model): SessionState {
  return {
    id: newSessionId(),
    cwd,
    model,
    messages: [],
    stats: newStats(),
    created_at: Date.now(),
  };
}

export async function saveSession(state: SessionState): Promise<void> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${state.id}.json`);
  const data: SessionFileV2 = {
    version: 2,
    id: state.id,
    cwd: state.cwd,
    model: state.model,
    created_at: state.created_at,
    updated_at: Date.now(),
    messages: state.messages,
    stats: statsToPersisted(state.stats),
    ...(state.compaction ? { compaction: state.compaction } : {}),
    ...(state.archivedMessages?.length
      ? { archivedMessages: state.archivedMessages }
      : {}),
    ...(state.name ? { name: state.name } : {}),
    ...(state.assistantLabel ? { assistantLabel: state.assistantLabel } : {}),
    ...(state.language ? { language: state.language } : {}),
    ...(state.forked_from ? { forked_from: state.forked_from } : {}),
  };
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function loadSession(id: string): Promise<SessionState | null> {
  const file = path.join(sessionsDir(), `${id}.json`);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let data: SessionFileV2;
  try {
    data = JSON.parse(text) as SessionFileV2;
  } catch {
    return null;
  }
  if (!data || data.version !== 2 || !Array.isArray(data.messages)) return null;
  const model: Model = AVAILABLE_MODELS.includes(data.model) ? data.model : DEFAULT_MODEL;
  return {
    id: data.id,
    cwd: data.cwd,
    model,
    messages: data.messages,
    stats: statsFromPersisted(data.stats),
    created_at: data.created_at,
    compaction: data.compaction,
    archivedMessages: data.archivedMessages,
    name: data.name,
    assistantLabel: data.assistantLabel,
    language: data.language,
    forked_from: data.forked_from,
  };
}

export async function listSessions(cwd?: string): Promise<SessionMeta[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    let data: SessionFileV2;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (!data || data.version !== 2) continue;
    if (cwd && data.cwd !== cwd) continue;
    const firstUser = data.messages.find((m) => m.role === "user");
    out.push({
      id: data.id,
      cwd: data.cwd,
      model: data.model,
      created_at: data.created_at,
      updated_at: data.updated_at,
      message_count: data.messages.filter((m) => m.role === "user" || m.role === "assistant").length,
      first_user_message:
        typeof firstUser?.content === "string" ? firstUser.content.slice(0, 80) : "",
      name: data.name,
      forked_from: data.forked_from,
    });
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

/**
 * Fork a session: deep-copy messages into a new session linked to the parent.
 * The fork gets its own id, created_at timestamp, and forked_from pointer.
 * Messages are cloned (not referenced) so independent compaction works.
 */
export async function forkSession(
  parent: SessionState,
  forkName?: string,
): Promise<SessionState> {
  const child: SessionState = {
    id: newSessionId(),
    cwd: parent.cwd,
    model: parent.model,
    messages: structuredClone(parent.messages),
    stats: { ...parent.stats },
    created_at: Date.now(),
    compaction: parent.compaction ? { ...parent.compaction } : undefined,
    archivedMessages: parent.archivedMessages ? [...parent.archivedMessages] : undefined,
    name: forkName,
    forked_from: parent.id,
  };
  await saveSession(child);
  return child;
}

export async function mostRecentForCwd(cwd: string): Promise<SessionMeta | null> {
  const all = await listSessions(cwd);
  return all[0] ?? null;
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await fs.unlink(path.join(sessionsDir(), `${id}.json`));
  } catch {
    // ignore
  }
}

/**
 * Write a session out to `outPath` for transport to another machine.
 *
 * `outPath` resolution:
 *   - if it ends in `/` or is an existing directory → drops a default-named
 *     `<name|id-prefix>-<YYYY-MM-DD>.json` inside it
 *   - otherwise treated as the target filename
 *
 * Returns the actual path written. Throws if the session can't be loaded.
 */
export async function exportSession(id: string, outPath: string): Promise<string> {
  const session = await loadSession(id);
  if (!session) throw new Error(`session not found: ${id}`);

  let target = outPath;
  let dirHint = false;
  try {
    const st = await fs.stat(outPath);
    dirHint = st.isDirectory();
  } catch {
    // outPath doesn't exist yet — treat the trailing slash as a directory hint
    if (outPath.endsWith("/") || outPath.endsWith(path.sep)) dirHint = true;
  }
  if (dirHint) {
    const namePart = (session.name ?? session.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const date = new Date().toISOString().slice(0, 10);
    target = path.join(outPath, `${namePart}-${date}.json`);
  }

  // Re-serialize via the same v2 shape saveSession writes — that way the
  // export round-trips through saveSession on the other end with no schema
  // surprises. updated_at gets refreshed at the moment of export.
  const data: SessionFileV2 = {
    version: 2,
    id: session.id,
    cwd: session.cwd,
    model: session.model,
    created_at: session.created_at,
    updated_at: Date.now(),
    messages: session.messages,
    stats: statsToPersisted(session.stats),
    ...(session.compaction ? { compaction: session.compaction } : {}),
    ...(session.archivedMessages?.length
      ? { archivedMessages: session.archivedMessages }
      : {}),
    ...(session.name ? { name: session.name } : {}),
    ...(session.assistantLabel ? { assistantLabel: session.assistantLabel } : {}),
    ...(session.language ? { language: session.language } : {}),
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(data, null, 2), "utf8");
  return target;
}

export interface ImportOptions {
  /** Rewrite the session's cwd to this directory so auto-resume picks it
   *  up from there. Defaults to keeping the original cwd. */
  rebindCwd?: string;
  /** Optional /save-style name to attach during import. */
  name?: string;
}

/**
 * Read a session from `inPath` and install it into the local sessions dir.
 * Mints a fresh id if one collides with an existing session — the file on
 * disk is whatever we save, never an overwrite of someone else's session.
 *
 * Returns the SessionState as it now lives locally.
 */
export async function importSession(
  inPath: string,
  opts: ImportOptions = {},
): Promise<SessionState> {
  let text: string;
  try {
    text = await fs.readFile(inPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${inPath}: ${(e as Error).message}`);
  }
  // PowerShell-written files can carry a UTF-8 BOM; strip before parsing.
  text = text.replace(/^﻿/, "");

  let data: SessionFileV2;
  try {
    data = JSON.parse(text) as SessionFileV2;
  } catch (e) {
    throw new Error(`invalid JSON in ${inPath}: ${(e as Error).message}`);
  }
  if (!data || data.version !== 2 || !data.id || !Array.isArray(data.messages)) {
    throw new Error(`${inPath} is not a dsc session file (need version 2 with id+messages)`);
  }

  // Collision-safe: if a session with this id already lives locally, mint
  // a fresh one rather than overwrite. The original (remote) id is gone
  // from the local copy after this — annoying for traceability but the
  // safety win is worth more than the audit handle.
  let id = data.id;
  if (await loadSession(id)) {
    id = newSessionId();
  }

  const model: Model = AVAILABLE_MODELS.includes(data.model) ? data.model : DEFAULT_MODEL;
  const session: SessionState = {
    id,
    cwd: opts.rebindCwd ?? data.cwd,
    model,
    messages: data.messages,
    stats: statsFromPersisted(data.stats),
    created_at: data.created_at,
    compaction: data.compaction,
    archivedMessages: data.archivedMessages,
    name: opts.name ?? data.name,
    assistantLabel: data.assistantLabel,
    language: data.language,
  };
  await saveSession(session);
  return session;
}

// Migrate ./.dsc-history.json (v1) into the new sessions dir on startup.
// Returns the new session id if a migration happened.
export async function migrateLegacyIfPresent(cwd: string, model: Model): Promise<string | null> {
  const legacy = path.join(cwd, LEGACY_HISTORY_FILE);
  if (!existsSync(legacy)) return null;
  let text: string;
  try {
    text = await fs.readFile(legacy, "utf8");
  } catch {
    return null;
  }
  let data: SessionFileV1 | SessionFileV2;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || !Array.isArray((data as { messages?: unknown[] }).messages)) return null;
  const stats = statsFromPersisted((data as SessionFileV1).stats);
  const sessionModel: Model = AVAILABLE_MODELS.includes(data.model) ? data.model : model;
  const session: SessionState = {
    id: newSessionId(),
    cwd,
    model: sessionModel,
    messages: (data as SessionFileV1).messages,
    stats,
    created_at: Date.now(),
  };
  await saveSession(session);
  // Best-effort delete of the legacy file
  try {
    await fs.unlink(legacy);
  } catch {
    // ignore
  }
  return session.id;
}
