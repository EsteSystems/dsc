import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  runAgent,
  repairToolCallPairing,
  estimateContextTokens,
  formatStatus,
  formatCost,
  MAX_TOOL_DEPTH,
  compressToolOutput,
  toolOutputMaxChars,
  type AgentEvents,
} from "../src/agent.js";
import {
  newStats,
  type ChatResponse,
  type Message,
  type ToolCall,
  type Usage,
} from "../src/api.js";
import type { ToolContext } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tc(id: string, name: string, args = "{}"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

/** Build an assistant ChatResponse. With tool_calls → the loop continues;
 *  without → the loop treats it as "I'm done" and returns. */
function asstResp(opts: {
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCall[];
  usage?: Usage;
}): ChatResponse {
  const message: ChatResponse["choices"][number]["message"] = {
    role: "assistant",
    content: opts.content ?? "",
  };
  if (opts.reasoning) message.reasoning_content = opts.reasoning;
  if (opts.tool_calls) message.tool_calls = opts.tool_calls;
  return {
    choices: [{ message, finish_reason: opts.tool_calls ? "tool_calls" : "stop" }],
    usage: opts.usage,
  };
}

/** A transport that returns queued responses in order. Once the queue is
 *  drained it returns a no-tool "done" response so a test that under-scripts
 *  can't spin forever. Records the messages each call was sent. */
function scriptedTransport(queue: ChatResponse[]) {
  const sent: Message[][] = [];
  const fn = async (o: { messages: Message[]; onContent?: (t: string) => void }) => {
    sent.push(o.messages);
    const next = queue.shift() ?? asstResp({ content: "done" });
    return next;
  };
  return { fn, sent };
}

/** A transport that returns the same response every call (for cap/loop tests). */
function constantTransport(resp: ChatResponse) {
  let calls = 0;
  const fn = async () => {
    calls++;
    return resp;
  };
  return { fn, get calls() { return calls; } };
}

function recorder() {
  const ev = {
    starts: [] as string[],
    content: [] as string[],
    reasoning: [] as string[],
    finals: [] as Array<{ content: string; reasoning?: string; tool_calls?: ToolCall[] }>,
    toolStarts: [] as Array<{ id: string; name: string; args: string }>,
    toolEnds: [] as Array<{ id: string; name: string; content: string; rejected: boolean }>,
    notices: [] as string[],
  };
  const events: AgentEvents = {
    onAssistantStart: (id) => ev.starts.push(id),
    onAssistantContent: (_id, c) => ev.content.push(c),
    onAssistantReasoning: (_id, c) => ev.reasoning.push(c),
    onAssistantFinal: (_id, m) => ev.finals.push(m),
    onToolStart: (id, name, args) => ev.toolStarts.push({ id, name, args }),
    onToolEnd: (id, name, content, rejected) =>
      ev.toolEnds.push({ id, name, content, rejected }),
    onNotice: (t) => ev.notices.push(t),
  };
  return { ev, events };
}

function ctx(cwd: string): ToolContext {
  return { cwd, yolo: true, filesTouched: new Set(), sessionId: "test" };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-agent-test-"));

// ---------------------------------------------------------------------------
// repairToolCallPairing — the crown jewel: heals interrupted sessions that
// would otherwise 400 forever ("tool_calls must be followed by tool messages").
// ---------------------------------------------------------------------------

describe("repairToolCallPairing", () => {
  it("leaves a message list with no tool_calls untouched", () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    assert.deepEqual(repairToolCallPairing(msgs), msgs);
  });

  it("leaves a fully-answered tool_call pair untouched", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "", tool_calls: [tc("a", "read_file")] },
      { role: "tool", tool_call_id: "a", content: "file contents" },
    ];
    const out = repairToolCallPairing(msgs);
    assert.equal(out.length, 2);
    assert.deepEqual(out, msgs);
  });

  it("stubs an orphaned tool_call (turn interrupted before the tool ran)", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "", tool_calls: [tc("a", "bash")] },
      // no tool message — process died here
    ];
    const out = repairToolCallPairing(msgs);
    assert.equal(out.length, 2);
    assert.equal(out[1].role, "tool");
    assert.equal(out[1].tool_call_id, "a");
    assert.match(out[1].content as string, /recovered from interrupted turn/);
  });

  it("stubs only the missing responses when some tool_calls are answered", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [tc("a", "read_file"), tc("b", "bash"), tc("c", "grep")],
      },
      { role: "tool", tool_call_id: "a", content: "ok a" },
      // b and c never got results
    ];
    const out = repairToolCallPairing(msgs);
    const toolMsgs = out.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 3);
    const ids = toolMsgs.map((m) => m.tool_call_id);
    assert.deepEqual(ids.sort(), ["a", "b", "c"]);
    // The real answer for "a" is preserved; b and c are stubs.
    assert.equal(toolMsgs.find((m) => m.tool_call_id === "a")!.content, "ok a");
    assert.match(
      toolMsgs.find((m) => m.tool_call_id === "b")!.content as string,
      /recovered/,
    );
  });

  it("repairs multiple assistant tool-call turns independently", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "", tool_calls: [tc("a", "read_file")] },
      { role: "tool", tool_call_id: "a", content: "ok" },
      { role: "user", content: "next" },
      { role: "assistant", content: "", tool_calls: [tc("b", "bash")] },
      // b orphaned
    ];
    const out = repairToolCallPairing(msgs);
    const stub = out.find((m) => m.role === "tool" && m.tool_call_id === "b");
    assert.ok(stub, "orphan b should be stubbed");
    // The already-answered "a" pair is not duplicated.
    assert.equal(out.filter((m) => m.tool_call_id === "a").length, 1);
  });

  it("does not mutate the input array", () => {
    const msgs: Message[] = [
      { role: "assistant", content: "", tool_calls: [tc("a", "bash")] },
    ];
    const len = msgs.length;
    repairToolCallPairing(msgs);
    assert.equal(msgs.length, len, "input must be left intact");
  });
});

