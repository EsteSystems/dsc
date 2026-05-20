# Headless dsc — `dsc serve` development plan

Companion to the broader vision in
[`~/code/conversational-computing/docs/headless-surface-plan.md`](../../conversational-computing/docs/headless-surface-plan.md).
That document describes the full surface architecture (daemon ↔ pygame
emergence field ↔ MCP server fleet). This document is dsc-side only:
what changes inside dsc to expose its agent loop as a long-lived
WebSocket service.

## Context: what's already in place

The agent loop is already daemon-shaped. `runAgent({ events: AgentEvents })`
accepts a callback set that emits the exact protocol shape the headless
surface needs:

| `AgentEvents` callback (today) | Headless protocol message |
|---|---|
| `onAssistantContent(turnId, chunk)` | `{type: "token", text: chunk}` |
| `onAssistantReasoning(turnId, chunk)` | `{type: "thinking", text: chunk}` |
| `onAssistantFinal(turnId, msg)` | `{type: "turn_end", ...}` |
| `onToolStart(callId, name, args)` | `{type: "tool", name, args}` |
| `onToolEnd(callId, name, content, rejected)` | `{type: "tool_result", name, content}` |
| `onNotice(text)` | `{type: "notice", text}` |

The daemon is essentially: install a WebSocket server, on prompt build
an `AgentEvents` set whose callbacks JSON-encode and broadcast. The
agent loop, MCP connections, tools, sessions, instructions overlay,
approval flow — all of it carries over.

## What's genuinely new

Three things in the headless plan don't have analogs in dsc today:

1. **Approval over the wire.** dsc's approval today is in-process —
   `approval.setAsker(req => Promise<answer>)`. The daemon needs to
   send `{type: "approval_request", id, title, body, kind}` to the
   client and await a matching `{type: "approval_response", id, answer}`.
   Protocol design + correlating IDs to pending Promises.

2. **Server-initiated events** (calendar reminders, mail arrivals,
   tension detections). The agent-events callbacks are all turn-driven.
   Push-from-nowhere is a new path. Needs a `publishEvent(msg)`
   broadcaster the daemon exposes, plus *someone calling it* — either
   MCP server notifications (the SDK supports these via
   `notifications/message`, but the server has to implement) or
   daemon-internal timers polling MCP.

3. **Session lifecycle**. Today: one session per dsc process. Daemon:
   one or many? Open question below.

## Design decisions (taken)

- **Name the entry `dsc serve`, not `dsc daemon`.** "Daemon" implies
  forking-into-background, PID files, the whole sysvinit dance. `serve`
  is what we actually mean: foreground process holding a WebSocket.
  Users wrap it in tmux/systemd/launchd themselves. Same word HTTP
  servers use.
- **WebSocket only**, not Unix socket. Same security model for
  localhost, debuggable with `wscat`/`websocat`, easier to test.
  Unix socket later if someone asks for it specifically.
- **`ws` as an `optionalDependencies`.** Node 22's global `WebSocket`
  is client-only; server still needs `ws` (~50 KB). Adding it as
  `optionalDependencies` + `await import("ws")` only when `dsc serve`
  runs means the 95% of users who never run the daemon don't pay the
  install cost.
- **TUI stays as it is.** The daemon serves programmatic clients (the
  surface, scripts, webhooks). The TUI doesn't become a daemon client —
  that's a regression in latency and complexity. Three modes serving
  different needs:

  | Invocation | Mode |
  |---|---|
  | `dsc` | Interactive TUI |
  | `dsc "prompt"` | One-shot, stdout |
  | `dsc serve` | WebSocket server |

- **Default deny on approvals.** Tempting to auto-yolo for unattended
  use, but the conversational-computing pitch is that the surface
  *shows* the approval as a context object. Daemon stays cautious by
  default; surface elevates the approval; user sees + answers.
  Override: `dsc serve --yolo`.

## Open questions (to be resolved before phase 1)

1. **Single-client or multi-client?** Can two surfaces connect to one
   daemon and see the same conversation? My vote: single client per
   session in v1. If a second connects, either reject with
   `{type: "error", reason: "in use"}` or share-mirror — pick one.

2. **Session model.** One persistent session per daemon, or
   `{type: "new_session"}` / `{type: "resume", id}` protocol messages?
   My vote: one session per daemon for v1. If you want session
   isolation, run multiple daemons on different ports. v2 can add
   multiplexing if the surface needs it.

3. **Slash command dispatch over the wire.** Does the surface support
   `/clear`, `/cost`, `/instructions` etc, or is the slash surface
   TUI-only? My vote: yes — `{type: "slash", command: "clear"}` runs
   through the same handlers; responses come back as
   `{type: "notice"}` events. Almost free since the dispatcher is
   already a pure function once we lift it out of `tui.tsx`.

4. **MCP connections per-daemon or per-session?** If you eventually
   have multiple sessions, do MCP connections multiplex (one socket,
   many sessions) or fork? My vote: per-daemon. MCP servers are
   external — connecting N times for N sessions is wasteful.

