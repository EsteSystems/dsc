import { getConfig, configPath } from "./api.js";

export type ProviderId = "brave" | "tavily" | "ddg";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  query: string;
  count?: number; // 1..20, default 5
  freshness?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
}

export class SearchError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "SearchError";
  }
}

// ─── Provider selection ──────────────────────────────────────────────────────

// Resolution order:
//   1. DSC_SEARCH_PROVIDER env var
//   2. config.search.provider in the deepseek.json
//   3. "ddg" (no key required)
export function getProvider(): ProviderId {
  const env = process.env.DSC_SEARCH_PROVIDER?.trim().toLowerCase();
  if (env === "brave" || env === "tavily" || env === "ddg") return env;
  const cfg = getSearchConfig();
  const fromCfg = typeof cfg?.provider === "string" ? cfg.provider.toLowerCase() : null;
  if (fromCfg === "brave" || fromCfg === "tavily" || fromCfg === "ddg") return fromCfg;
  return "ddg";
}

// Per-provider key resolution:
//   1. {PROVIDER}_API_KEY env var (BRAVE_API_KEY, TAVILY_API_KEY)
//   2. config.search.<provider>.api_key
//   3. null
export function getProviderKey(p: ProviderId): string | null {
  const envName = p === "brave" ? "BRAVE_API_KEY" : p === "tavily" ? "TAVILY_API_KEY" : null;
  if (envName) {
    const v = process.env[envName];
    if (v) return v;
  }
  const cfg = getSearchConfig();
  const sub = cfg?.[p];
  if (sub && typeof sub === "object") {
    const key = (sub as Record<string, unknown>).api_key;
    if (typeof key === "string" && key.length) return key;
  }
  return null;
}

function getSearchConfig(): Record<string, unknown> | null {
  const obj = getConfig();
  if (!obj) return null;
  const s = obj.search;
  if (s && typeof s === "object") return s as Record<string, unknown>;
  return null;
}

// ─── Top-level dispatch ──────────────────────────────────────────────────────

export async function search(opts: SearchOptions): Promise<SearchResult[]> {
  const provider = getProvider();
  switch (provider) {
    case "brave":
      return searchBrave(opts);
    case "tavily":
      return searchTavily(opts);
    case "ddg":
      return searchDuckDuckGo(opts);
  }
}

// ─── Brave Search (api.search.brave.com) ────────────────────────────────────

const BRAVE_FRESHNESS: Record<NonNullable<SearchOptions["freshness"]>, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

async function searchBrave(opts: SearchOptions): Promise<SearchResult[]> {
  const key = getProviderKey("brave");
  if (!key) throw new SearchError(missingKeyMsg("brave", "BRAVE_API_KEY"));
  const params = new URLSearchParams({
    q: opts.query,
    count: String(Math.min(20, Math.max(1, opts.count ?? 5))),
    safesearch: "moderate",
  });
  if (opts.freshness) params.set("freshness", BRAVE_FRESHNESS[opts.freshness]);
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new SearchError(`Brave Search HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: stripHtmlInline(r.description),
  }));
}

// ─── Tavily (api.tavily.com) ────────────────────────────────────────────────

async function searchTavily(opts: SearchOptions): Promise<SearchResult[]> {
  const key = getProviderKey("tavily");
  if (!key) throw new SearchError(missingKeyMsg("tavily", "TAVILY_API_KEY"));
  const body: Record<string, unknown> = {
    api_key: key,
    query: opts.query,
    max_results: Math.min(20, Math.max(1, opts.count ?? 5)),
    search_depth: "basic",
  };
  if (opts.freshness) body.days = freshnessToDays(opts.freshness);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new SearchError(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const data = (await res.json()) as {
    results?: Array<{ title: string; url: string; content: string }>;
  };
  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

function freshnessToDays(f: NonNullable<SearchOptions["freshness"]>): number {
  return f === "day" ? 1 : f === "week" ? 7 : f === "month" ? 30 : 365;
}

// ─── DuckDuckGo (HTML scrape, no key) ───────────────────────────────────────

async function searchDuckDuckGo(opts: SearchOptions): Promise<SearchResult[]> {
  // The "lite" endpoint returns markup that's stable enough to regex.
  // Brittle by nature — DDG can change the layout at any time and break this.
  const params = new URLSearchParams({ q: opts.query });
  const res = await fetch(`https://lite.duckduckgo.com/lite/?${params}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) dsc/0.1",
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new SearchError(`DuckDuckGo HTTP ${res.status}`, res.status);
  }
  const html = await res.text();
  const results = parseDdgLite(html);
  const limit = Math.min(20, Math.max(1, opts.count ?? 5));
  return results.slice(0, limit);
}

function parseDdgLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  // Result link: <a class="result-link" href="...">Title</a>
  // Snippet:    <td class="result-snippet">…</td>
  const linkRe =
    /<a[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi;
  const links: Array<{ url: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    links.push({ url: cleanDdgUrl(decodeEntities(m[1])), title: stripHtmlInline(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtmlInline(m[1]));
  }
  for (let i = 0; i < links.length; i++) {
    out.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? "",
    });
  }
  return out;
}

function cleanDdgUrl(url: string): string {
  // DDG wraps results as /l/?uddg=<encoded>. Unwrap when present.
  const m = url.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return url;
    }
  }
  return url;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripHtmlInline(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function missingKeyMsg(provider: ProviderId, envName: string): string {
  return (
    `${provider} search needs an API key. Either set ${envName}, or add ` +
    `\`{"search": {"${provider}": {"api_key": "..."}}}\` to ${configPath()}.`
  );
}

export function formatResults(results: SearchResult[]): string {
  if (!results.length) return "(no results)";
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet || "(no snippet)"}`)
    .join("\n\n");
}
