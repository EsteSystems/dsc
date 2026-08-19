import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Point every on-disk surface at throwaway dirs so commands that read/write
// config, sessions, audit, or preferences can't touch the developer's real
// files. Set before importing modules that resolve these lazily.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-slash-test-"));
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.XDG_DATA_HOME = path.join(SANDBOX, "data");
process.env.XDG_STATE_HOME = path.join(SANDBOX, "state");
process.env.DSC_NO_AUDIT = "1";
delete process.env.DEEPSEEK_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
// Several commands persist preferences via a fire-and-forget `void
// savePreferences(...)`. Pre-create the config dir so those writes (which
// outlive the synchronous handler) can't ENOENT, and drain them between
// tests so two never race on the shared preferences.json.tmp.
fs.mkdirSync(path.join(SANDBOX, "config", "dsc"), { recursive: true });
const flush = () => new Promise((r) => setTimeout(r, 30));

import { dispatchSlash, type SlashContext } from "../src/slash_dispatch.js";
import * as historyMod from "../src/history.js";
import { newStats, _resetConfigCachesForTests, type Message, type Model } from "../src/api.js";
import { setState } from "../src/store.js";

// A harness that builds a SlashContext over mutable state and records every
// action call + emitted line.
function makeCtx(over: { messages?: Message[]; editorResult?: string | null } = {}) {
  const cwd = fs.mkdtempSync(path.join(SANDBOX, "cwd-"));
  const emitted: string[] = [];
  let model: Model = "deepseek-v4-pro";
  const session = historyMod.newSession(cwd, model);
  const stats = newStats();
  const toolCtx = {
    cwd,
    yolo: false,
    filesTouched: new Set<string>(),
    sessionId: session.id,
    sessionApprovals: new Set<string>(),
  };
  const queue: string[] = [];
  let budget = { usd: null as number | null, warned: false };
  const messages: Message[] = over.messages ?? [];
  const calls = {
    setModel: [] as Model[],
    setBudget: [] as Array<{ usd: number | null; warned: boolean }>,
    persist: 0,
    syncStatus: 0,
    compact: [] as Array<{ keep: number; auto: boolean }>,
    submit: [] as string[],
    applySession: [] as Array<{ id: string; resetApprovals?: boolean; rebuildView?: boolean }>,
    runEditor: [] as string[],
    exit: 0,
  };
  const ctx: SlashContext = {
    cwd,
    emit: (t) => emitted.push(t),
    getModel: () => model,
    getStats: () => stats,
    getSession: () => session,
    getMessages: () => messages,
    getToolCtx: () => toolCtx,
    getQueue: () => queue,
    getBudget: () => budget,
    getMcpConnections: () => [],
    setModel: (m) => {
      model = m;
      calls.setModel.push(m);
    },
    setBudget: (usd, warned) => {
      budget = { usd, warned };
      calls.setBudget.push({ usd, warned });
    },
    persist: async () => {
      calls.persist++;
    },
    syncStatus: () => {
      calls.syncStatus++;
    },
    compact: async (keep, auto) => {
      calls.compact.push({ keep, auto });
    },
    submit: (t) => calls.submit.push(t),
    applySession: (next, opts) => {
      calls.applySession.push({ id: next.id, ...opts });
    },
    runEditor: (initial) => {
      calls.runEditor.push(initial);
      return over.editorResult === undefined ? "drafted text" : over.editorResult;
    },
    exit: () => {
      calls.exit++;
    },
  };
  return { ctx, emitted, calls, session, toolCtx, queue, getModel: () => model, getBudget: () => budget };
}

const last = (a: string[]) => a[a.length - 1] ?? "";

beforeEach(() => {
  // Reset store fields the dispatcher reads/writes.
  setState({ reasoning: true, autoContinue: 0, history: [] });
});

// Drain fire-and-forget preference writes so they don't race the next test or
// outlive the suite.
afterEach(flush);

