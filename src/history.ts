import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  newStats,
  type Message,
  type Model,
  type Stats,
} from "./api.js";

export const HISTORY_FILE = ".dsc-history.json";

interface PersistedShape {
  version: 1;
  model: Model;
  messages: Message[];
  stats: Omit<Stats, "files_touched"> & { files_touched: string[] };
}

export function historyPath(cwd: string): string {
  return path.join(cwd, HISTORY_FILE);
}

export async function load(
  cwd: string,
): Promise<{ messages: Message[]; stats: Stats; model: Model } | null> {
  const file = historyPath(cwd);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let data: PersistedShape;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.version !== 1 || !Array.isArray(data.messages)) return null;

  const stats = newStats();
  const s = data.stats;
  if (s) {
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
  }
  const model: Model = AVAILABLE_MODELS.includes(data.model) ? data.model : DEFAULT_MODEL;
  return { messages: data.messages, stats, model };
}

export async function save(
  cwd: string,
  messages: Message[],
  stats: Stats,
  model: Model,
): Promise<void> {
  const file = historyPath(cwd);
  const data: PersistedShape = {
    version: 1,
    model,
    messages,
    stats: {
      ...stats,
      files_touched: Array.from(stats.files_touched),
    },
  };
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function clear(cwd: string): Promise<void> {
  try {
    await fs.unlink(historyPath(cwd));
  } catch {
    // ignore
  }
}
