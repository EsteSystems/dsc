import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyError } from "../src/error_classification.js";

describe("classifyError", () => {
  it("classifies missing API keys", () => {
    const c = classifyError("DEEPSEEK_API_KEY is not set");
    assert.match(c.fix ?? "", /Configure an API key/);
  });

  it("classifies edit mismatches", () => {
    const c = classifyError("error: old_string not found in /tmp/x");
    assert.match(c.fix ?? "", /Re-read the target file/);
  });

  it("classifies context overflow", () => {
    const c = classifyError("prompt is too long for the maximum context window");
    assert.match(c.fix ?? "", /Compact the conversation/);
    assert.deepEqual(c.next_actions, [
      "/compact",
      "read_file with offset/limit",
      "retry with a narrower prompt",
    ]);
  });

  it("classifies missing dependencies", () => {
    const c = classifyError("sh: npm: command not found");
    assert.match(c.fix ?? "", /Install the missing dependency/);
  });

  it("classifies timeouts", () => {
    const c = classifyError("bash killed after timeout_ms=1000");
    assert.match(c.fix ?? "", /background=true/);
  });

  it("falls back to a generic hint", () => {
    const c = classifyError("something mysterious happened");
    assert.match(c.fix ?? "", /Inspect the error/);
    assert.equal(c.next_actions, undefined);
  });
});