describe("dispatchSlash routing", () => {
  it("returns false for non-slash input", async () => {
    const { ctx } = makeCtx();
    assert.equal(await dispatchSlash("just a prompt", ctx), false);
  });

  it("returns true and reports an unknown command", async () => {
    const { ctx, emitted } = makeCtx();
    assert.equal(await dispatchSlash("/wat", ctx), true);
    assert.match(last(emitted), /unknown command: \/wat/);
  });

  it("/help lists commands", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/help", ctx);
    assert.match(emitted[0], /\/clear/);
    assert.match(emitted[0], /\/exit/);
  });

  it("/plan-agent with no prompt prints usage", async () => {
    const { ctx, emitted } = makeCtx();
    assert.equal(await dispatchSlash("/plan-agent", ctx), true);
    assert.match(last(emitted), /usage: \/plan-agent/);
  });

  it("/exit calls the exit action", async () => {
    const { ctx, calls } = makeCtx();
    await dispatchSlash("/exit", ctx);
    assert.equal(calls.exit, 1);
  });
});

describe("/model", () => {
  it("shows the current model with no arg", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/model", ctx);
    assert.match(last(emitted), /current model: deepseek-v4-pro/);
  });

  it("rejects an unknown model", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/model gpt-5", ctx);
    assert.match(last(emitted), /unknown model: gpt-5/);
    assert.equal(calls.setModel.length, 0);
  });

  it("switches to a valid model and persists", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/model deepseek-v4-flash", ctx);
    assert.deepEqual(calls.setModel, ["deepseek-v4-flash"]);
    assert.equal(calls.syncStatus, 1);
    assert.equal(calls.persist, 1);
    assert.match(last(emitted), /model → deepseek-v4-flash/);
  });
});

describe("/yolo", () => {
  it("toggles the tool context's yolo flag", async () => {
    const { ctx, toolCtx, emitted } = makeCtx();
    assert.equal(toolCtx.yolo, false);
    await dispatchSlash("/yolo", ctx);
    assert.equal(toolCtx.yolo, true);
    assert.match(last(emitted), /yolo: true/);
    // Let the first fire-and-forget save finish before the second toggle so
    // the two don't race on the shared preferences.json.tmp.
    await flush();
    await dispatchSlash("/yolo", ctx);
    assert.equal(toolCtx.yolo, false);
  });
});

describe("/budget", () => {
  it("reports 'not set' by default", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/budget", ctx);
    assert.match(last(emitted), /budget: not set/);
  });

  it("sets a numeric ceiling", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/budget 5", ctx);
    assert.deepEqual(calls.setBudget, [{ usd: 5, warned: false }]);
    assert.match(last(emitted), /budget: \$5\.00/);
  });

  it("clears with off", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/budget off", ctx);
    assert.deepEqual(calls.setBudget, [{ usd: null, warned: false }]);
    assert.match(last(emitted), /budget cleared/);
  });

  it("rejects a non-numeric amount", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/budget lots", ctx);
    assert.match(last(emitted), /usage: \/budget/);
    assert.equal(calls.setBudget.length, 0);
  });
});

describe("/queue", () => {
  it("reports an empty queue", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/queue", ctx);
    assert.match(last(emitted), /queue is empty/);
  });

  it("lists queued prompts", async () => {
    const { ctx, emitted, queue } = makeCtx();
    queue.push("first", "second");
    await dispatchSlash("/queue", ctx);
    assert.match(last(emitted), /1\. first/);
    assert.match(last(emitted), /2\. second/);
  });

  it("clears the queue", async () => {
    const { ctx, emitted, queue, calls } = makeCtx();
    queue.push("a", "b", "c");
    await dispatchSlash("/queue clear", ctx);
    assert.equal(queue.length, 0);
    assert.equal(calls.syncStatus, 1);
    assert.match(last(emitted), /cleared 3 queued/);
  });
});

describe("/clear", () => {
  it("applies a fresh session with approvals reset", async () => {
    const { ctx, emitted, calls } = makeCtx();
    await dispatchSlash("/clear", ctx);
    assert.equal(calls.applySession.length, 1);
    assert.equal(calls.applySession[0].resetApprovals, true);
    assert.equal(calls.applySession[0].rebuildView, false);
    assert.match(last(emitted), /new session started/);
  });
});

describe("/cost", () => {
  it("emits the cost summary", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/cost", ctx);
    assert.match(last(emitted), /cost: \$/);
    assert.match(last(emitted), /tools:/);
  });
});

