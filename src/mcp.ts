/**
 * Generic MCP (Model Context Protocol) client integration.
 *
 * Lets the user point dsc at one or more remote MCP servers (Tavily,
 * filesystem, GitHub, custom, ...) via a `mcp.servers` block in
 * config.json. At boot we connect each enabled server, ask for its
 * tool list, and expose those tools to the agent as additional callable
 * tools alongside the built-ins (read_file, bash, etc).
 *
 * Both HTTP (Streamable HTTP) and stdio transports are supported.
 * Stdio servers have their stderr piped to ~/.local/state/dsc/mcp-<name>.log
 * so noisy logging libraries don't corrupt ink's pinned frame.
 *
 * Naming: server-provided tool `foo` reachable through server name
 * `tavily` is advertised to the model as `mcp_tavily_foo`. The `mcp_`
 * prefix makes routing decisions trivial — when the agent calls a tool
 * starting with `mcp_`, dispatch goes through the MCP client instead of
 * the built-in `executeTool` switch. The server prefix prevents
 * collisions when two servers expose tools with the same name.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { confirm } from "./approval.js";
import { getConfig } from "./api.js";
import type { ToolSchema } from "./api.js";

function mcpLogPath(serverName: string): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length ? xdg : path.join(homedir(), ".local", "state");
  return path.join(base, "dsc", `mcp-${serverName}.log`);
}

type AnyTransport = StreamableHTTPClientTransport | StdioClientTransport;

/**
 * Whole words that, appearing in a tool name or description, suggest
 * the call mutates state somewhere. The "auto" approval policy gates
 * anything matching and lets clearly-read-only tools (search / list /
 * get / read / ...) pass.
 *
 * We can't use \b word boundaries with a regex because JS treats `_`
 * as a word character — so \bwrite\b would never match inside
 * `write_file`, the most common tool-name shape. Instead we tokenize
 * the input on any non-letter sequence and check each token against
 * this set.
 *
 * Kept deliberately broad — false positives just ask the user, which
 * is the safer failure mode. A missed destructive verb (false negative)
 * is the costly one.
 */
const DESTRUCTIVE_WORDS = new Set([
  // Base + common -s / -ed (irregular) forms so verb-shaped descriptions
  // like "sends a message" or "deletes the row" trip the heuristic. We
  // skip -ing forms — they're rare in tool names and descriptions, and
  // including them all would balloon the list without much value.
  "write", "writes",
  "create", "creates", "created",
  "delete", "deletes", "deleted",
  "remove", "removes", "removed",
  "update", "updates", "updated",
  "set", "sets",
  "send", "sends", "sent",
  "post", "posts",
  "publish", "publishes", "published",
  "run", "runs",
  "exec", "execute", "executes",
  "kill", "kills",
  "move", "moves",
  "rename", "renames",
  "insert", "inserts",
  "drop", "drops",
  "push", "pushes",
  "put", "puts",
  "patch", "patches",
  "edit", "edits",
  "modify", "modifies",
  "append", "appends",
  "truncate", "truncates",
  "destroy", "destroys",
  "spawn", "spawns",
  "invoke", "invokes",
]);

