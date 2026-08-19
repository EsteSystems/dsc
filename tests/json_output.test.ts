import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOneShotEnvelope } from "../src/json_output.js";
import { newStats } from "../src/api.js";

describe("buildOneShotEnvelope", () => {
  it("builds a minimal ok envelope", () => {
    const env = buildOneShotEnvelope({ ok: true, result: "done" });
    assert.deepEqual(env, { ok: true, result: "done" });
  });

  it("includes errors and tool calls with parsed args", () => {
    const stats = newStats();
    stats.prompt_tokens = 100;
    stats.completion_tokens = 20;
    stats.total_tokens = 120;
    stats.cache_hit_tokens = 80;
    stats.cache_miss_tokens = 20;

    const env = buildOneShotEnvelope({
      ok: false,
      error: "boom",
      result: "partial",
      toolCalls: [
        {
          id: "c1",
          name: "read_file",
          args: '{"path":"a.txt"}',
          content: "line",
          rejected: false,
        },
      ],
      stats,
      model: "deepseek-v4-pro",
      durationMs: 12,
      sessionId: "s1",
    });

    assert.equal(env.ok, false);
    assert.equal(env.error, "boom");
    assert.equal(env.result, "partial");
    assert.equal(env.session_id, "s1");
    assert.equal(env.model, "deepseek-v4-pro");
    assert.equal(env.duration_ms, 12);
    assert.equal(env.usage?.prompt_tokens, 100);
    assert.equal(env.usage?.completion_tokens, 20);
    assert.equal(env.usage?.total_tokens, 120);
    assert.equal(env.usage?.cache_hit_tokens, 80);
    assert.equal(env.usage?.cache_miss_tokens, 20);
    assert.equal(typeof env.cost_usd, "number");
    assert.equal(env.tool_calls?.length, 1);
    assert.deepEqual(env.tool_calls?.[0].args, { path: "a.txt" });
  });

  it("classifies a common edit mismatch with fix and next_actions", () => {
    const env = buildOneShotEnvelope({
      ok: false,
      error: "error: old_string not found in /tmp/foo.ts",
    });
    assert.equal(env.ok, false);
    assert.match(env.fix ?? "", /Re-read the target file/);
    assert.deepEqual(env.next_actions, [
      "read_file the target path",
      "retry edit_file with corrected old_string",
    ]);
  });

  it("lets explicit fix and next_actions override classification", () => {
    const env = buildOneShotEnvelope({
      ok: false,
      error: "old_string not found",
      fix: "custom fix",
      nextActions: ["step 1"],
    });
    assert.equal(env.fix, "custom fix");
    assert.deepEqual(env.next_actions, ["step 1"]);
  });

  it("keeps unparseable tool args as the raw string", () => {
    const env = buildOneShotEnvelope({
      ok: true,
      toolCalls: [{ id: "c1", name: "bash", args: "not json", content: "", rejected: false }],
    });
    assert.equal(env.tool_calls?.[0].args, "not json");
  });

  it("omits optional sections when absent", () => {
    const env = buildOneShotEnvelope({ ok: true });
    assert.equal(env.tool_calls, undefined);
    assert.equal(env.usage, undefined);
    assert.equal(env.cost_usd, undefined);
    assert.equal(env.duration_ms, undefined);
    assert.equal(env.session_id, undefined);
    assert.equal(env.model, undefined);
  });
});
