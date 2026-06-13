/**
 * `dsc serve` — HTTP + WebSocket daemon for headless dsc.
 *
 * HTTP:
 *   GET  /health              → {"ok":true,"pid":<n>}
 *   POST /chat                → SSE stream of agent response
 *        Body: {"prompt":"...", "session_id?":"..."}
 *        Auth: Bearer <token> header or ?token=<t> query param
 *
 * WebSocket:
 *   ws://127.0.0.1:<port>     → existing protocol (serve_protocol.ts)
 *
 * Usage:  dsc serve [--port <n>]
 *
 * Auth: DSC_SERVE_TOKEN env var, or `serve.token` in config.json.
 *       If neither is set, no auth is required (dev mode).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import * as url from "node:url";

import { runAgent, estimateContextTokens, formatCost } from "./agent.js";
import type { Message, ToolSchema, Model } from "./api.js";
import { newStats, DEFAULT_MODEL, getConfig } from "./api.js";
import { connectAll, closeAll, callMCPTool } from "./mcp.js";
import type { ToolContext } from "./tools.js";
import { compactSession } from "./compact.js";
import {
  newSession,
  saveSession,
  loadSession,
  type SessionState,
  type CompactionState,
} from "./history.js";
import { dispatchSlash, type SlashContext } from "./slash_dispatch.js";
import * as memory from "./memory/index.js";
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  type ClientMessage,
} from "./serve_protocol.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = Number(process.env.DSC_SERVE_PORT) || 9090;
const AUTO_COMPACT_AT = (() => {
  const v = process.env.DSC_AUTO_COMPACT_AT;
  if (!v || v === "0" || v === "off" || v === "false") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
})();
const AUTO_COMPACT_KEEP = (() => {
  const v = process.env.DSC_AUTO_COMPACT_KEEP;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();

function resolveAuthToken(): string | null {
  // env var wins
  const env = process.env.DSC_SERVE_TOKEN;
  if (env) return env;
  // config.json
  try {
    const cfg = getConfig();
    const serve = (cfg as any).serve;
    if (serve && typeof serve.token === "string" && serve.token.length > 0) {
      return serve.token;
    }
  } catch { /* ignore */ }
  return null;
}

function checkAuth(req: IncomingMessage): boolean {
  const token = resolveAuthToken();
  if (!token) return true; // no auth configured — allow all

  // Bearer header
  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match && match[1] === token) return true;
  }

  // Query param
  const parsed = url.parse(req.url ?? "", true);
  if (parsed.query.token === token) return true;

  return false;
}

// ── State ───────────────────────────────────────────────────────────

const pendingApprovals = new Map<
  number,
  { resolve: (ans: string) => void }
>();

let approvalIdCounter = 0;

// ── Helpers ─────────────────────────────────────────────────────────

function send(ws: WebSocket, msg: ServerMessage): void {
  const text = JSON.stringify(msg);
  ws.send(text, (err: Error | undefined) => {
    if (err && ws.readyState === WebSocket.OPEN) {
      // Best-effort.
    }
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(text)),
  });
  res.end(text);
}