// ---------------------------------------------------------------------------
// tool-output truncation
// ---------------------------------------------------------------------------

describe("tool-output truncation", () => {
  it("defaults to 8k and honors DSC_TOOL_OUTPUT_MAX_CHARS", () => {
    const old = process.env.DSC_TOOL_OUTPUT_MAX_CHARS;
    try {
      delete process.env.DSC_TOOL_OUTPUT_MAX_CHARS;
      assert.equal(toolOutputMaxChars(), 8_000);
      process.env.DSC_TOOL_OUTPUT_MAX_CHARS = "2000";
      assert.equal(toolOutputMaxChars(), 2_000);
      process.env.DSC_TOOL_OUTPUT_MAX_CHARS = "bogus";
      assert.equal(toolOutputMaxChars(), 8_000);
    } finally {
      if (old === undefined) delete process.env.DSC_TOOL_OUTPUT_MAX_CHARS;
      else process.env.DSC_TOOL_OUTPUT_MAX_CHARS = old;
    }
  });

  it("keeps head and tail markers and drops the middle when truncating", () => {
    const marker = "__M__";
    const head = marker + "x".repeat(500);
    const tail = "x".repeat(500) + marker;
    assert.ok(compressToolOutput(head, 400).includes(marker));
    assert.ok(compressToolOutput(tail, 400).includes(marker));
  });
});

// ---------------------------------------------------------------------------
// runAgent — the tool-call loop, driven by an injected transport.
// ---------------------------------------------------------------------------