5. **Protocol versioning.** The surface and daemon will evolve
   independently. Worth tagging the handshake with a version from day
   one (`{type: "hello", protocol_version: 1}`). Cheap insurance.

6. **Audit log.** Daemon turns should write to the same JSONL at
   `~/.local/state/dsc/audit.log`. Surface need not see this — it's
   for forensics. Confirm we don't bifurcate.

## Implementation phases

### Phase 1 — `dsc serve` baseline

| Step | What | Files |
|---|---|---|
| 1 | Add `serve` argv branch in `bin/dsc.mjs` → routes to `src/serve.tsx` (or `.ts`, no ink) | `bin/dsc.mjs` |
| 2 | Add `ws` to `optionalDependencies`; dynamic-import in serve entry | `package.json`, `src/serve.ts` |
| 3 | WebSocket server bound to `127.0.0.1:9090` (configurable via `--port`) | `src/serve.ts` |
| 4 | Connection accepted; send `{type: "hello", protocol_version: 1, version: "1.x.y"}` | `src/serve.ts`, `src/serve_protocol.ts` |
| 5 | Inbound `{type: "prompt", text}` → runAgent with events bound to JSON broadcast on the connection | `src/serve.ts` |
| 6 | Bind all six `AgentEvents` to outbound message shapes (table above) | `src/serve.ts` |
| 7 | Inbound `{type: "approval_response", id, answer}` resolves pending approvals; install asker that sends `approval_request` and awaits | `src/serve.ts` |
| 8 | MCP connections stay alive across prompts (already true for the in-process model — just don't tear down on connection close) | `src/serve.ts` |
| 9 | Graceful shutdown on SIGINT/SIGTERM: close MCP, close WS, exit 0 | `src/serve.ts` |

**Deliverable**: surface (or `wscat`) connects, sends a prompt, gets streamed tokens + tool results back, can approve a destructive tool.

### Phase 2 — slash commands + server-initiated events

| Step | What |
|---|---|
| 1 | Extract slash-command dispatcher from `tui.tsx` into `src/slash_dispatch.ts` (returns text/lines to caller instead of calling `info()` directly). |
| 2 | Wire `{type: "slash", command, arg}` inbound to the dispatcher; replies as `{type: "notice", text}`. |
| 3 | Add `publishEvent(msg)` API on the WS server. Any code in dsc can call it to broadcast to all connected clients (none broadcast yet, but the API exists). |
| 4 | Wire MCP server-side `notifications/message` (if/when servers emit them) into `publishEvent`. |
| 5 | Optional: timer-based polling for MCP tools that don't push (calendar, mail, etc) — configurable per-server in `mcp.servers.<name>.poll`. |

**Deliverable**: surface can run slashes; daemon can push events without a client prompt.

### Phase 3 — multi-client coordination + protocol hygiene

| Step | What |
|---|---|
| 1 | Decide single-client vs share-mirror (open question 1). Implement. |
| 2 | Protocol version negotiation: client sends `{type: "hello", protocol_version}`; server rejects if incompatible. |
| 3 | Tests: mock WebSocket client + a fake `runAgent` that emits a fixed event sequence; assert protocol message shapes. |
| 4 | Document the protocol in `docs/serve-protocol.md`. |

**Deliverable**: stable v1 protocol; surface can target a tagged version.

## Implementation shape

```
src/
  serve.ts              # WebSocket server + per-connection state
  serve_protocol.ts     # message types, encode/decode, version constants
  slash_dispatch.ts     # extracted slash dispatcher (used by both TUI + serve)
bin/dsc.mjs             # routes "serve" subcommand
docs/
  serve-protocol.md     # written in phase 3
```

## Sequencing relative to multi-provider work

`dsc serve` and the multi-provider abstraction
(see [`multi-provider.md`](./multi-provider.md), if/when written)
touch *different* layers:

- Multi-provider: bottom of `api.ts` — request shape, auth, streaming.
- Serve: top of the loop — how the agent's outputs reach a client.

They can run in parallel without conflict. The conversational-computing
work needs `serve`; the broader user base benefits more from
multi-provider. Pick interleaving based on which signal you want to
chase first.

## Tradeoffs to keep in mind

- **Protocol stability locks us in.** Once a surface ships against
  protocol v1, we can only add fields, not change semantics, without
  a v2 bump. Worth the upfront discipline.
- **Daemon-mode bug surface.** Two paths now go through `AgentEvents`
  (TUI and serve). A future refactor of the event shape costs two
  call-site updates. Keep `AgentEvents` lean.
- **MCP server-push isn't free.** Real-time-feeling calendar reminders
  need either a polling timer (battery hit, latency floor) or MCP
  notifications (server-side work). Phase 2 starts with polling, leaves
  push as a follow-up.
- **Auth deferred.** localhost-only WS in v1. Cross-machine surfaces
  (use case: phone client) need a token-on-connect story. Out of scope.
