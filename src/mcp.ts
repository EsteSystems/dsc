/**
 * Generic MCP (Model Context Protocol) client integration.
 *
 * Lets the user point dsc at one or more remote MCP servers (Tavily,
 * filesystem, GitHub, custom, ...) via a `mcp.servers` block in
 * deepseek.json. At boot we connect each enabled server, ask for its
 * tool list, and expose those tools to the agent as additional callable
 * tools alongside the built-ins (read_file, bash, etc).
 *
 * Phase 1 (this file): HTTP transport only. Stdio transport (for local
 * subprocess servers) is a future addition — it requires child-process
 * lifecycle management we don't need yet.
 *
 * Naming: server-provided tool `foo` reachable through server name
 * `tavily` is advertised to the model as `mcp_tavily_foo`. The `mcp_`
 * prefix makes routing decisions trivial — when the agent calls a tool
 * starting with `mcp_`, dispatch goes through the MCP client instead of
 * the built-in `executeTool` switch. The server prefix prevents
 * collisions when two servers expose tools with the same name.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getConfig } from "./api.js";
import type { ToolSchema } from "./api.js";

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface MCPServerConfig {
  /** Transport. Only "http" supported in phase 1. */
  transport?: "http";
  /** Server URL. Required. */
  url: string;
  /** Optional request headers (e.g. `Authorization`). `${VAR}` is expanded
   *  against process.env at connect time; missing vars throw. */
  headers?: Record<string, string>;
  /** Optional query-string params appended to `url`. Same `${VAR}`
   *  expansion as headers. Use when a server takes its key via URL. */
  query?: Record<string, string>;
  /** Skip this server when false. Default true. */
  enabled?: boolean;
  /** Optional connect timeout in ms. Default 8 s. */
  timeoutMs?: number;
}

export interface MCPConnection {
  /** User-defined server name from the config key (e.g. "tavily"). */
  name: string;
  /** The connected client. Use to invoke tools. */
  client: Client;
  /** The transport so we can `terminateSession` on shutdown. */
  transport: StreamableHTTPClientTransport;
  /** Tools advertised by this server, translated to OpenAI shape with
   *  namespaced names (`mcp_<server>_<tool>`). Drop into `chatStream`'s
   *  `tools` array alongside the built-ins. */
  tools: ToolSchema[];
  /** Lookup the original server tool name from a namespaced name. */
  toolMap: Map<string, string>;
}

interface MCPRootConfig {
  servers?: Record<string, MCPServerConfig>;
}

/**
 * Walk `${VAR}` references in a string against process.env. Throws when
 * a referenced var is unset — fail-fast beats a silent auth bypass.
 */
function expandEnv(input: string, where: string): string {
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

/** Read mcp.servers from deepseek.json (via the same cache api.ts uses). */
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
  if (!config.url) throw new Error(`mcp server "${name}": url is required`);
  if (config.transport && config.transport !== "http") {
    throw new Error(
      `mcp server "${name}": transport "${config.transport}" not supported yet (HTTP only)`,
    );
  }

  // Build the URL with optional query expansion.
  const url = new URL(expandEnv(config.url, `mcp.${name}.url`));
  if (config.query) {
    for (const [k, v] of Object.entries(config.query)) {
      url.searchParams.set(k, expandEnv(v, `mcp.${name}.query.${k}`));
    }
  }

  // Expand headers up-front; the transport accepts a static headers map
  // (any provider needing dynamic re-auth should switch to an
  // AuthProvider, which the SDK supports — out of scope here).
  const headers: Record<string, string> = {};
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      headers[k] = expandEnv(v, `mcp.${name}.headers.${k}`);
    }
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });

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

  return { name, client, transport, tools, toolMap };
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
 */
export async function callMCPTool(
  connections: MCPConnection[],
  name: string,
  args: Record<string, unknown>,
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
  try {
    const r = await conn.client.callTool({ name: toolName, arguments: args });
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

/** Terminate sessions and close clients. Best-effort. */
export async function closeAll(connections: MCPConnection[]): Promise<void> {
  for (const c of connections) {
    try {
      await c.transport.terminateSession?.();
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
