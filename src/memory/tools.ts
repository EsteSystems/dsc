/**
 * Memory tool schemas (advertised to the model) and dispatch handler.
 *
 * These are the same tools the Python MCP server exposed, now native.
 */
import type { ToolSchema } from "../api.js";
import * as mem from "./index.js";

export const MEMORY_TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "mcp_memory_store_proposition",
      description: `
Extract atomic propositions from text, embed them, store as nodes,
and auto-link to existing nodes with typed edges.

Processing happens in the background so API latency doesn't block.
Returns immediately. Use get_stats() to see when new nodes appear.

Args:
    text: The text to extract propositions from (conversation, note, article, etc.)
    source: Optional label for where this came from (conversation id, url, etc.)
`.trim(),
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The text to extract propositions from." },
          source: { type: "string", description: "Optional label for where this came from." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_memory_query_memory",
      description: `
Search the knowledge graph for propositions relevant to the query.
Matched nodes are activated (weight boosted, neighbors propagated to).

Args:
    query: Natural language query
    n: Number of results to return (default 5)
`.trim(),
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language query" },
          n: { type: "integer", description: "Number of results to return (default 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_memory_get_tensions",
      description: `
Surface contradictions in the knowledge graph — pairs of high-weight
propositions that conflict. These are productive tensions, not errors.

Args:
    threshold: Minimum weight for both nodes to be considered (default 0.3)
`.trim(),
      parameters: {
        type: "object",
        properties: {
          threshold: { type: "number", description: "Minimum weight for both nodes (default 0.3)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_memory_get_node_detail",
      description: `
Get full details for a specific node including its edges.

Args:
    node_id: The node's numeric id
`.trim(),
      parameters: {
        type: "object",
        properties: {
          node_id: { type: "integer", description: "The node's numeric id" },
        },
        required: ["node_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_memory_get_stats",
      description: "Return summary statistics about the knowledge graph.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mcp_memory_decay",
      description: `
Apply time-based decay to all nodes. Highly connected nodes decay slower.
Run periodically to let unused knowledge recede.

Args:
    hours: Hours of decay to simulate (default 24)
`.trim(),
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Hours of decay to simulate (default 24)" },
        },
        required: [],
      },
    },
  },
];

/**
 * Dispatch memory tools. Returns the result content string.
 * Note: store_proposition is async (returns a promise), so callers
 * must await the result if they call it.
 */
export async function dispatchMemoryTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: string }> {
  switch (name) {
    case "mcp_memory_store_proposition":
      return {
        content: await mem.storePropositions(
          String(args.text ?? ""),
          typeof args.source === "string" ? args.source : null,
        ),
      };

    case "mcp_memory_query_memory":
      return {
        content: mem.queryMemory(
          String(args.query ?? ""),
          typeof args.n === "number" ? args.n : 5,
        ),
      };

    case "mcp_memory_get_tensions":
      return {
        content: mem.surfaceTensions(
          typeof args.threshold === "number" ? args.threshold : 0.3,
        ),
      };

    case "mcp_memory_get_node_detail":
      return {
        content: mem.getNodeDetail(
          typeof args.node_id === "number" ? args.node_id : parseInt(String(args.node_id ?? "0"), 10),
        ),
      };

    case "mcp_memory_get_stats":
      return { content: mem.memoryStats() };

    case "mcp_memory_decay":
      return {
        content: mem.memoryDecay(
          typeof args.hours === "number" ? args.hours : 24,
        ),
      };

    default:
      return { content: `error: unknown memory tool '${name}'` };
  }
}
