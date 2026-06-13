import { promises as fsp } from "node:fs";
import * as path from "node:path";

/**
 * Lightweight keyword-based project-context index.  Chunks AGENTS.md,
 * README.md, and recently-edited files into paragraphs, then scores them
 * against a user prompt with simple term-overlap scoring.  Top snippets
 * are prepended to the prompt so the agent sees relevant project docs
 * without needing to grep for them first.
 *
 * Zero external dependencies — no embeddings, no vector DB.  The index is
 * in-memory and session-scoped (rebuilt on /clear).  Paragraphs are
 * ~150–300 characters (clipped at sentence boundaries where possible).
 */

interface Chunk {
  /** File the chunk came from (relative to cwd). */
  file: string;
  /** The paragraph text. */
  text: string;
  /** Pre-computed lowercase word set for scoring. */
  words: Set<string>;
}

const DISCOVER_FILES = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
];

// Strip markdown syntax + punctuation, normalise to lowercase word set.
function tokenise(text: string): Set<string> {
  const cleaned = text
    .replace(/[`*_~#\[\]()>|-]/g, " ")
    .replace(/[.,:;!?"'\/\\{}]/g, " ");
  return new Set(
    cleaned
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

// Split text into ~150–300 char paragraphs, breaking at double-newlines
// or sentence boundaries when a single paragraph is too long.
function chunkFile(text: string, file: string): Chunk[] {
  const raw = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 20);
  const chunks: Chunk[] = [];
  for (const para of raw) {
    if (para.length <= 400) {
      chunks.push({ file, text: para, words: tokenise(para) });
    } else {
      // Split long paragraphs at sentence boundaries
      const sentences = para.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if (buf.length + s.length > 400 && buf.length > 80) {
          chunks.push({ file, text: buf.trim(), words: tokenise(buf.trim()) });
          buf = s;
        } else {
          buf += (buf ? " " : "") + s;
        }
      }
      if (buf.trim().length > 20) {
        chunks.push({ file, text: buf.trim(), words: tokenise(buf.trim()) });
      }
    }
  }
  return chunks;
}

/** Score a chunk against query tokens.  Simple overlap ratio. */
function scoreChunk(chunk: Chunk, queryTokens: Set<string>): number {
  let hits = 0;
  for (const w of queryTokens) {
    if (chunk.words.has(w)) hits++;
  }
  return queryTokens.size > 0 ? hits / queryTokens.size : 0;
}

export class ProjectContext {
  private chunks: Chunk[] = [];
  private indexed = false;

  /** (Re)build the index from discoverable files + extra paths. */
  async build(cwd: string, extraFiles: string[] = []): Promise<void> {
    this.chunks = [];
    const allFiles = [...DISCOVER_FILES, ...extraFiles];
    const seen = new Set<string>();

    for (const rel of allFiles) {
      const abs = path.resolve(cwd, rel);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const stat = await fsp.stat(abs);
        if (!stat.isFile() || stat.size > 200_000) continue; // skip huge files
        const text = await fsp.readFile(abs, "utf-8");
        this.chunks.push(...chunkFile(text, rel));
      } catch {
        // file doesn't exist or can't be read — skip
      }
    }
    this.indexed = true;
  }

  /** Search the index for chunks relevant to `prompt`.  Returns up to
   *  `maxChunks` snippets, sorted by relevance, with a total character
   *  budget of `maxChars`. */
  search(prompt: string, maxChunks = 4, maxChars = 3000): string[] {
    if (!this.indexed || this.chunks.length === 0) return [];
    const queryTokens = tokenise(prompt);
    if (queryTokens.size === 0) return [];

    const scored = this.chunks
      .map((c) => ({ chunk: c, score: scoreChunk(c, queryTokens) }))
      .filter((s) => s.score > 0.05)
      .sort((a, b) => b.score - a.score);

    const result: string[] = [];
    let total = 0;
    for (const { chunk, score } of scored) {
      if (result.length >= maxChunks) break;
      if (total + chunk.text.length > maxChars) break;
      const prefix = score > 0.3 ? `From ${chunk.file}:\n` : "";
      result.push(prefix + chunk.text);
      total += chunk.text.length;
    }
    return result;
  }

  /** Add a newly-touched file to the index (after the agent reads or
   *  edits it).  Call this from the post-turn hook for files that were
   *  actually read/modified. */
  async addFile(cwd: string, relPath: string): Promise<void> {
    const abs = path.resolve(cwd, relPath);
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile() || stat.size > 200_000) return;
      const text = await fsp.readFile(abs, "utf-8");
      // Remove old chunks from this file before re-indexing
      this.chunks = this.chunks.filter((c) => c.file !== relPath);
      this.chunks.push(...chunkFile(text, relPath));
    } catch {
      // skip
    }
  }
}
