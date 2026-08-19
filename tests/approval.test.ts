import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isToolDenied,
  isToolPermanentlyApproved,
  savePermanentApproval,
} from "../src/approval.js";
import { _resetConfigCachesForTests } from "../src/api.js";
import { executeTool, type ToolContext } from "../src/tools.js";

const OLD_XDG = process.env.XDG_CONFIG_HOME;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-approval-test-"));

before(() => {
  process.env.XDG_CONFIG_HOME = TMP;
  _resetConfigCachesForTests();
  const dir = path.join(TMP, "dsc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      approvals: {
        deny_tools: ["bash"],
        approve_tools: ["web_fetch"],
      },
    }),
    "utf8",
  );
});

after(() => {
  _resetConfigCachesForTests();
  if (OLD_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = OLD_XDG;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("approval policy", () => {
  it("deny rules win", () => {
    assert.equal(isToolDenied("bash"), true);
    assert.equal(isToolDenied("web_fetch"), false);
  });

  it("permanent approvals are read from config", () => {
    assert.equal(isToolPermanentlyApproved("web_fetch"), true);
    assert.equal(isToolPermanentlyApproved("bash"), false);
  });

  it("savePermanentApproval merges into the existing config", async () => {
    await savePermanentApproval("edit_file");
    _resetConfigCachesForTests();
    assert.equal(isToolPermanentlyApproved("edit_file"), true);
    assert.equal(isToolPermanentlyApproved("web_fetch"), true);
    assert.equal(isToolDenied("bash"), true);
  });

  it("deny rules beat --yolo", async () => {
    const toolCtx: ToolContext = {
      cwd: TMP,
      yolo: true,
      filesTouched: new Set(),
      sessionId: "deny-test",
    };
    const r = await executeTool(
      "bash",
      JSON.stringify({ command: "echo should-not-run" }),
      toolCtx,
    );
    assert.equal(r.rejected, true);
    assert.match(r.content, /rejected by user/);
  });
});
