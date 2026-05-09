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
    });
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
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
