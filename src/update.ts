import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import { VERSION } from "./version.js";

const PACKAGE_NAME = "@este.systems/dsc";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — npm's once-a-day cadence

function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "dsc");
}
function cachePath(): string {
  return path.join(stateDir(), "version-check.json");
}

interface CheckCache {
  latest: string;
  fetched_at: number;
}

async function readCache(): Promise<CheckCache | null> {
  try {
    const txt = await fsp.readFile(cachePath(), "utf8");
    const parsed = JSON.parse(txt);
    if (typeof parsed?.latest === "string" && typeof parsed?.fetched_at === "number") {
      return parsed;
    }
  } catch {
    // missing / invalid — treat as no cache
  }
  return null;
}

async function writeCache(c: CheckCache): Promise<void> {
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    await fsp.writeFile(cachePath(), JSON.stringify(c, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

async function fetchLatestVersion(signal?: AbortSignal): Promise<string> {
  const res = await fetch(REGISTRY_URL, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`registry returned ${res.status}`);
  const data = (await res.json()) as { version?: string };
  if (typeof data.version !== "string") throw new Error("malformed registry response");
  return data.version;
}

/**
 * Compare two semver-ish strings (X.Y.Z, ignoring pre-release tails). Returns
 * -1 if a < b, 0 if equal, 1 if a > b. Non-numeric segments compare as 0
 * so we don't accidentally flag "0.3.0-beta.1" as newer than "0.3.0".
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string) =>
    s.split(/[.+-]/, 3).map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export interface UpdateCheck {
  current: string;
  latest: string;
  newerAvailable: boolean;
  fromCache: boolean;
}

/**
 * Returns the latest published version from npm, with a 24h on-disk cache so
 * we don't hammer the registry every launch. Resolves on network failure too
 * — falls back to whatever cached value exists, or just reports current as
 * latest. Designed to be called fire-and-forget at startup.
 *
 * When `force` is true the cache is ignored and a fresh fetch happens. Use
 * for `/update`-style explicit checks.
 */
export async function checkForUpdate(
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<UpdateCheck> {
  const current = VERSION;
  const cache = await readCache();
  const fresh = cache && Date.now() - cache.fetched_at < CACHE_TTL_MS;
  if (fresh && !opts.force && cache) {
    return {
      current,
      latest: cache.latest,
      newerAvailable: compareSemver(cache.latest, current) > 0,
      fromCache: true,
    };
  }
  try {
    const latest = await fetchLatestVersion(opts.signal);
    await writeCache({ latest, fetched_at: Date.now() });
    return {
      current,
      latest,
      newerAvailable: compareSemver(latest, current) > 0,
      fromCache: false,
    };
  } catch {
    // Network down / registry hiccup — surface whatever we last knew. If we
    // never knew, claim "up to date" so we don't false-positive an upgrade.
    const latest = cache?.latest ?? current;
    return {
      current,
      latest,
      newerAvailable: compareSemver(latest, current) > 0,
      fromCache: !!cache,
    };
  }
}

export interface UpdateResult {
  ok: boolean;
  output: string;
}

/**
 * Runs `npm install -g <package>@latest`. Streams nothing — we wait for the
 * whole install to finish and return its combined output. Suitable behind
 * the /update slash command, where the user has explicitly asked.
 *
 * The currently-running dsc process keeps running on the old code (Node
 * has already loaded everything into memory). The caller should advise a
 * restart after success.
 */
export function runUpdate(signal?: AbortSignal): Promise<UpdateResult> {
  return new Promise<UpdateResult>((resolve) => {
    // shell: true so Windows finds npm.cmd; on POSIX it's just `sh -c` which
    // is harmless. Single quoted argv so spaces in package names don't bite.
    const child = spawn("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: ok && !aborted, output: out.trim() });
    };
    child.on("exit", (code) => settle(code === 0));
    child.on("error", (e) => {
      out += `\nspawn error: ${e.message}`;
      settle(false);
    });
  });
}
