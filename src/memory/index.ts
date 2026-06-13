/**
 * Memory module public API — exposes the same surface as the MCP memory server,
 * but runs natively inside dsc with zero subprocess / Python dependency.
 *
 * Key design decisions:
 * - No embeddings — keyword overlap scoring instead (see graph.ts)
 * - Background extraction queue (same as Python worker thread pattern)
 * - Auto-migration: reads existing Python memory.db if it exists
 */

import Database from "better-sqlite3";
import {
  getDb,
  closeDb,
  insertNode,
  getNode,
  search,
  findCandidates,
  linkNode,
  activate,
  decayAll,
  queryAndActivate,
  getTensions,
  getEdges,
  getStats,
  SearchResult,
  Tension,
  GraphStats,
  GraphEdge,
} from "./graph.js";
import { extractPropositions, classifyRelationships } from "./extraction.js";

// ── Config ────────────────────────────────────────────────────────────

let _enabled = false;
let _model = "";

export function isEnabled(): boolean {
  return _enabled;
}

export function setEnabled(v: boolean): void {
  _enabled = v;
}

export function setModel(model: string): void {
  _model = model;
}

// ── API call shim ─────────────────────────────────────────────────────
// Memory calls the LLM directly (not through the agent loop), so we need
// a reference to the API call function. The TUI sets this at boot.

type ApiCallFn = (
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
) => Promise<string>;

let _apiCall: ApiCallFn | null = null;

export function setApiCall(fn: ApiCallFn): void {
  _apiCall = fn;
}

function apiCall(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens?: number,
): Promise<string> {
  if (!_apiCall) throw new Error("memory: apiCall not set — call setApiCall() at boot");
  return _apiCall(model, messages, maxTokens);
}

// ── Background extraction queue ───────────────────────────────────────

interface ExtractionJob {
  text: string;
  source: string | null;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
}

const _jobQueue: ExtractionJob[] = [];
let _workerRunning = false;

function startWorker(): void {
  if (_workerRunning) return;
  _workerRunning = true;

  (async () => {
    while (true) {
      const job = _jobQueue.shift();
      if (!job) {
        // Idle — wait before checking again
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      try {
        const db = getDb();
        try {
          // 1. Extract propositions
          const props = await extractPropositions(
            job.text,
            _model,
            apiCall,
          );

          if (props.length === 0) {
            job.resolve(
              `Extracted 0 propositions (${job.text.length} chars). Try more structured input.`,
            );
            continue;
          }

          // 2. For each proposition: insert, find candidates, classify, link
          for (const prop of props) {
            const nodeId = insertNode(db, prop, job.source);
            const candidates = findCandidates(db, nodeId, prop);
            if (candidates.length > 0) {
              const relationships = await classifyRelationships(
                prop,
                candidates,
                _model,
                apiCall,
              );
              linkNode(db, nodeId, prop, relationships, candidates);
            }
          }

          job.resolve(
            `Stored ${props.length} propositions. Run getStats() to see the graph.`,
          );
        } finally {
          // Don't close — db is shared. Let the module manage lifecycle.
        }
      } catch (err: any) {
        try {
          job.reject(err);
        } catch {
          // ignore double-reject
        }
      }
    }
  })();
}

// ── Public API (tool-equivalents) ─────────────────────────────────────

export function storePropositions(
  text: string,
  source: string | null = null,
): Promise<string> {
  if (!_enabled) return Promise.resolve("Memory is disabled. Set 'memory.enabled' in config to activate.");
  startWorker();

  return new Promise((resolve, reject) => {
    _jobQueue.push({ text, source, resolve, reject });
  });
}

export function queryMemory(
  query: string,
  n: number = 5,
): string {
  if (!_enabled) return "Memory is disabled.";
  const db = getDb();
  const results = queryAndActivate(db, query, n);
  if (results.length === 0) return "No relevant propositions found.";
  return results
    .map(
      (r: SearchResult) =>
        `  [${r.id}] sim=${r.similarity.toFixed(3)} w=${r.weight.toFixed(2)}  ${r.text}`,
    )
    .join("\n");
}

export function queryMemoryRaw(
  query: string,
  n: number = 5,
): SearchResult[] {
  if (!_enabled) return [];
  const db = getDb();
  return queryAndActivate(db, query, n);
}

export function surfaceTensions(threshold: number = 0.3): string {
  if (!_enabled) return "Memory is disabled.";
  const db = getDb();
  const tensions = getTensions(db, threshold);
  if (tensions.length === 0) return "No tensions found.";
  return tensions
    .map(
      (t: Tension) =>
        `  [${t.from_id}]↔[${t.to_id}] w=${t.from_weight}/${t.to_weight}  ${t.from_text} ⟂ ${t.to_text}`,
    )
    .join("\n");
}

export function getNodeDetail(nodeId: number): string {
  if (!_enabled) return "Memory is disabled.";
  const db = getDb();
  const node = getNode(db, nodeId);
  if (!node) return `Node ${nodeId} not found.`;

  const edges = getEdges(db, nodeId);
  const lines = [
    `[${node.id}] w=${node.weight.toFixed(2)} acts=${node.activation_count}  ${node.text}`,
    `  source: ${node.source || "(none)"}`,
    `  edges (${edges.length}):`,
  ];

  for (const e of edges) {
    const direction = e.from_id === nodeId ? "→" : "←";
    const other = e.from_id === nodeId ? e.to_text : e.from_text;
    lines.push(`    ${direction} [${e.type}] ${other}`);
  }

  return lines.join("\n");
}

export function memoryStats(): string {
  if (!_enabled) return "Memory is disabled.";
  const db = getDb();
  const stats = getStats(db);
  return (
    `Graph: ${stats.nodes} nodes, ${stats.edges} edges\n` +
    `Average weight: ${stats.avg_weight}\n` +
    `Edge types: ${JSON.stringify(stats.edge_types)}`
  );
}

export function memoryDecay(hours: number = 24): string {
  if (!_enabled) return "Memory is disabled.";
  const db = getDb();
  const n = decayAll(db, hours);
  const stats = getStats(db);
  return `Decayed ${n} nodes over ${hours}h. Average weight now: ${stats.avg_weight}`;
}

// ── Auto-query integration ────────────────────────────────────────────

/**
 * Called before every agent turn. Searches memory for relevant
 * propositions and returns them as a string to prepend to context.
 * Returns empty string if disabled or nothing found.
 */
export function autoQueryContext(prompt: string): string {
  if (!_enabled) return "";
  const db = getDb();
  const results = queryAndActivate(db, prompt, 3);

  if (results.length === 0) return "";

  const lines = ["[memory context]"];
  for (const r of results) {
    lines.push(`  [${r.id}] ${r.text}`);
  }
  return lines.join("\n");
}