export function autoRequiresApproval(
  toolName: string,
  description: string | undefined,
): boolean {
  const haystack = description ? `${toolName} ${description}` : toolName;
  for (const token of haystack.toLowerCase().split(/[^a-z]+/)) {
    if (token && DESTRUCTIVE_WORDS.has(token)) return true;
  }
  return false;
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface MCPServerConfig {
  /** Transport. Defaults: "http" when `url` is set, "stdio" when
   *  `command` is set. Set explicitly to disambiguate. */
  transport?: "http" | "stdio";

  // ── HTTP transport ─────────────────────────────────────────────────
  /** Server URL. Required for http transport. */
  url?: string;
  /** Optional request headers (e.g. `Authorization`). `${VAR}` is expanded
   *  against process.env at connect time; missing vars throw. */
  headers?: Record<string, string>;
  /** Optional query-string params appended to `url`. Same `${VAR}`
   *  expansion as headers. Use when a server takes its key via URL. */
  query?: Record<string, string>;

  // ── stdio transport ────────────────────────────────────────────────
  /** Executable for stdio transport (e.g. "npx", "/path/to/server"). */
  command?: string;
  /** Args appended to `command`. `${VAR}` expanded. */
  args?: string[];
  /** Extra env vars for the child. `${VAR}` expanded. Merged on top of
   *  the parent process env so the child still sees PATH etc. */
  env?: Record<string, string>;

  // ── Common ─────────────────────────────────────────────────────────
  /** Skip this server when false. Default true. */
  enabled?: boolean;
  /** Optional connect timeout in ms. Default 8 s. */
  timeoutMs?: number;
  /** Per-server approval policy for tool calls:
   *
   *    "always" — every call gets the yellow approval dialog
   *    "never"  — calls pass through without prompting (use --yolo
   *               level trust; for stable read-only servers only)
   *    "auto"   — heuristic: tools whose name or description suggests
   *               state mutation (write/create/delete/send/run/...)
   *               get prompted; clearly read-only tools (search/get/
   *               read/list) pass through
   *
   *  Defaults: "always" for stdio (local subprocesses usually have
   *  filesystem access — treat as destructive by default), "auto" for
   *  http (remote servers are scope-limited to whatever API they
   *  proxy).
   */
  requireApproval?: "always" | "never" | "auto";
}

export interface MCPConnection {
  /** User-defined server name from the config key (e.g. "tavily"). */
  name: string;
  /** The connected client. Use to invoke tools. */
  client: Client;
  /** The transport. HTTP gets `terminateSession`; stdio doesn't (closing
   *  the client kills the child). Code that closes them out should
   *  optional-chain on terminateSession. */
  transport: AnyTransport;
  /** Tools advertised by this server, translated to OpenAI shape with
   *  namespaced names (`mcp_<server>_<tool>`). Drop into `chatStream`'s
   *  `tools` array alongside the built-ins. */
  tools: ToolSchema[];
  /** Lookup the original server tool name from a namespaced name. */
  toolMap: Map<string, string>;
  /** Resources advertised by this server (URIs). Exposed via mcp_<server>_resource_read. */
  resourceUris?: string[];
  /** The raw server config we connected with — kept so callMCPTool can
   *  read requireApproval without a second lookup. */
  config: MCPServerConfig;
}

interface MCPRootConfig {
  servers?: Record<string, MCPServerConfig>;
}

/**
 * Walk `${VAR}` references in a string against process.env. Throws when
 * a referenced var is unset — fail-fast beats a silent auth bypass.
 */
export function expandEnv(input: string, where: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name) => {
    const v = process.env[name];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `${where}: environment variable \${${name}} is unset; required for MCP server config`,
      );
    }
    return v;
  });
}

/** Read mcp.servers from config.json (via the same cache api.ts uses). */
export function loadMCPConfig(): Record<string, MCPServerConfig> {
  const cfg = getConfig();
  if (!cfg) return {};
  const mcp = cfg.mcp;
  if (!mcp || typeof mcp !== "object") return {};
  const servers = (mcp as MCPRootConfig).servers;
  if (!servers || typeof servers !== "object") return {};
  return servers;
}

/**
 * Connect to a single MCP server and discover its tools. Resolves with
 * the connection on success, throws on any failure (caller catches and
 * surfaces — we don't want one broken server to take dsc down).
 */
