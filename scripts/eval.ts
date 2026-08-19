/**
 * Deterministic agent-evaluation harness.
 *
 * Usage:
 *   npm run eval [-- --threshold 0.8] [fixture-glob]
 *
 * Fixtures are JSON files. Each drives runAgent with a scripted (no-network)
 * chat transport, then checks simple assertions against the resulting message
 * list. See eval/fixtures/*.json for the schema.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentEvents } from "../src/agent.js";
import {
  newStats,
  DEFAULT_MODEL,
  type ChatResponse,
  type Message,
  type ToolCall,
  type Usage,
} from "../src/api.js";
import type { ToolContext } from "../src/tools.js";

interface ScriptTurn {
  content?: string;
  tool_calls?: Array<{ id: string; name: string; args: unknown }>;
}

interface FixtureAssertions {
  converged?: boolean;
  tool_calls?: string[];
  result_contains?: string;
  last_content_contains?: string;
  no_tool?: boolean;
}

interface Fixture {
  name: string;
  prompt: string;
  setup?: { files?: Record<string, string> };
  script: ScriptTurn[];
  assertions: FixtureAssertions;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "..", "eval", "fixtures");

function toToolCalls(calls: ScriptTurn["tool_calls"]): ToolCall[] | undefined {
  if (!calls) return undefined;
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
  }));
}

function toChatResponse(turn: ScriptTurn): ChatResponse {
  const tool_calls = toToolCalls(turn.tool_calls);
  const message: ChatResponse["choices"][number]["message"] = {
    role: "assistant",
    content: turn.content ?? "",
  };
  if (tool_calls) message.tool_calls = tool_calls;
  return {
    choices: [{ message, finish_reason: tool_calls ? "tool_calls" : "stop" }],
    usage: undefined as Usage | undefined,
  };
}

async function loadFixtures(globPattern?: string): Promise<Fixture[]> {
  let files: string[];
  try {
    files = (await fs.readdir(FIXTURE_DIR))
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(FIXTURE_DIR, f))
      .sort();
  } catch {
    throw new Error(`eval fixture dir not found: ${FIXTURE_DIR}`);
  }
  if (globPattern) {
    const raw = globPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const re = new RegExp(`^${raw}$`);
    files = files.filter((f) => re.test(path.basename(f)));
  }
  const fixtures: Fixture[] = [];
  for (const file of files) {
    fixtures.push(JSON.parse(await fs.readFile(file, "utf8")) as Fixture);
  }
  return fixtures;
}

async function setupFixture(f: Fixture): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `dsc-eval-${f.name.replace(/\W+/g, "-")}-`));
  if (f.setup?.files) {
    for (const [rel, content] of Object.entries(f.setup.files)) {
      const abs = path.resolve(cwd, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
    }
  }
  return cwd;
}

function scriptedTransport(queue: ChatResponse[]) {
  const fn = async (o: { messages: Message[]; onContent?: (t: string) => void }) => {
    return queue.shift() ?? toChatResponse({ content: "done" });
  };
  return fn;
}

const quietEvents: AgentEvents = {
  onAssistantStart: () => {},
  onAssistantContent: () => {},
  onAssistantReasoning: () => {},
  onAssistantFinal: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onNotice: () => {},
};

async function runFixture(f: Fixture): Promise<{ name: string; pass: boolean; detail: string }> {
  const cwd = await setupFixture(f);
  const messages: Message[] = [{ role: "user", content: f.prompt }];
  const stats = newStats();
  const toolCtx: ToolContext = {
    cwd,
    yolo: true,
    filesTouched: new Set<string>(),
    sessionId: `eval-${f.name}`,
  };

  const responses = f.script.map(toChatResponse);
  await runAgent({
    model: DEFAULT_MODEL,
    stats,
    toolCtx,
    messages,
    chatStream: scriptedTransport(responses),
    maxAutoContinue: 0,
    events: quietEvents,
  });

  const assistantMsgs = messages.filter((m) => m.role === "assistant");
  const toolMsgs = messages.filter((m) => m.role === "tool");
  const calledTools = assistantMsgs.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function.name));
  const lastAssistant = [...assistantMsgs].reverse().find((m) => m.role === "assistant");
  const errors: string[] = [];

  if (f.assertions.converged !== undefined) {
    const converged = lastAssistant ? !lastAssistant.tool_calls?.length : true;
    if (converged !== f.assertions.converged) {
      errors.push(`converged: expected ${f.assertions.converged}, got ${converged}`);
    }
  }
  if (f.assertions.no_tool) {
    if (calledTools.length !== 0) errors.push(`no_tool: got ${calledTools.join(",")}`);
  }
  if (f.assertions.tool_calls) {
    for (const t of f.assertions.tool_calls) {
      if (!calledTools.includes(t)) errors.push(`missing tool call '${t}' (got: ${calledTools.join(",") || "none"})`);
    }
  }
  if (f.assertions.result_contains) {
    const allToolContent = toolMsgs.map((m) => m.content).join("\n");
    if (!allToolContent.includes(f.assertions.result_contains)) {
      errors.push(`result_contains: '${f.assertions.result_contains}' not found in tool output`);
    }
  }
  if (f.assertions.last_content_contains) {
    const content = lastAssistant?.content ?? "";
    if (!content.includes(f.assertions.last_content_contains)) {
      errors.push(`last_content_contains: '${f.assertions.last_content_contains}' not found in '${content.slice(0, 80)}'`);
    }
  }

  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  return {
    name: f.name,
    pass: errors.length === 0,
    detail: errors.length ? errors.join("; ") : "ok",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let threshold = 1;
  let pattern: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold") {
      threshold = Number(args[++i]);
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        throw new Error("--threshold must be between 0 and 1");
      }
    } else {
      pattern = args[i];
    }
  }

  const fixtures = await loadFixtures(pattern);
  if (fixtures.length === 0) {
    console.log("no eval fixtures found");
    process.exit(0);
  }

  let pass = 0;
  for (const f of fixtures) {
    const r = await runFixture(f);
    console.log(`${r.pass ? "✓" : "✗"} ${r.name} — ${r.detail}`);
    if (r.pass) pass++;
  }

  const rate = pass / fixtures.length;
  console.log(`\n${pass}/${fixtures.length} passed (${(rate * 100).toFixed(0)}%, threshold ${threshold * 100}%)`);
  process.exit(rate >= threshold ? 0 : 1);
}

main().catch((e) => {
  console.error(`eval: ${e.message ?? e}`);
  process.exit(2);
});