function sse(res: ServerResponse): {
  emit: (type: string, data: string) => void;
  done: () => void;
} {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return {
    emit(type: string, data: string) {
      res.write(`event: ${type}\ndata: ${data}\n\n`);
    },
    done() {
      res.end();
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

// ── Slash context for serve mode ────────────────────────────────────

function serveSlashContext(
  emit: (text: string) => void,
  getModel: () => Model,
  getMessages: () => Message[],
  getSessionId: () => string,
  clearSession: () => void,
  compactFn: () => Promise<void>,
): SlashContext {
  const cwd = process.cwd();
  const stats = newStats();
  const sessionState: SessionState = {
    id: getSessionId(),
    cwd,
    model: getModel(),
    messages: getMessages(),
    stats,
    created_at: Date.now(),
  };

  return {
    cwd,
    emit,
    getModel,
    getStats: () => stats,
    getSession: () => sessionState,
    getMessages,
    getToolCtx: () => ({ cwd, yolo: false, sessionId: getSessionId(), sessionApprovals: new Set(), filesTouched: new Set() }),
    getQueue: () => [],
    getBudget: () => ({ usd: null, warned: false }),
    getMcpConnections: () => [],
    setModel: (_m: Model) => {},
    setBudget: () => {},
    persist: async () => {},
    syncStatus: () => {},
    compact: async (_keep: number, _auto: boolean) => { await compactFn(); },
    submit: (_text: string) => { emit("nested submit not available in serve mode"); },
    applySession: (_next: SessionState, _opts: any) => { emit("session swap not available in serve mode"); },
    runEditor: (_initial: string) => { emit("editor:/edit not available in serve mode"); return null; },
    exit: () => {},
    getPlan: () => null,
    setPlan: (_p: any) => {},
    runBashCommand: async (command: string) => {
      const { execSync } = await import("node:child_process");
      try {
        return execSync(command, { encoding: "utf8", timeout: 30000 });
      } catch (e: any) {
        return `error: ${e.message}`;
      }
    },
  };
}

// ── Agent run helper ────────────────────────────────────────────────

interface RunOptions {
  model: Model;
  messages: Message[];
  extraTools: ToolSchema[];
  connections: Awaited<ReturnType<typeof connectAll>>["connections"];
  signal?: AbortSignal;
  maxAutoContinue?: number;
  onToken?: (chunk: string) => void;
  onThinking?: (chunk: string) => void;
  onTool?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, content: string, rejected: boolean) => void;
  onNotice?: (text: string) => void;
  onDone?: () => void;
}

async function runPrompt(opts: RunOptions): Promise<void> {
  const stats = newStats();
  const toolCtx: ToolContext = {
    cwd: process.cwd(),
    yolo: false,
    filesTouched: new Set<string>(),
    sessionId: "",
    sessionApprovals: new Set<string>(),
  };

  const mcpDispatch = (name: string, args: Record<string, unknown>) =>
    callMCPTool(opts.connections, name, args, {
      sessionApprovals: toolCtx.sessionApprovals,
    });

  await runAgent({
    model: opts.model,
    stats,
    toolCtx,
    messages: opts.messages,
    signal: opts.signal,
    maxAutoContinue: opts.maxAutoContinue ?? 1,
    extraTools: opts.extraTools,
    dispatchExtraTool: mcpDispatch,
    events: {
      onAssistantStart: () => {},
      onAssistantContent: (_turnId, chunk) => opts.onToken?.(chunk),
      onAssistantReasoning: (_turnId, chunk) => opts.onThinking?.(chunk),
      onAssistantFinal: () => opts.onDone?.(),
      onToolStart: (_callId, name, argsRaw) => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(argsRaw); } catch { /* keep empty */ }
        opts.onTool?.(name, args);
      },
      onToolEnd: (_callId, name, content, rejected) => {
        opts.onToolResult?.(name, content, rejected);
      },
      onNotice: (text) => opts.onNotice?.(text),
    },
  });
}

// ── Session management ──────────────────────────────────────────────

async function persistSession(session: {
  id: string;
  model: Model;
  messages: Message[];
  compaction?: CompactionState;
}): Promise<void> {
  try {
    await saveSession({
      id: session.id,
      cwd: process.cwd(),
      model: session.model,
      messages: session.messages,
      stats: newStats(),
      created_at: Date.now(),
      compaction: session.compaction,
    });
  } catch (e) {
    console.error("session save error:", (e as Error).message);
  }
}

// ── Entry ───────────────────────────────────────────────────────────

