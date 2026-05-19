import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { autoRequiresApproval, expandEnv } from "../src/mcp.js";

describe("autoRequiresApproval", () => {
  it("flags destructive verbs in the tool name", () => {
    for (const name of [
      "write_file",
      "delete-record",
      "create_folder",
      "send_message",
      "run_query",
      "exec_command",
      "publish_post",
      "remove_user",
      "update_config",
      "modify-thing",
    ]) {
      assert.equal(autoRequiresApproval(name, undefined), true, `expected '${name}' destructive`);
    }
  });

  it("lets clearly read-only verbs pass", () => {
    for (const name of [
      "search",
      "tavily-search",
      "list_files",
      "get_user",
      "read_doc",
      "view_content",
      "lookup_key",
      "describe_table",
    ]) {
      assert.equal(autoRequiresApproval(name, undefined), false, `expected '${name}' read-only`);
    }
  });

  it("falls back to the description when the name is neutral", () => {
    assert.equal(
      autoRequiresApproval("doit", "sends a message to the queue"),
      true,
    );
    assert.equal(
      autoRequiresApproval("doit", "fetches the current snapshot"),
      false,
    );
  });

  it("regex is word-boundary respecting (doesn't fire on substrings)", () => {
    // "rewrite" contains "write" but the \b in the regex requires a
    // word boundary — we don't want false positives on every-word-
    // happens-to-contain-write tool name.
    assert.equal(autoRequiresApproval("rewrite", undefined), false);
  });
});

describe("expandEnv", () => {
  let prev: string | undefined;
  before(() => {
    prev = process.env.MCP_TEST_VAR;
    process.env.MCP_TEST_VAR = "expanded-value";
  });
  after(() => {
    if (prev === undefined) delete process.env.MCP_TEST_VAR;
    else process.env.MCP_TEST_VAR = prev;
  });

  it("substitutes ${VAR} against process.env", () => {
    assert.equal(expandEnv("hi ${MCP_TEST_VAR} there", "test"), "hi expanded-value there");
  });

  it("returns input unchanged when no ${VAR} references", () => {
    assert.equal(expandEnv("plain", "test"), "plain");
  });

  it("throws on a missing env var (fail-fast, no silent auth bypass)", () => {
    assert.throws(
      () => expandEnv("${MCP_DEFINITELY_NOT_SET_xyz}", "test"),
      /MCP_DEFINITELY_NOT_SET_xyz/,
    );
  });

  it("expands multiple references in one string", () => {
    process.env.MCP_TEST_B = "two";
    try {
      assert.equal(
        expandEnv("${MCP_TEST_VAR}-${MCP_TEST_B}", "test"),
        "expanded-value-two",
      );
    } finally {
      delete process.env.MCP_TEST_B;
    }
  });
});