describe("runAgent loop", () => {
  it("converges: a no-tool response pushes one assistant message and returns", async () => {
    const { fn } = scriptedTransport([asstResp({ content: "the answer is 42" })]);
    const messages: Message[] = [{ role: "user", content: "q" }];
    const stats = newStats();
    const { ev, events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats,
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
    });

    const assistants = messages.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].content, "the answer is 42");
    assert.equal(ev.finals.length, 1);
    assert.equal(ev.finals[0].content, "the answer is 42");
    // No system message is persisted onto `messages` — it's built fresh per call.
    assert.equal(messages.filter((m) => m.role === "system").length, 0);
  });

  it("executes an MCP tool call, records the result, then converges", async () => {
    const { fn } = scriptedTransport([
      asstResp({ tool_calls: [tc("c1", "mcp_test_noop", '{"x":1}')] }),
      asstResp({ content: "done" }),
    ]);
    const messages: Message[] = [{ role: "user", content: "do it" }];
    const stats = newStats();
    const { ev, events } = recorder();
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];

    await runAgent({
      model: "deepseek-v4-pro",
      stats,
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
      dispatchExtraTool: async (name, args) => {
        dispatched.push({ name, args });
        return { content: "tool said hi" };
      },
    });

    assert.deepEqual(dispatched, [{ name: "mcp_test_noop", args: { x: 1 } }]);
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.equal(toolMsg!.tool_call_id, "c1");
    assert.equal(toolMsg!.content, "tool said hi");
    // Stats counted the tool call.
    assert.equal(stats.tool_calls_total, 1);
    assert.equal(stats.tool_calls_by_name["mcp_test_noop"], 1);
    // Events: tool start + end fired with the right name.
    assert.equal(ev.toolStarts.length, 1);
    assert.equal(ev.toolStarts[0].name, "mcp_test_noop");
    assert.equal(ev.toolEnds.length, 1);
    assert.equal(ev.toolEnds[0].rejected, false);
  });

  it("advertises only toolSchemas when provided, not the built-in set", async () => {
    let sentTools: Array<{ function: { name: string } }> | undefined;
    const fn = async (o: { tools?: Array<{ function: { name: string } }> }) => {
      sentTools = o.tools;
      return asstResp({ content: "done" });
    };
    const messages: Message[] = [{ role: "user", content: "probe" }];

    await runAgent({
      model: "deepseek-v4-pro",
      stats: newStats(),
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      toolSchemas: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file.",
            parameters: { type: "object", properties: {}, required: [] },
          },
        },
      ],
    });

    assert.deepEqual(
      sentTools?.map((t) => t.function.name),
      ["read_file"],
    );
  });

  it("routes non-mcp names to the built-in executor (read_file)", async () => {
    const file = path.join(TMP, "hello.txt");
    fs.writeFileSync(file, "line one\nline two\n");
    const { fn } = scriptedTransport([
      asstResp({ tool_calls: [tc("r1", "read_file", JSON.stringify({ path: file }))] }),
      asstResp({ content: "read it" }),
    ]);
    const messages: Message[] = [{ role: "user", content: "read the file" }];
    const { events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats: newStats(),
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
      // dispatchExtraTool present but should NOT be used for a non-mcp name.
      dispatchExtraTool: async () => {
        throw new Error("dispatchExtraTool should not run for read_file");
      },
    });

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg);
    assert.match(toolMsg!.content as string, /line one/);
    assert.match(toolMsg!.content as string, /line two/);
  });

  it("streams content through onAssistantStart/Content when the transport emits", async () => {
    const fn = async (o: { onContent?: (t: string) => void }) => {
      o.onContent?.("hel");
      o.onContent?.("lo");
      return asstResp({ content: "hello" });
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const { ev, events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats: newStats(),
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
    });

    assert.equal(ev.starts.length, 1, "onAssistantStart fires once on first chunk");
    assert.deepEqual(ev.content, ["hel", "lo"]);
  });

  it("injects an edit reminder into the next model call after a write", async () => {
    const file = path.join(TMP, `reminder-${Date.now()}.txt`);
    const { fn, sent } = scriptedTransport([
      asstResp({
        tool_calls: [tc("w1", "write_file", JSON.stringify({ path: file, content: "x" }))],
      }),
      asstResp({ content: "done" }),
    ]);
    const messages: Message[] = [{ role: "user", content: "make a file" }];
    const { events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats: newStats(),
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
    });

    assert.ok(sent.length >= 2, "expected at least two model calls");
    const secondSystem = sent[1].find((m) => m.role === "system")?.content;
    assert.ok(secondSystem, "second call should have a system message");
    assert.match(secondSystem as string, /Decision-time reminder/);
    assert.match(secondSystem as string, /Run verify/);
  });

  it("converts a tool throw into a synthetic error result, then re-throws", async () => {
    const { fn } = scriptedTransport([
      asstResp({ tool_calls: [tc("c1", "mcp_boom")] }),
    ]);
    const messages: Message[] = [{ role: "user", content: "boom" }];
    const { ev, events } = recorder();

    await assert.rejects(
      runAgent({
        model: "deepseek-v4-pro",
        stats: newStats(),
        toolCtx: ctx(TMP),
        messages,
        chatStream: fn,
        events,
        dispatchExtraTool: async () => {
          throw new Error("kaboom");
        },
      }),
      /kaboom/,
    );

    // The synthetic tool result must be recorded so the persisted history
    // stays API-valid (assistant tool_call → matching tool message).
    const toolMsg = messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "a tool message must exist even though the tool threw");
    assert.equal(toolMsg!.tool_call_id, "c1");
    assert.match(toolMsg!.content as string, /^error: kaboom/);
    assert.equal(ev.toolEnds[0].rejected, false);
  });

  it("stub-fills the remaining tool_calls when an earlier one throws", async () => {
    const { fn } = scriptedTransport([
      asstResp({ tool_calls: [tc("c1", "mcp_boom"), tc("c2", "mcp_b"), tc("c3", "mcp_c")] }),
    ]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    const { events } = recorder();

    await assert.rejects(
      runAgent({
        model: "deepseek-v4-pro",
        stats: newStats(),
        toolCtx: ctx(TMP),
        messages,
        chatStream: fn,
        events,
        dispatchExtraTool: async (name) => {
          if (name === "mcp_boom") throw new Error("first failed");
          return { content: "should not get here" };
        },
      }),
      /first failed/,
    );

    const toolMsgs = messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 3, "all three tool_calls get a tool message");
    assert.match(toolMsgs[0].content as string, /^error: first failed/);
    assert.match(toolMsgs[1].content as string, /skipped: previous tool was interrupted/);
    assert.match(toolMsgs[2].content as string, /skipped: previous tool was interrupted/);
  });

  it("marks an aborted tool result as 'interrupted' / rejected", async () => {
    const { fn } = scriptedTransport([asstResp({ tool_calls: [tc("c1", "mcp_slow")] })]);
    const messages: Message[] = [{ role: "user", content: "x" }];
    const { ev, events } = recorder();

    await assert.rejects(
      runAgent({
        model: "deepseek-v4-pro",
        stats: newStats(),
        toolCtx: ctx(TMP),
        messages,
        chatStream: fn,
        events,
        dispatchExtraTool: async () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        },
      }),
    );

    const toolMsg = messages.find((m) => m.role === "tool");
    assert.equal(toolMsg!.content, "interrupted");
    assert.equal(ev.toolEnds[0].rejected, true);
  });
});