async function connectOne(
  name: string,
  config: MCPServerConfig,
): Promise<MCPConnection> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `mcp server name "${name}" must match ${NAME_PATTERN} (alphanumeric, '_', '-')`,
    );
  }

  // Disambiguate transport: explicit `transport` field wins; otherwise
  // infer from which field is set. Explicit `stdio` plus `url` is an
  // error, etc.
  const transportKind: "http" | "stdio" =
    config.transport ?? (config.command ? "stdio" : "http");

  let transport: AnyTransport;
  if (transportKind === "http") {
    if (!config.url) {
      throw new Error(`mcp.${name}: url is required for http transport`);
    }
    const url = new URL(expandEnv(config.url, `mcp.${name}.url`));
    if (config.query) {
      for (const [k, v] of Object.entries(config.query)) {
        url.searchParams.set(k, expandEnv(v, `mcp.${name}.query.${k}`));
      }
    }
    // Expand headers up-front; the transport accepts a static headers
    // map (any provider needing dynamic re-auth should switch to an
    // AuthProvider, which the SDK supports — out of scope here).
    const headers: Record<string, string> = {};
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        headers[k] = expandEnv(v, `mcp.${name}.headers.${k}`);
      }
    }
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
  } else {
    // stdio transport — spawn a local subprocess.
    if (!config.command) {
      throw new Error(`mcp.${name}: command is required for stdio transport`);
    }
    const command = expandEnv(config.command, `mcp.${name}.command`);
    const args = (config.args ?? []).map((a, i) =>
      expandEnv(a, `mcp.${name}.args[${i}]`),
    );
    // Inherit parent env first so the child sees PATH etc. Explicit
    // entries override; `${VAR}` expansion lets users forward specific
    // env vars without restating them. Filter undefined values for
    // type-safety against process.env's loose shape.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        env[k] = expandEnv(v, `mcp.${name}.env.${k}`);
      }
    }
    // `stderr: "pipe"` is critical: the SDK's default is "inherit", which
    // forwards child stderr to dsc's terminal. That breaks ink — any byte
    // hitting the terminal outside ink's render path scrolls the dynamic
    // frame, and the next ink repaint draws a fresh frame *below* the
    // displaced one, so the user sees stacked status bars. Routing the
    // child's stderr through a Readable lets us pipe it to a log file
    // instead, debug-friendly without polluting the TUI.
    transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: "pipe",
    });

    const logPath = mcpLogPath(name);
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      const logStream = createWriteStream(logPath, { flags: "a" });
      logStream.write(
        `\n--- ${new Date().toISOString()} dsc connected mcp.${name} (${command}) ---\n`,
      );
      // The SDK's transport.stderr getter returns a PassThrough that
      // exposes the child's stderr stream after start(). Pipe it through
      // to the file; the SDK starts the child during client.connect()
      // below, so the pipe lands before any byte is emitted.
      transport.stderr?.pipe(logStream);
    } catch {
      // Best-effort: if the log file can't be opened (perms, disk full),
      // we still want the server to come up. Worst case stderr is lost.
    }
  }

  const client = new Client({ name: "dsc", version: "0.5.3" });

  // Connect with a bounded timeout so a hung server doesn't stall dsc
  // boot indefinitely.
  const timeoutMs = config.timeoutMs ?? 8000;
  await withTimeout(
    client.connect(transport),
    timeoutMs,
    `mcp.${name}: connect timed out after ${timeoutMs}ms`,
  );

  // Ask the server what tools it offers, translate to OpenAI shape.
  const listed = await withTimeout(
    client.listTools(),
    timeoutMs,
    `mcp.${name}: listTools timed out`,
  );

  const tools: ToolSchema[] = [];
  const toolMap = new Map<string, string>();
  for (const t of listed.tools ?? []) {
    if (!t.name || !NAME_PATTERN.test(t.name)) {
      // Skip tools whose names won't survive the OpenAI tool-name regex;
      // we can't safely call them from chatStream regardless.
      continue;
    }
    const namespaced = `mcp_${name}_${t.name}`;
    tools.push({
      type: "function",
      function: {
        name: namespaced,
        description: t.description ?? `tool from MCP server ${name}`,
        // MCP gives us a JSON Schema; OpenAI/DeepSeek's `parameters`
        // accepts JSON Schema directly. Default to empty-object when
        // the server omits inputSchema.
        parameters: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      },
    });
    toolMap.set(namespaced, t.name);
  }

  // Discover MCP resources and expose them as a pseudo-tool.
  let resourceUris: string[] | undefined;
  try {
    const resources = await withTimeout(
      client.listResources(),
      Math.min(timeoutMs, 4000),
      `mcp.${name}: listResources timed out`,
    );
    if (resources.resources && resources.resources.length > 0) {
      resourceUris = resources.resources.map((r: any) => r.uri);
      const resourceToolName = `mcp_${name}_resource_read`;
      tools.push({
        type: "function",
        function: {
          name: resourceToolName,
          description: `Read a resource from the MCP server '${name}'. Known URIs: ${resourceUris.slice(0, 20).join(", ")}${resourceUris.length > 20 ? ` ... (+${resourceUris.length - 20} more)` : ""}. Call with {"uri": "<uri>"}.`,
          parameters: {
            type: "object",
            properties: {
              uri: { type: "string", description: "The resource URI to read." },
            },
            required: ["uri"],
          },
        },
      });
      toolMap.set(resourceToolName, resourceToolName);
    }
  } catch {
    // Resource listing is optional — many servers don't support it.
  }

  return { name, client, transport, tools, toolMap, resourceUris, config };
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Connect every enabled MCP server. Failures are isolated per server —
 * one broken config doesn't kill the others. Returns the list of
 * successful connections plus an array of `{ name, error }` for what
 * failed, so the caller can surface them to the user.
 */
export async function connectAll(): Promise<{
  connections: MCPConnection[];
  errors: Array<{ name: string; error: string }>;
}> {
  const servers = loadMCPConfig();
  const connections: MCPConnection[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
    try {
      const c = await connectOne(name, cfg);
      connections.push(c);
    } catch (e) {
      errors.push({ name, error: (e as Error).message });
    }
  }
  return { connections, errors };
}

/**
 * Invoke a namespaced tool (`mcp_<server>_<tool>`) by name. Returns a
 * ToolResult compatible with the rest of the agent's tool path.
 *
 * Approval gating: each server has a `requireApproval` policy
 * ("always" | "never" | "auto"). "auto" uses the DESTRUCTIVE_VERBS_RE
 * heuristic on the tool name + description. When approval is required
 * we route through approval.confirm() before calling. "always"
 * answers add the namespaced tool name to `sessionApprovals` so
 * subsequent identical tool calls in this session skip the dialog.
 */