describe("/compact", () => {
  it("delegates to the compact action with the default keep", async () => {
    const { ctx, calls } = makeCtx();
    await dispatchSlash("/compact", ctx);
    assert.deepEqual(calls.compact, [{ keep: 4, auto: false }]);
  });

  it("parses an explicit keep count", async () => {
    const { ctx, calls } = makeCtx();
    await dispatchSlash("/compact 2", ctx);
    assert.deepEqual(calls.compact, [{ keep: 2, auto: false }]);
  });
});

describe("/edit", () => {
  it("submits the editor draft", async () => {
    const { ctx, calls } = makeCtx({ editorResult: "hello from editor" });
    await dispatchSlash("/edit", ctx);
    assert.deepEqual(calls.runEditor, [""]);
    assert.deepEqual(calls.submit, ["hello from editor"]);
  });

  it("passes initial text into the editor", async () => {
    const { ctx, calls } = makeCtx({ editorResult: "x" });
    await dispatchSlash("/edit draft this", ctx);
    assert.deepEqual(calls.runEditor, ["draft this\n"]);
  });

  it("reports an editor failure (null)", async () => {
    const { ctx, emitted, calls } = makeCtx({ editorResult: null });
    await dispatchSlash("/edit", ctx);
    assert.match(last(emitted), /editor failed/);
    assert.equal(calls.submit.length, 0);
  });

  it("skips an empty draft", async () => {
    const { ctx, emitted, calls } = makeCtx({ editorResult: "   " });
    await dispatchSlash("/edit", ctx);
    assert.match(last(emitted), /empty draft/);
    assert.equal(calls.submit.length, 0);
  });
});

describe("/transcript", () => {
  it("reports no messages when empty", async () => {
    const { ctx, emitted } = makeCtx({ messages: [] });
    await dispatchSlash("/transcript", ctx);
    assert.match(last(emitted), /no messages/);
  });

  it("renders active messages with roles and tool calls", async () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "file.txt" },
    ];
    const { ctx, emitted } = makeCtx({ messages });
    await dispatchSlash("/transcript", ctx);
    const out = last(emitted);
    assert.match(out, /active \(3 messages\)/);
    assert.match(out, /→ bash/);
    assert.match(out, /tool_call_id: t1/);
  });
});

describe("/list and /resume with no sessions", () => {
  it("/list reports none for a fresh cwd", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/list", ctx);
    assert.match(last(emitted), /no sessions for/);
  });

  it("/resume reports nothing to resume", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/resume", ctx);
    assert.match(last(emitted), /no sessions to resume/);
  });
});

describe("/instructions and /mcp with nothing configured", () => {
  it("/instructions explains where overlays live", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/instructions", ctx);
    assert.match(last(emitted), /No instruction overlays found/);
  });

  it("/mcp explains how to configure a server", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/mcp", ctx);
    assert.match(last(emitted), /No MCP servers connected/);
  });
});

describe("/api-key (multi-provider)", () => {
  it("lists every provider's key status with no arg", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/api-key", ctx);
    assert.match(last(emitted), /deepseek:/);
    assert.match(last(emitted), /anthropic:/);
  });

  it("saves a named provider's key", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/api-key anthropic sk-ant-123", ctx);
    assert.match(last(emitted), /anthropic key saved to/);
  });

  it("treats a bare key as the DeepSeek key (back-compat)", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/api-key sk-deepseek-bare", ctx);
    assert.match(last(emitted), /deepseek key saved to/);
  });

  it("shows status + signup for a named provider with no key", async () => {
    const { ctx, emitted } = makeCtx();
    await dispatchSlash("/api-key anthropic", ctx);
    assert.match(last(emitted), /anthropic/);
    assert.match(last(emitted), /console\.anthropic\.com|signup/);
  });
});

describe("/model availability", () => {
  it("rejects a provider model with no key, pointing at /api-key", async () => {
    // Isolate: fresh empty config + no Anthropic key so Claude is unavailable,
    // regardless of what other tests in this process have saved.
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevA = process.env.ANTHROPIC_API_KEY;
    process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(SANDBOX, "noenv-"));
    delete process.env.ANTHROPIC_API_KEY;
    _resetConfigCachesForTests();
    try {
      const { ctx, emitted, calls } = makeCtx();
      await dispatchSlash("/model claude-sonnet-4-6", ctx);
      assert.match(last(emitted), /needs the Anthropic API key/);
      assert.equal(calls.setModel.length, 0);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevA;
      _resetConfigCachesForTests();
    }
  });
});