// ---------------------------------------------------------------------------
// runAgent — the budget / auto-continue outer loop.
// ---------------------------------------------------------------------------

describe("runAgent budget loop", () => {
  it("stops with a MAX_TOOL_DEPTH notice when the model never converges", async () => {
    // Always returns a tool call → never converges.
    const { fn, calls } = constantTransport(
      asstResp({ tool_calls: [tc("c", "mcp_loop")] }),
    );
    void calls;
    const messages: Message[] = [{ role: "user", content: "loop" }];
    const stats = newStats();
    const { ev, events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats,
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
      maxAutoContinue: 0,
      dispatchExtraTool: async () => ({ content: "ok" }),
    });

    assert.equal(stats.tool_calls_total, MAX_TOOL_DEPTH);
    assert.equal(ev.notices.length, 1);
    assert.match(ev.notices[0], new RegExp(`MAX_TOOL_DEPTH=${MAX_TOOL_DEPTH}`));
  });

  it("grants one extra budget when maxAutoContinue=1, then stops", async () => {
    const { fn } = constantTransport(asstResp({ tool_calls: [tc("c", "mcp_loop")] }));
    const messages: Message[] = [{ role: "user", content: "loop" }];
    const stats = newStats();
    const { ev, events } = recorder();

    await runAgent({
      model: "deepseek-v4-pro",
      stats,
      toolCtx: ctx(TMP),
      messages,
      chatStream: fn,
      events,
      maxAutoContinue: 1,
      dispatchExtraTool: async () => ({ content: "ok" }),
    });

    // Two budgets worth of tool calls.
    assert.equal(stats.tool_calls_total, MAX_TOOL_DEPTH * 2);
    // One auto-continue notice + one final stop notice.
    const autoNotice = ev.notices.find((n) => /auto-continue 1\/1/.test(n));
    const stopNotice = ev.notices.find((n) => /auto-continue\(s\)/.test(n));
    assert.ok(autoNotice, "should announce the auto-continue grant");
    assert.ok(stopNotice, "should announce stopping after the grant");
  });
});

