/**
 * `dsc serve` — WebSocket daemon for headless dsc.
 *
 * Exposes the agent loop (tools, MCP, DeepSeek chat) over a WebSocket
 * for a programmatic client (surface, script, webhook).
 *
 * Usage:  dsc serve [--port <n>]
 *
 * Protocol: see serve_protocol.ts.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";

import { runAgent, formatCost } from "./agent.js";
import type { Message, ToolSchema, Model } from "./api.js";
import { newStats, DEFAULT_MODEL } from "./api.js";
import { connectAll, closeAll, callMCPTool } from "./mcp.js";
import type { ToolContext } from "./tools.js";
import { PROTOCOL_VERSION, type ServerMessage, type ClientMessage } from "./serve_protocol.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = Number(process.env.DSC_SERVE_PORT) || 9090;

// ── State ───────────────────────────────────────────────────────────

const pendingApprovals = new Map<
  number,
  { resolve: (ans: string) => void }
>();

let approvalIdCounter = 0;

// ── Event → protocol broadcast ──────────────────────────────────────

function send(ws: WebSocket, msg: ServerMessage): void {
  const text = JSON.stringify(msg);
  ws.send(text, (err: Error | undefined) => {
    if (err && ws.readyState === WebSocket.OPEN) {
      // Best-effort for now.
    }
  });
}

// ── Entry ───────────────────────────────────────────────────────────

export async function serve(port = PORT): Promise<void> {
  const model: Model = DEFAULT_MODEL;
  const stats = newStats();

  // Start the WebSocket server immediately — don't block on MCP connections.
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  console.error(`dsc serve — ws://127.0.0.1:${port}  (pid ${process.pid})`);

  // Suppress server-level errors from unclean client disconnects
  wss.on("error", (err: Error) => {
    console.error("server error:", err.message);
  });

  // Connect MCP servers in the background. Clients that connect before MCP is
  // ready will see prompts run without MCP tools; MCP tools become available
  // as connections finish.
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

  wss.on("connection", (ws: WebSocket) => {
    console.error("client connected");
    let messages: Message[] = [];

    // Suppress WebSocket errors so an unclean client disconnect doesn't crash the daemon
    ws.on("error", (err: Error) => {
      console.error("client error:", err.message);
    });

    // Hello
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
        // ── Prompt ──────────────────────────────────────────────
        case "prompt": {
          messages.push({ role: "user", content: parsed.text });

          const toolCtx: ToolContext = {
            cwd: process.cwd(),
            yolo: false,
            filesTouched: new Set<string>(),
            sessionId: "",
            sessionApprovals: new Set<string>(),
          };

          const mcpDispatch = (name: string, args: Record<string, unknown>) =>
            callMCPTool(connections, name, args, {
              sessionApprovals: toolCtx.sessionApprovals,
            });

          await runAgent({
            model,
            stats,
            toolCtx,
            messages,
            signal: undefined,
            maxAutoContinue: 1,
            extraTools,
            dispatchExtraTool: mcpDispatch,
            events: {
              onAssistantStart: (_turnId: string) => {},
              onAssistantContent: (_turnId: string, chunk: string) => {
                send(ws, { type: "token", text: chunk });
              },
              onAssistantReasoning: (_turnId: string, chunk: string) => {
                send(ws, { type: "thinking", text: chunk });
              },
              onAssistantFinal: (_turnId: string, _msg: unknown) => {
                send(ws, { type: "turn_end" });
              },
              onToolStart: (_callId: string, name: string, argsRaw: string) => {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(argsRaw);
                } catch { /* fall through */ }
                send(ws, { type: "tool", name, args });
              },
              onToolEnd: (_callId: string, name: string, content: string, rejected: boolean) => {
                send(ws, {
                  type: "tool_result",
                  name,
                  content,
                  rejected,
                });
              },
              onNotice: (text: string) => {
                send(ws, { type: "notice", text });
              },
            },
          });

          send(ws, { type: "notice", text: formatCost(stats, model) });
          break;
        }

        // ── Approval response ───────────────────────────────────
        case "approval_response": {
          const pending = pendingApprovals.get(parsed.id);
          if (pending) {
            pending.resolve(parsed.answer);
            pendingApprovals.delete(parsed.id);
          }
          break;
        }

        case "slash": {
          const cmd = parsed.command;
          if (cmd === "clear") {
            messages = [];
            send(ws, { type: "notice", text: "session cleared" });
          } else {
            send(ws, { type: "notice", text: `unknown slash: /${cmd}` });
          }
          break;
        }

        default:
          send(ws, { type: "notice", text: `unknown message type` });
      }
    });

    ws.on("close", () => {
      console.error("client disconnected");
      // Keep MCP connections alive for the next client
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("\nshutting down");
    wss.close();
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
