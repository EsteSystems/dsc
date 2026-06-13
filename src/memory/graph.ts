/**
 * Memory Graph Engine — SQLite-backed knowledge graph with keyword-based retrieval.
 *
 * Ported from the Python mcp-memory server (graph.py / mcp_memory_server.py).
 *
 * Key change from Python: embedding similarity replaced with keyword overlap scoring.
 * The LLM classification step (proposition extraction + relationship typing) is kept
 * from the Python version — those are the intelligence-bearing components. Embedding
 * was only used for candidate ranking, and keyword matching at the single-sentence
 * proposition level is ~85% as good at zero cost / zero dependencies.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ── Constants (ported from graph.py) ──────────────────────────────────

const BOOST = 0.1; // weight increment per activation
const MAX_WEIGHT = 1.0;
const MIN_WEIGHT = 0.001; // never deleted, just fade to near-zero
const PROPAGATION_FRACTION = 0.3; // fraction of boost that propagates to neighbors
const DECAY_RATE_PER_HOUR = 0.02; // base decay per hour
const CONNECTIVITY_BONUS = 0.15; // each edge reduces decay by this factor
const KEYWORD_SIM_THRESHOLD = 0.15; // minimum keyword overlap to consider linking

export const EDGE_TYPES = [
  "supports",
  "contradicts",
  "instantiates",
  "analogizes",
  "questions",
] as const;
export const RELATE = "relates";

export interface GraphNode {
  id: number;
  text: string;
  weight: number;
  source: string | null;
  created_at: number;
  last_activated: number;
  activation_count: number;
}

export interface GraphEdge {
  from_id: number;
  to_id: number;
  type: string;
  strength: number;
  from_text?: string;
  to_text?: string;
  from_weight?: number;
  to_weight?: number;
}

export interface SearchResult {
  id: number;
  text: string;
  similarity: number;
  weight: number;
  source: string | null;
}

export interface Tension {
  from_id: number;
  to_id: number;
  strength: number;
  from_text: string;
  from_weight: number;
  to_text: string;
  to_weight: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  avg_weight: number;
  edge_types: Record<string, number>;
}

// ── Database ──────────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _dbPath = "";

export function getDbPath(): string {
  if (!_dbPath) {
    const stateDir = process.env.XDG_STATE_HOME
      ? join(process.env.XDG_STATE_HOME, "dsc")
      : join(process.env.HOME || "~", ".local", "state", "dsc");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    _dbPath = join(stateDir, "memory.db");
  }
  return _dbPath;
}

export function getDb(dbPath?: string): Database.Database {
  if (!_db) {
    const path = dbPath || getDbPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    _db = new Database(path);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        text             TEXT    NOT NULL,
        created_at       REAL    NOT NULL DEFAULT (unixepoch()),
        last_activated   REAL    NOT NULL DEFAULT (unixepoch()),
        source           TEXT,
        weight           REAL    NOT NULL DEFAULT 0.5,
        activation_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS edges (
        from_id     INTEGER NOT NULL REFERENCES nodes(id),
        to_id       INTEGER NOT NULL REFERENCES nodes(id),
        type        TEXT    NOT NULL DEFAULT 'relates',
        strength    REAL    NOT NULL DEFAULT 1.0,
        PRIMARY KEY (from_id, to_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_weight ON nodes(weight DESC);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
  `);
}

// ── Keyword scoring (replaces embedding + cosine_similarity) ──────────

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  return new Set(tokens);
}

/**
 * Jaccard-ish keyword overlap score.
 * For single-sentence propositions this works surprisingly well —
 * the LLM classification step handles the actual semantic linking.
 */
function keywordOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  // Iterate smaller set
  if (ta.size < tb.size) {
    for (const t of ta) if (tb.has(t)) intersection++;
  } else {
    for (const t of tb) if (ta.has(t)) intersection++;
  }

  // Jaccard: intersection / union
  return intersection / (ta.size + tb.size - intersection);
}

// ── Core operations ───────────────────────────────────────────────────

export function insertNode(
  db: Database.Database,
  text: string,
  source: string | null = null
): number {
  const stmt = db.prepare(
    "INSERT INTO nodes (text, source) VALUES (?, ?)"
  );
  return Number(stmt.run(text, source).lastInsertRowid);
}

