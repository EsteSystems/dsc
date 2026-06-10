import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// A key must be present so requireAnthropicKey() passes; env short-circuits
// the config-file read, so no disk access.
process.env.ANTHROPIC_API_KEY = "sk-ant-test";

import {
  chat,
  chatStream,
  toAnthropic,
  toAnthropicTools,
  mapAnthropicStop,
  anthropicUsage,
  type Message,
  type ToolSchema,
} from "../src/api.js";

// ---------------------------------------------------------------------------
// Pure translation: normalized message list → Anthropic (system, messages)
// ---------------------------------------------------------------------------

describe("toAnthropic", () => {
  it("lifts the system message to a top-level field", () => {
    const { system, messages } = toAnthropic([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(system, "you are helpful");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { role: "user", content: "hi" });
  });

  it("turns assistant tool_calls into tool_use blocks with parsed input", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "run it" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
        ],
      },
    ]);
    const asst = messages[1];
    assert.equal(asst.role, "assistant");
    const blocks = asst.content as any[];
    assert.deepEqual(blocks[0], { type: "text", text: "on it" });
    assert.deepEqual(blocks[1], { type: "tool_use", id: "c1", name: "bash", input: { command: "ls" } });
  });

  it("coalesces consecutive tool results into one user turn", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "file body" },
      { role: "tool", tool_call_id: "b", content: "match line" },
      { role: "assistant", content: "done" },
    ]);
    // user, assistant(tool_use x2), user(tool_result x2), assistant(text)
    assert.equal(messages.length, 4);
    const results = messages[2];
    assert.equal(results.role, "user");
    const blocks = results.content as any[];
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: "tool_result", tool_use_id: "a", content: "file body" });
    assert.deepEqual(blocks[1], { type: "tool_result", tool_use_id: "b", content: "match line" });
    assert.equal(messages[3].role, "assistant");
  });

  it("guards against empty assistant content", () => {
    const { messages } = toAnthropic([
      { role: "user", content: "x" },
      { role: "assistant", content: "" },
    ]);
    const blocks = messages[1].content as any[];
    assert.ok(blocks.length >= 1, "must not emit empty content");
  });
});

describe("toAnthropicTools", () => {
  it("maps OpenAI function schema to Anthropic input_schema", () => {
    const tools: ToolSchema[] = [
      {
        type: "function",
        function: { name: "bash", description: "run a command", parameters: { type: "object" } },
      },
    ];
    const out = toAnthropicTools(tools) as any[];
    assert.deepEqual(out[0], {
      name: "bash",
      description: "run a command",
      input_schema: { type: "object" },
    });
  });

  it("returns undefined for an empty tool list", () => {
    assert.equal(toAnthropicTools([]), undefined);
    assert.equal(toAnthropicTools(undefined), undefined);
  });
});

describe("mapAnthropicStop", () => {
  it("maps stop reasons to the normalized finish_reason", () => {
    assert.equal(mapAnthropicStop("tool_use"), "tool_calls");
    assert.equal(mapAnthropicStop("end_turn"), "stop");
    assert.equal(mapAnthropicStop("stop_sequence"), "stop");
    assert.equal(mapAnthropicStop("max_tokens"), "length");
    assert.equal(mapAnthropicStop(undefined), undefined);
  });
});

describe("anthropicUsage", () => {
  it("maps cached reads to hit and fresh+write input to miss", () => {
    const u = anthropicUsage({
      input_tokens: 100,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 25,
    })!;
    assert.equal(u.prompt_cache_hit_tokens, 40);
    assert.equal(u.prompt_cache_miss_tokens, 110); // 100 fresh + 10 cache-write
    assert.equal(u.prompt_tokens, 150); // 100 + 40 + 10
    assert.equal(u.completion_tokens, 25);
    assert.equal(u.total_tokens, 175);
  });

  it("returns undefined when usage is absent", () => {
    assert.equal(anthropicUsage(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// End-to-end via a stubbed global fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let lastRequest: { url: string; init: RequestInit } | null = null;

function stubFetch(makeResponse: () => Response) {
  globalThis.fetch = (async (url: any, init: any) => {
    lastRequest = { url: String(url), init };
    return makeResponse();
  }) as typeof fetch;
}

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const MSGS: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
];

describe("anthropic chat() end-to-end", () => {
  before(() => (lastRequest = null));
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("translates a non-stream response into a normalized ChatResponse", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "the answer" },
              { type: "tool_use", id: "tu1", name: "bash", input: { command: "ls" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 2 },
          }),
          { status: 200 },
        ),
    );
    const resp = await chat({ model: "claude-sonnet-4-6", messages: MSGS });
    const msg = resp.choices[0].message;
    assert.equal(msg.content, "the answer");
    assert.equal(resp.choices[0].finish_reason, "tool_calls");
    assert.equal(msg.tool_calls?.length, 1);
    assert.equal(msg.tool_calls![0].function.name, "bash");
    assert.equal(msg.tool_calls![0].function.arguments, '{"command":"ls"}');
    assert.equal(resp.usage?.prompt_cache_hit_tokens, 2);
    assert.equal(resp.usage?.completion_tokens, 5);

    // The request hit the Anthropic endpoint with its auth headers + system.
    assert.match(lastRequest!.url, /api\.anthropic\.com/);
    const headers = lastRequest!.init.headers as Record<string, string>;
    assert.equal(headers["x-api-key"], "sk-ant-test");
    assert.ok(headers["anthropic-version"]);
    const sentBody = JSON.parse(lastRequest!.init.body as string);
    assert.equal(sentBody.system, "sys");
    assert.equal(sentBody.model, "claude-sonnet-4-6");
    assert.ok(sentBody.max_tokens > 0);
  });
});

describe("anthropic chatStream() end-to-end", () => {
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("assembles text, tool calls, and usage from the SSE event stream", async () => {
    stubFetch(() =>
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 30, cache_read_input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu9", name: "grep" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pat' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'tern":"x"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ]),
    );

    const chunks: string[] = [];
    const resp = await chatStream({
      model: "claude-sonnet-4-6",
      messages: MSGS,
      onContent: (t) => chunks.push(t),
    });

    assert.deepEqual(chunks, ["Hel", "lo"]);
    const msg = resp.choices[0].message;
    assert.equal(msg.content, "Hello");
    assert.equal(resp.choices[0].finish_reason, "tool_calls");
    assert.equal(msg.tool_calls?.length, 1);
    assert.equal(msg.tool_calls![0].id, "tu9");
    assert.equal(msg.tool_calls![0].function.name, "grep");
    assert.equal(msg.tool_calls![0].function.arguments, '{"pattern":"x"}');
    assert.equal(resp.usage?.prompt_cache_hit_tokens, 10);
    assert.equal(resp.usage?.prompt_tokens, 40); // 30 fresh + 10 cached
    assert.equal(resp.usage?.completion_tokens, 7);
  });
});