export async function callMCPTool(
  connections: MCPConnection[],
  name: string,
  args: Record<string, unknown>,
  opts?: { sessionApprovals?: Set<string> },
): Promise<{ content: string; rejected?: boolean }> {
  // The first underscore-segmented `_<server>_` identifies which
  // connection to dispatch to. We split on the *second* underscore so
  // tool names containing dashes (e.g. tavily-search) work.
  const m = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (!m) {
    return { content: `error: malformed mcp tool name '${name}'` };
  }
  const [, serverName, toolName] = m;
  const conn = connections.find((c) => c.name === serverName);
  if (!conn) {
    return { content: `error: mcp server '${serverName}' not connected` };
  }
  // Confirm the tool is one the server actually advertised (in case the
  // schema got out of sync between connect and invoke).
  const original = conn.toolMap.get(name);
  if (!original || original !== toolName) {
    return { content: `error: tool '${toolName}' not available on '${serverName}'` };
  }

  // ── Approval gate ────────────────────────────────────────────────
  // Default policy: stdio servers always ask (local subprocesses
  // typically have filesystem access). HTTP servers default to "auto"
  // since they're scope-limited to whatever API they wrap.
  const defaultPolicy: "always" | "auto" =
    (conn.config.transport ?? (conn.config.command ? "stdio" : "http")) === "stdio"
      ? "always"
      : "auto";
  const policy = conn.config.requireApproval ?? defaultPolicy;

  let mustAsk = false;
  if (policy === "always") {
    mustAsk = true;
  } else if (policy === "auto") {
    const desc = conn.tools.find((t) => t.function.name === name)?.function
      .description;
    mustAsk = autoRequiresApproval(toolName, desc);
  }

  const alreadyApproved = opts?.sessionApprovals?.has(name) ?? false;
  if (mustAsk && !alreadyApproved) {
    // Pretty-print the args so the user sees what's about to happen.
    // Cap so a huge argument blob doesn't drown the dialog.
    let argsPreview = JSON.stringify(args, null, 2);
    if (argsPreview.length > 1200) {
      argsPreview = argsPreview.slice(0, 1200) + "\n…(truncated)";
    }
    const ans = await confirm({
      title: `Run MCP tool ${name}`,
      body: argsPreview,
      kind: "command",
    });
    if (ans === "no") {
      return { content: "rejected by user", rejected: true };
    }
    if (ans === "always") {
      opts?.sessionApprovals?.add(name);
    }
  }

  try {
    // ── Resource read (mcp_<server>_resource_read) ──────────────────
    if (toolName === "resource_read") {
      const uri = typeof args.uri === "string" ? args.uri : "";
      if (!uri) return { content: "error: missing 'uri' for resource read" };
      const r = await conn.client.readResource({ uri });
      const contents = Array.isArray((r as any).contents)
        ? (r as any).contents
        : [r];
      const parts: string[] = [];
      for (const item of contents) {
        if (item.text && typeof item.text === "string") {
          parts.push(item.text);
        } else if (item.blob) {
          parts.push(`(binary resource: ${item.mimeType ?? "unknown type"}, ${typeof item.blob === "string" ? item.blob.length + " bytes" : "blob"})`);
        } else {
          parts.push(`(resource: ${item.uri ?? "?"})`);
        }
      }
      return { content: parts.join("\n") || "(empty resource)" };
    }

    const toolTimeout = (conn.config.timeoutMs ?? 60000) * 3;
    const r = await conn.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: toolTimeout },
    );
    // MCP returns content as an array of typed items (text, image, etc).
    // Concatenate text parts; flag any non-text content so the agent
    // knows something was elided.
    const parts: string[] = [];
    for (const item of (r.content as Array<Record<string, unknown>>) ?? []) {
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text);
      } else {
        parts.push(`(non-text mcp content: ${String(item.type)})`);
      }
    }
    return { content: parts.join("\n") || "(empty result)" };
  } catch (e) {
    return { content: `error: ${(e as Error).message}` };
  }
}

/** Terminate sessions and close clients. Best-effort.
 *  HTTP transports get terminateSession (server-side cleanup); stdio
 *  transports don't have one (closing the client kills the child). */
export async function closeAll(connections: MCPConnection[]): Promise<void> {
  for (const c of connections) {
    try {
      if (
        "terminateSession" in c.transport &&
        typeof c.transport.terminateSession === "function"
      ) {
        await c.transport.terminateSession();
      }
    } catch {
      // best-effort
    }
    try {
      await c.client.close();
    } catch {
      // best-effort
    }
  }
}