export async function serve(port = PORT): Promise<void> {
  let model: Model = DEFAULT_MODEL;

  // Memory graph (if enabled in config)
  let memoryEnabled = false;
  try {
    const cfg = getConfig();
    const memCfg = (cfg as any).memory;
    if (memCfg && typeof memCfg === "object" && memCfg.enabled) {
      memoryEnabled = true;
      memory.setEnabled(true);
      memory.setModel(model);
      memory.setApiCall(async (m, msgs, _maxTokens) => {
        // Serve mode: use a lightweight API call (non-streaming)
        // We can't import chat() in a scope that causes circular deps,
        // so we delegate to a simplified call.
        const { chat: apiChat } = await import("./api.js");
        const res = await apiChat({
          model: m,
          messages: msgs as any,
        });
        return res.choices?.[0]?.message?.content ?? "";
      });
    }
  } catch { /* no config — memory stays off */ }

  // Connect MCP servers
  let extraTools: ToolSchema[] = [];
  let connections: Awaited<ReturnType<typeof connectAll>>["connections"] = [];
  connectAll().then((result) => {
    connections = result.connections;
    extraTools = connections.flatMap((c) => c.tools);
    if (result.errors.length) {
      for (const e of result.errors) {
        console.error(`mcp server '${e.name}' failed: ${e.error}`);
      }
    }
    if (connections.length) {
      console.error(`mcp: ${connections.length} server(s) connected`);
    }
  }).catch((e) => {
    console.error("mcp connection error:", e.message);
  });

  // ── HTTP server ────────────────────────────────────────────────────

  const server = createServer(async (req, res) => {
    const parsed = url.parse(req.url ?? "", true);
    const pathname = parsed.pathname ?? "/";

    // Auth check (skip for health)
    if (pathname !== "/health" && !checkAuth(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    // CORS for browser clients
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── GET /health ────────────────────────────────────────────
      if (req.method === "GET" && pathname === "/health") {
        json(res, 200, { ok: true, pid: process.pid });
        return;
      }

      // ── POST /chat ─────────────────────────────────────────────
      if (req.method === "POST" && pathname === "/chat") {
        const body = await readBody(req);
        let payload: { prompt?: string; session_id?: string } = {};
        try { payload = JSON.parse(body); } catch {
          json(res, 400, { error: "invalid JSON" });
          return;
        }

        if (!payload.prompt || typeof payload.prompt !== "string") {
          json(res, 400, { error: "missing 'prompt' field" });
          return;
        }

        const prompt = payload.prompt.trim();
        if (!prompt) {
          json(res, 400, { error: "'prompt' must be non-empty" });
          return;
        }

        // Load or create session
        let sessionId = payload.session_id || "";
        let messages: Message[] = [];
        let compaction: CompactionState | undefined;

        if (sessionId) {
          const loaded = await loadSession(sessionId);
          if (loaded) {
            messages = loaded.messages;
            compaction = loaded.compaction;
            model = loaded.model;
          }
        } else {
          sessionId = newSession(process.cwd(), model).id;
        }

        // Inject memory context before the user message
        if (memoryEnabled) {
          const ctx = memory.autoQueryContext(prompt);
          if (ctx) {
            messages.push({ role: "user", content: ctx });
          }
        }

        messages.push({ role: "user", content: prompt });

        // SSE
        const stream = sse(res);
        let content = "";
        let reasoning = "";

        try {
          await runPrompt({
            model,
            messages,
            extraTools,
            connections,
            signal: undefined,
            maxAutoContinue: 1,
            onToken(chunk) {
              content += chunk;
              stream.emit("token", chunk);
            },
            onThinking(chunk) {
              reasoning += chunk;
              stream.emit("thinking", chunk);
            },
            onTool(name, args) {
              stream.emit("tool", JSON.stringify({ name, args }));
            },
            onToolResult(name, result, rejected) {
              stream.emit("tool_result", JSON.stringify({
                name, content: result, rejected,
              }));
            },
            onNotice(text) {
              stream.emit("notice", text);
            },
            onDone() {
              // Will be handled after auto-compact
            },
          });
        } catch (e) {
          stream.emit("error", (e as Error).message);
        }

        // Auto-compact if context is large
        if (AUTO_COMPACT_AT > 0) {
          const estimated = estimateContextTokens(messages);
          if (estimated > AUTO_COMPACT_AT) {
            try {
              const result = await compactSession(
                { id: sessionId, cwd: process.cwd(), model, messages, stats: newStats(), created_at: Date.now() },
                AUTO_COMPACT_KEEP,
              );
              if (result) {
                messages = result.remainingMessages;
                compaction = {
                  summary: result.summary,
                  compacted_at: Date.now(),
                  turns_removed: result.turnsRemoved,
                };
                stream.emit("notice", `compacted: ${result.turnsRemoved} turns summarized`);
              }
            } catch { /* compaction is best-effort */ }
          }
        }

        // Persist session
        await persistSession({
          id: sessionId,
          model,
          messages,
          compaction,
        });

        // Store in memory graph
        if (memoryEnabled) {
          memory.storePropositions(prompt, content).catch(() => {});
        }

        stream.emit("done", JSON.stringify({ session_id: sessionId }));
        stream.done();
        return;
      }

      // ── GET /session/:id ────────────────────────────────────────
      const sessionMatch = pathname.match(/^\/session\/(.+)$/);
      if (req.method === "GET" && sessionMatch) {
        const sid = sessionMatch[1];
        const loaded = await loadSession(sid);
        if (!loaded) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, {
          id: loaded.id,
          cwd: loaded.cwd,
          model: loaded.model,
          message_count: loaded.messages.length,
          created_at: loaded.created_at,
          compaction: loaded.compaction || null,
        });
        return;
      }

      // 404
      json(res, 404, { error: "not found" });
    } catch (e) {
      console.error("request error:", (e as Error).message);
      if (!res.headersSent) {
        json(res, 500, { error: "internal error" });
      }
    }
  });

  // ── WebSocket on top of HTTP server ─────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    // Auth for WebSocket
    if (!checkAuth(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  server.listen(port, "127.0.0.1", () => {
    const token = resolveAuthToken();
    const authNote = token ? " (auth enabled)" : "";
    console.error(`dsc serve — http://127.0.0.1:${port}  ws://127.0.0.1:${port}  (pid ${process.pid})${authNote}`);
  });

  // Suppress server-level errors
  server.on("error", (err: Error) => {
    console.error("server error:", err.message);
  });

  // ── WebSocket connection handling ───────────────────────────────────

  wss.on("connection", (ws: WebSocket) => {
    console.error("ws client connected");
    let messages: Message[] = [];
    let sessionCompact: CompactionState | undefined;

    ws.on("error", (err: Error) => {
      console.error("ws client error:", err.message);
    });

    send(ws, {
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      version: "1.0.0",
    });

    ws.on("message", async (raw: RawData) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(ws, { type: "notice", text: "invalid JSON" });
        return;
      }

      switch (parsed.type) {
        case "prompt": {
          // Memory auto-query
          if (memoryEnabled) {
            const ctx = memory.autoQueryContext(parsed.text);
            if (ctx) messages.push({ role: "user", content: ctx });
          }
          messages.push({ role: "user", content: parsed.text });

          await runPrompt({
            model,
            messages,
            extraTools,
            connections,
            maxAutoContinue: 1,
            onToken(chunk) { send(ws, { type: "token", text: chunk }); },
            onThinking(chunk) { send(ws, { type: "thinking", text: chunk }); },
            onTool(name, args) { send(ws, { type: "tool", name, args }); },
            onToolResult(name, content, rejected) {
              send(ws, { type: "tool_result", name, content, rejected });
            },
            onNotice(text) { send(ws, { type: "notice", text }); },
            onDone() { send(ws, { type: "turn_end" }); },
          });

          // Auto-compact
          if (AUTO_COMPACT_AT > 0) {
            const estimated = estimateContextTokens(messages);
            if (estimated > AUTO_COMPACT_AT) {
              try {
                const result = await compactSession({ id: "", cwd: process.cwd(), model, messages, stats: newStats(), created_at: Date.now() }, AUTO_COMPACT_KEEP);
                if (result) {
                  messages = result.remainingMessages;
                  sessionCompact = {
                    summary: result.summary,
                    compacted_at: Date.now(),
                    turns_removed: result.turnsRemoved,
                  };
                  send(ws, {
                    type: "notice",
                    text: `compacted: ${result.turnsRemoved} turns summarized`,
                  });
                }
              } catch { /* best-effort */ }
            }
          }

          // Memory store
          if (memoryEnabled) {
            const lastAssistant = [...messages]
              .reverse()
              .find((m) => m.role === "assistant");
            if (lastAssistant?.content) {
              memory
                .storePropositions(parsed.text, lastAssistant.content)
                .catch(() => {});
            }
          }

          send(ws, { type: "notice", text: formatCost(newStats(), model) });
          break;
        }

        case "approval_response": {
          const pending = pendingApprovals.get(parsed.id);
          if (pending) {
            pending.resolve(parsed.answer);
            pendingApprovals.delete(parsed.id);
          }
          break;
        }

        case "slash": {
          const emit = (text: string) => send(ws, { type: "notice", text });
          const ctx = serveSlashContext(
            emit,
            () => model,
            () => messages,
            () => "",
            () => { messages = []; sessionCompact = undefined; },
            async () => {
              if (AUTO_COMPACT_AT > 0) {
                const result = await compactSession({ id: "", cwd: process.cwd(), model, messages, stats: newStats(), created_at: Date.now() }, AUTO_COMPACT_KEEP);
                if (result) {
                  messages = result.remainingMessages;
                  sessionCompact = {
                    summary: result.summary,
                    compacted_at: Date.now(),
                    turns_removed: result.turnsRemoved,
                  };
                }
              }
            },
          );

          try {
            dispatchSlash(`/${parsed.command}${parsed.arg ? " " + parsed.arg : ""}`, ctx);
          } catch (e) {
            emit(`error: ${(e as Error).message}`);
          }
          break;
        }

        default:
          send(ws, { type: "notice", text: `unknown message type: ${(parsed as any).type}` });
      }
    });

    ws.on("close", () => {
      console.error("ws client disconnected");
      // Save session on disconnect
      if (messages.length > 0) {
        persistSession({
          id: newSession(process.cwd(), model).id,
          model,
          messages,
          compaction: sessionCompact,
        }).catch(() => {});
      }
    });
  });

  // ── Graceful shutdown ────────────────────────────────────────────────

  const shutdown = async () => {
    console.error("\nshutting down");
    wss.close();
    server.close();
    await closeAll(connections);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── CLI entry ───────────────────────────────────────────────────────
const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) || PORT : PORT;
serve(port);
