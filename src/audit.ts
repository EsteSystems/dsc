import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export function auditLogPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "dsc", "audit.log");
}

// ── Hash chain state ─────────────────────────────────────────────────────
// Each record carries seq, prev_hash, and hash = sha256(prev_hash +
// canonical(entry)). verifyAuditLog() replays the chain to detect tampering.

let _dirEnsured = false;
let _lastHash = "";
let _nextSeq = 1;
let _initialized = false;
let _initPromise: Promise<void> | null = null;
let _queue: Promise<void> = Promise.resolve();

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable JSON text for an entry: object keys sorted, arrays/objects nested. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

async function ensureInitialized(file: string): Promise<void> {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const text = await fs.readFile(file, "utf8");
      const lines = text.split("\n").filter((l) => l.length > 0);
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        const last = JSON.parse(lastLine) as Record<string, unknown>;
        if (typeof last.seq === "number") {
          _nextSeq = last.seq + 1;
          _lastHash = typeof last.hash === "string" ? last.hash : "";
        } else {
          // Legacy un-chained records: start a fresh chain after them.
          _nextSeq = lines.length + 1;
          _lastHash = "";
        }
      }
    } catch {
      // Missing/unreadable/empty log — start a fresh chain.
    }
    _initialized = true;
  })();
  return _initPromise;
}

function enqueue(fn: () => Promise<void>): Promise<void> {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {});
  return run;
}

export function record(entry: Record<string, unknown>): Promise<void> {
  if (process.env.DSC_NO_AUDIT === "1") return Promise.resolve();
  const file = auditLogPath();
  return enqueue(async () => {
    try {
      if (!_dirEnsured) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        _dirEnsured = true;
      }
      await ensureInitialized(file);
      const payload = { ts: new Date().toISOString(), ...entry };
      const prev_hash = _lastHash;
      const seq = _nextSeq;
      const hash = sha256(prev_hash + canonicalize(payload));
      const line = JSON.stringify({ seq, prev_hash, hash, ...payload }) + "\n";
      await fs.appendFile(file, line, "utf8");
      _lastHash = hash;
      _nextSeq = seq + 1;
    } catch {
      // best-effort; never fail a tool call because of audit log issues
    }
  });
}

export interface AuditVerifyResult {
  ok: boolean;
  message: string;
}

/** Test-only: reset in-memory chain state so suites can re-run scenarios. */
export function _resetAuditForTests(): void {
  _dirEnsured = false;
  _lastHash = "";
  _nextSeq = 1;
  _initialized = false;
  _initPromise = null;
  _queue = Promise.resolve();
}

/** Replay the audit log and verify its hash chain + sequence numbers. */
export async function verifyAuditLog(): Promise<AuditVerifyResult> {
  const file = auditLogPath();
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return { ok: true, message: "(no audit log yet)" };
  }

  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: true, message: "(audit log empty)" };

  let prev = "";
  let expectedSeq = 1;
  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, message: `line ${i + 1}: invalid JSON` };
    }
    const { seq, prev_hash, hash, ...payload } = obj;
    if (typeof seq !== "number") {
      return { ok: false, message: `line ${i + 1}: missing seq` };
    }
    if (seq !== expectedSeq) {
      return { ok: false, message: `line ${i + 1}: sequence gap (expected ${expectedSeq}, got ${seq})` };
    }
    if (typeof prev_hash !== "string" || typeof hash !== "string") {
      return { ok: false, message: `line ${i + 1}: missing chain fields` };
    }
    if (prev_hash !== prev) {
      return { ok: false, message: `line ${i + 1}: prev_hash mismatch` };
    }
    const expected = sha256(prev_hash + canonicalize(payload));
    if (hash !== expected) {
      return { ok: false, message: `line ${i + 1}: hash mismatch` };
    }
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, message: `audit ok (${lines.length} records)` };
}
