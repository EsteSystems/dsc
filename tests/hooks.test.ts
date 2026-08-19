import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _resetConfigCachesForTests } from "../src/api.js";
import { executeTool, type ToolContext } from "../src/tools.js";
import { setState } from "../src/store.js";

const OLD_XDG = process.env.XDG_CONFIG_HOME;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-hooks-test-"));
const CONFIG_DIR = path.join(TMP, "config", "dsc");

function writeConfig(hooks: unknown) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CONFIG_DIR, "config.json"),
    JSON.stringify({ hooks }),
    "utf8",
  );
}

function ctx(): ToolContext {
  return {
    cwd: TMP,
    yolo: true,
    filesTouched: new Set(),
    sessionId: "hooks-test",
  };
}

before(() => {
  process.env.XDG_CONFIG_HOME = path.join(TMP, "config");
  _resetConfigCachesForTests();
  setState({ agentTasks: [] });
});

after(() => {
  _resetConfigCachesForTests();
  if (OLD_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = OLD_XDG;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("tool lifecycle hooks", () => {
  it("pre_tool_use can block a tool", async () => {
    writeConfig({ pre_tool_use: { task_create: "exit 1" } });
    _resetConfigCachesForTests();
    const r = await executeTool("task_create", JSON.stringify({ subject: "x" }), ctx());
    assert.equal(r.rejected, true);
    assert.match(r.content, /blocked by pre_tool_use hook/);
  });

  it("post_tool_use output is appended as a note", async () => {
    writeConfig({ post_tool_use: { task_create: "echo hook-ran" } });
    _resetConfigCachesForTests();
    const r = await executeTool("task_create", JSON.stringify({ subject: "y" }), ctx());
    assert.match(r.content, /ok: created task/);
    assert.match(r.content, /\[hook\] hook-ran/);
  });

  it("unconfigured tools are unaffected", async () => {
    writeConfig({});
    _resetConfigCachesForTests();
    const r = await executeTool("task_create", JSON.stringify({ subject: "z" }), ctx());
    assert.match(r.content, /ok: created task/);
    assert.doesNotMatch(r.content, /\[hook\]/);
  });
});