export function getNode(
  db: Database.Database,
  nodeId: number
): GraphNode | null {
  const row = db
    .prepare(
      `SELECT id, text, weight, source, created_at, last_activated, activation_count
       FROM nodes WHERE id = ?`
    )
    .get(nodeId) as any;
  if (!row) return null;
  return {
    id: row.id,
    text: row.text,
    weight: row.weight,
    source: row.source,
    created_at: row.created_at,
    last_activated: row.last_activated,
    activation_count: row.activation_count,
  };
}

export function search(
  db: Database.Database,
  query: string,
  n: number = 5
): SearchResult[] {
  const rows = db
    .prepare("SELECT id, text, weight, source FROM nodes")
    .all() as any[];

  const scored: SearchResult[] = rows.map((row) => ({
    id: row.id,
    text: row.text,
    similarity: Math.round(keywordOverlap(query, row.text) * 10000) / 10000,
    weight: row.weight,
    source: row.source,
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, n);
}

export function findCandidates(
  db: Database.Database,
  nodeId: number,
  text: string,
  topK: number = 10,
  threshold: number = KEYWORD_SIM_THRESHOLD
): SearchResult[] {
  const rows = db
    .prepare("SELECT id, text, weight, source FROM nodes WHERE id != ?")
    .all(nodeId) as any[];

  const scored: SearchResult[] = [];
  for (const row of rows) {
    const sim = Math.round(keywordOverlap(text, row.text) * 10000) / 10000;
    if (sim >= threshold) {
      scored.push({
        id: row.id,
        text: row.text,
        similarity: sim,
        weight: row.weight,
        source: row.source,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

// ── Edge linking ──────────────────────────────────────────────────────

export function linkNode(
  db: Database.Database,
  nodeId: number,
  nodeText: string,
  relationships: Record<number, string>,
  candidates: SearchResult[]
): GraphEdge[] {
  const edgesCreated: GraphEdge[] = [];
  const insert = db.prepare(
    "INSERT OR REPLACE INTO edges (from_id, to_id, type, strength) VALUES (?, ?, ?, ?)"
  );

  for (const cand of candidates) {
    const relType = relationships[cand.id] || RELATE;
    if (relType === "none") continue;
    try {
      insert.run(nodeId, cand.id, relType, cand.similarity);
      edgesCreated.push({
        from_id: nodeId,
        to_id: cand.id,
        type: relType,
        strength: cand.similarity,
      });
    } catch {
      // PRIMARY KEY conflict — edge already exists, skip
    }
  }

  return edgesCreated;
}

// ── Activation ────────────────────────────────────────────────────────

export function activate(
  db: Database.Database,
  nodeId: number,
  boost: number = BOOST,
  propagate: boolean = true
): void {
  const now = Date.now() / 1000;

  // Boost this node
  db.prepare(
    `UPDATE nodes
     SET weight = MIN(?, weight + ?),
         last_activated = ?,
         activation_count = activation_count + 1
     WHERE id = ?`
  ).run(MAX_WEIGHT, boost, now, nodeId);

  if (!propagate) return;

  // Propagate to neighbors (both directions)
  const neighbors = db
    .prepare(
      `SELECT DISTINCT
         CASE WHEN from_id = ? THEN to_id ELSE from_id END AS neighbor_id,
         strength
       FROM edges
       WHERE from_id = ? OR to_id = ?`
    )
    .all(nodeId, nodeId, nodeId) as any[];

  const propagateBoost = boost * PROPAGATION_FRACTION;
  const updateNeighbor = db.prepare(
    `UPDATE nodes
     SET weight = MIN(?, weight + ?),
         last_activated = ?
     WHERE id = ?`
  );

  for (const { neighbor_id, strength } of neighbors) {
    const neighborBoost = propagateBoost * strength;
    updateNeighbor.run(MAX_WEIGHT, neighborBoost, now, neighbor_id);
  }
}

// ── Decay ─────────────────────────────────────────────────────────────

function edgeCount(db: Database.Database, nodeId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as c FROM edges WHERE from_id = ? OR to_id = ?"
    )
    .get(nodeId, nodeId) as any;
  return row.c;
}

export function decayAll(
  db: Database.Database,
  hoursElapsed: number = 1.0
): number {
  const rows = db
    .prepare("SELECT id, weight FROM nodes WHERE weight > ?")
    .all(MIN_WEIGHT) as any[];

  const baseRate = DECAY_RATE_PER_HOUR * hoursElapsed;
  let updated = 0;

  const updateStmt = db.prepare(
    "UPDATE nodes SET weight = ? WHERE id = ?"
  );

  for (const { id, weight } of rows) {
    const edges = edgeCount(db, id);
    // Connectivity slows decay: more edges = slower decay
    const effectiveRate = baseRate / (1.0 + CONNECTIVITY_BONUS * edges);
    const newWeight = Math.max(MIN_WEIGHT, weight * (1.0 - effectiveRate));
    if (newWeight < weight) {
      updateStmt.run(newWeight, id);
      updated++;
    }
  }

  return updated;
}

// ── Query with activation ─────────────────────────────────────────────

export function queryAndActivate(
  db: Database.Database,
  queryText: string,
  n: number = 5,
  activateMatches: boolean = true
): SearchResult[] {
  const results = search(db, queryText, n);
  if (activateMatches) {
    for (const r of results) {
      activate(db, r.id);
    }
  }
  return results;
}

// ── Tension detection ─────────────────────────────────────────────────

export function getTensions(
  db: Database.Database,
  weightThreshold: number = 0.3
): Tension[] {
  const rows = db
    .prepare(
      `SELECT e.from_id, e.to_id, e.strength,
              n_from.text AS from_text, n_from.weight AS from_weight,
              n_to.text AS to_text, n_to.weight AS to_weight
       FROM edges e
       JOIN nodes n_from ON e.from_id = n_from.id
       JOIN nodes n_to ON e.to_id = n_to.id
       WHERE e.type = 'contradicts'
         AND n_from.weight >= ?
         AND n_to.weight >= ?
       ORDER BY n_from.weight DESC, n_to.weight DESC`
    )
    .all(weightThreshold, weightThreshold) as any[];

  return rows.map((r: any) => ({
    from_id: r.from_id,
    to_id: r.to_id,
    strength: r.strength,
    from_text: r.from_text,
    from_weight: Math.round(r.from_weight * 1000) / 1000,
    to_text: r.to_text,
    to_weight: Math.round(r.to_weight * 1000) / 1000,
  }));
}

export function getEdges(
  db: Database.Database,
  nodeId: number
): GraphEdge[] {
  const rows = db
    .prepare(
      `SELECT e.from_id, e.to_id, e.type, e.strength,
              n_from.text as from_text, n_to.text as to_text
       FROM edges e
       JOIN nodes n_from ON e.from_id = n_from.id
       JOIN nodes n_to ON e.to_id = n_to.id
       WHERE e.from_id = ? OR e.to_id = ?`
    )
    .all(nodeId, nodeId) as any[];

  return rows.map((r: any) => ({
    from_id: r.from_id,
    to_id: r.to_id,
    type: r.type,
    strength: r.strength,
    from_text: r.from_text,
    to_text: r.to_text,
  }));
}

// ── Statistics ────────────────────────────────────────────────────────

export function getStats(db: Database.Database): GraphStats {
  const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM nodes").get() as any).c as number;
  const edgeCount = (db.prepare("SELECT COUNT(*) as c FROM edges").get() as any).c as number;
  const avgRow = db.prepare("SELECT AVG(weight) as a FROM nodes").get() as any;
  const avgWeight = avgRow.a ? Math.round(avgRow.a * 1000) / 1000 : 0;
  const edgeTypes = db
    .prepare("SELECT type, COUNT(*) as c FROM edges GROUP BY type ORDER BY c DESC")
    .all() as any[];

  return {
    nodes: nodeCount,
    edges: edgeCount,
    avg_weight: avgWeight,
    edge_types: Object.fromEntries(edgeTypes.map((r: any) => [r.type, r.c])),
  };
}