// ---------------------------------------------------------------------------
// Pure formatters / estimators.
// ---------------------------------------------------------------------------

describe("estimateContextTokens", () => {
  it("is zero for an empty message list", () => {
    assert.equal(estimateContextTokens([]), 0);
  });

  it("counts content and reasoning at ~4 chars per token", () => {
    const msgs: Message[] = [
      { role: "user", content: "a".repeat(40) }, // 10 tokens
      { role: "assistant", content: "b".repeat(20), reasoning_content: "c".repeat(20) }, // 5 + 5
    ];
    assert.equal(estimateContextTokens(msgs), 20);
  });

  it("ignores non-string content (e.g. null)", () => {
    const msgs: Message[] = [{ role: "assistant", content: null }];
    assert.equal(estimateContextTokens(msgs), 0);
  });
});

describe("formatStatus", () => {
  it("includes model name and cost", () => {
    const s = formatStatus(newStats(), "deepseek-v4-pro", { yolo: false });
    assert.match(s, /deepseek-v4-pro/);
    assert.match(s, /\$0\.0000/);
  });

  it("surfaces yolo / no-reasoning / compacted flags", () => {
    const s = formatStatus(newStats(), "deepseek-v4-pro", {
      yolo: true,
      reasoning: false,
      compacted: true,
    });
    assert.match(s, /yolo/);
    assert.match(s, /no-reasoning/);
    assert.match(s, /compacted/);
  });

  it("omits ctx and queued when not provided / zero", () => {
    const s = formatStatus(newStats(), "deepseek-v4-pro", { yolo: false });
    assert.doesNotMatch(s, /ctx:/);
    assert.doesNotMatch(s, /queued:/);
  });

  it("shows ctx and queued when provided", () => {
    const s = formatStatus(newStats(), "deepseek-v4-pro", {
      yolo: false,
      contextTokens: 9200,
      queued: 2,
    });
    assert.match(s, /ctx:9\.2K/);
    assert.match(s, /queued:2/);
  });
});

describe("formatCost", () => {
  it("reports cost, token breakdown, and tool count", () => {
    const stats = { ...newStats(), prompt_tokens: 100, completion_tokens: 50, tool_calls_total: 3 };
    const s = formatCost(stats, "deepseek-v4-pro");
    assert.match(s, /cost: \$/);
    assert.match(s, /in: 100/);
    assert.match(s, /out: 50/);
    assert.match(s, /tools: 3/);
  });
});
