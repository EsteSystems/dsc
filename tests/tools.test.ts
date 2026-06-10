import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

// Keep the audit logger from touching ~/.local/state during tests. audit.record
// reads this lazily on every call, so setting it before any executeTool runs is
// enough (test bodies run after this module-init statement).
process.env.DSC_NO_AUDIT = "1";

import {
  executeTool,
  READ_ONLY_TOOLS,
  TOOL_SCHEMAS,
  type ToolContext,
} from "../src/tools.js";
import { setAsker, type ApprovalAnswer } from "../src/approval.js";
import { getState, setState } from "../src/store.js";

const WIN = process.platform === "win32";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-tools-test-"));
let counter = 0;
/** Fresh unique path under TMP so tests don't collide. */
function tmpFile(name: string): string {
  return path.join(TMP, `${counter++}-${name}`);
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: TMP,
    yolo: true,
    filesTouched: new Set(),
    sessionId: "test",
    ...over,
  };
}

const j = (o: unknown) => JSON.stringify(o);

// Make the approval asker deterministic across the suite; individual tests
// override it. Always reset to null afterward so a stray asker can't leak.
afterEach(() => setAsker(null));

// ---------------------------------------------------------------------------
// executeTool dispatch + arg parsing
// ---------------------------------------------------------------------------

describe("executeTool dispatch", () => {
  it("rejects malformed argument JSON", async () => {
    const r = await executeTool("read_file", "{not json", ctx());
    assert.match(r.content, /invalid arguments JSON/);
  });

  it("treats empty args string as {}", async () => {
    // read_file with {} → missing 'path' (proves the JSON parse didn't throw).
    const r = await executeTool("read_file", "", ctx());
    assert.match(r.content, /missing 'path'/);
  });

  it("reports an unknown tool name", async () => {
    const r = await executeTool("frobnicate", "{}", ctx());
    assert.match(r.content, /unknown tool 'frobnicate'/);
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("returns content with 1-based line numbers", async () => {
    const f = tmpFile("read.txt");
    fs.writeFileSync(f, "alpha\nbeta\ngamma\n");
    const r = await executeTool("read_file", j({ path: f }), ctx());
    assert.match(r.content, /1\talpha/);
    assert.match(r.content, /2\tbeta/);
    assert.match(r.content, /3\tgamma/);
  });

  it("errors on a missing path argument", async () => {
    const r = await executeTool("read_file", j({}), ctx());
    assert.match(r.content, /missing 'path'/);
  });

  it("errors when the file does not exist", async () => {
    const r = await executeTool("read_file", j({ path: tmpFile("nope.txt") }), ctx());
    assert.match(r.content, /file does not exist/);
  });

  it("points at glob when handed a directory", async () => {
    const r = await executeTool("read_file", j({ path: TMP }), ctx());
    assert.match(r.content, /is a directory/);
    assert.match(r.content, /glob/);
  });

  it("pages with offset/limit and notes there is more", async () => {
    const f = tmpFile("paged.txt");
    fs.writeFileSync(f, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const r = await executeTool("read_file", j({ path: f, offset: 2, limit: 3 }), ctx());
    assert.match(r.content, /2\tline2/);
    assert.match(r.content, /4\tline4/);
    assert.doesNotMatch(r.content, /5\tline5/);
    assert.match(r.content, /showing lines 2–4 of 10/);
  });

  it("truncates pathologically long lines", async () => {
    const f = tmpFile("long.txt");
    fs.writeFileSync(f, "x".repeat(2500));
    const r = await executeTool("read_file", j({ path: f }), ctx());
    assert.match(r.content, /truncated long line/);
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("write_file", () => {
  it("creates a new file under yolo and records it as touched", async () => {
    const f = tmpFile("new.txt");
    const c = ctx();
    const r = await executeTool("write_file", j({ path: f, content: "hello" }), c);
    assert.match(r.content, /ok: created/);
    assert.equal(fs.readFileSync(f, "utf8"), "hello");
    assert.ok(c.filesTouched.has(f));
  });

  it("overwrites an existing file", async () => {
    const f = tmpFile("over.txt");
    fs.writeFileSync(f, "old");
    const r = await executeTool("write_file", j({ path: f, content: "new" }), ctx());
    assert.match(r.content, /ok: overwrote/);
    assert.equal(fs.readFileSync(f, "utf8"), "new");
  });

  it("errors on a missing path", async () => {
    const r = await executeTool("write_file", j({ content: "x" }), ctx());
    assert.match(r.content, /missing 'path'/);
  });

  it("does not write when the user rejects", async () => {
    const f = tmpFile("rejected.txt");
    setAsker(async () => "no");
    const r = await executeTool(
      "write_file",
      j({ path: f, content: "nope" }),
      ctx({ yolo: false }),
    );
    assert.equal(r.rejected, true);
    assert.match(r.content, /rejected by user/);
    assert.equal(fs.existsSync(f), false);
  });
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

describe("edit_file", () => {
  it("replaces a unique substring", async () => {
    const f = tmpFile("edit.txt");
    fs.writeFileSync(f, "the quick brown fox");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "quick", new_string: "slow" }),
      ctx(),
    );
    assert.match(r.content, /ok: edited .* \(1 replacement\)/);
    assert.equal(fs.readFileSync(f, "utf8"), "the slow brown fox");
  });

  it("errors when old_string is not found", async () => {
    const f = tmpFile("edit2.txt");
    fs.writeFileSync(f, "abc");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "xyz", new_string: "q" }),
      ctx(),
    );
    assert.match(r.content, /old_string not found/);
  });

  it("refuses a non-unique old_string without replace_all", async () => {
    const f = tmpFile("edit3.txt");
    fs.writeFileSync(f, "a a a");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "a", new_string: "b" }),
      ctx(),
    );
    assert.match(r.content, /not unique/);
    assert.match(r.content, /matches 3 times/);
    assert.equal(fs.readFileSync(f, "utf8"), "a a a", "file must be untouched");
  });

  it("replaces all occurrences with replace_all=true", async () => {
    const f = tmpFile("edit4.txt");
    fs.writeFileSync(f, "a a a");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "a", new_string: "b", replace_all: true }),
      ctx(),
    );
    assert.match(r.content, /\(3 replacements\)/);
    assert.equal(fs.readFileSync(f, "utf8"), "b b b");
  });

  it("rejects an empty old_string", async () => {
    const f = tmpFile("edit5.txt");
    fs.writeFileSync(f, "x");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "", new_string: "y" }),
      ctx(),
    );
    assert.match(r.content, /must not be empty/);
  });

  it("errors on a missing file", async () => {
    const r = await executeTool(
      "edit_file",
      j({ path: tmpFile("absent.txt"), old_string: "a", new_string: "b" }),
      ctx(),
    );
    assert.match(r.content, /file does not exist/);
  });

  it("leaves the file unchanged when the user rejects", async () => {
    const f = tmpFile("edit-reject.txt");
    fs.writeFileSync(f, "keep me");
    setAsker(async () => "no");
    const r = await executeTool(
      "edit_file",
      j({ path: f, old_string: "keep", new_string: "drop" }),
      ctx({ yolo: false }),
    );
    assert.equal(r.rejected, true);
    assert.equal(fs.readFileSync(f, "utf8"), "keep me");
  });
});

// ---------------------------------------------------------------------------
// multi_edit
// ---------------------------------------------------------------------------

describe("multi_edit", () => {
  it("applies a sequence of edits atomically", async () => {
    const f = tmpFile("multi.txt");
    fs.writeFileSync(f, "alpha beta gamma");
    const r = await executeTool(
      "multi_edit",
      j({
        path: f,
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ],
      }),
      ctx(),
    );
    assert.match(r.content, /ok: applied 2 edits/);
    assert.equal(fs.readFileSync(f, "utf8"), "ALPHA beta GAMMA");
  });

  it("applies edits in order, each seeing the previous result", async () => {
    const f = tmpFile("multi-seq.txt");
    fs.writeFileSync(f, "one");
    const r = await executeTool(
      "multi_edit",
      j({
        path: f,
        edits: [
          { old_string: "one", new_string: "two" },
          { old_string: "two", new_string: "three" }, // matches edit #1's output
        ],
      }),
      ctx(),
    );
    assert.match(r.content, /ok: applied 2 edits/);
    assert.equal(fs.readFileSync(f, "utf8"), "three");
  });

  it("supports replace_all within an edit", async () => {
    const f = tmpFile("multi-all.txt");
    fs.writeFileSync(f, "x x x | y");
    const r = await executeTool(
      "multi_edit",
      j({
        path: f,
        edits: [
          { old_string: "x", new_string: "z", replace_all: true },
          { old_string: "y", new_string: "w" },
        ],
      }),
      ctx(),
    );
    assert.match(r.content, /ok: applied 2 edits/);
    assert.equal(fs.readFileSync(f, "utf8"), "z z z | w");
  });

  it("is atomic: a later failed edit leaves the file untouched", async () => {
    const f = tmpFile("multi-atomic.txt");
    fs.writeFileSync(f, "foo bar");
    const r = await executeTool(
      "multi_edit",
      j({
        path: f,
        edits: [
          { old_string: "foo", new_string: "X" },
          { old_string: "zzz", new_string: "Y" }, // not found → whole op fails
        ],
      }),
      ctx(),
    );
    assert.match(r.content, /edit #2: old_string not found/);
    assert.equal(fs.readFileSync(f, "utf8"), "foo bar", "file must be unchanged");
  });

  it("errors when an edit's old_string is not unique without replace_all", async () => {
    const f = tmpFile("multi-uniq.txt");
    fs.writeFileSync(f, "a a a");
    const r = await executeTool(
      "multi_edit",
      j({ path: f, edits: [{ old_string: "a", new_string: "b" }] }),
      ctx(),
    );
    assert.match(r.content, /edit #1: old_string is not unique/);
    assert.equal(fs.readFileSync(f, "utf8"), "a a a");
  });

  it("rejects an empty edits array and an empty old_string", async () => {
    const f = tmpFile("multi-empty.txt");
    fs.writeFileSync(f, "z");
    const r1 = await executeTool("multi_edit", j({ path: f, edits: [] }), ctx());
    assert.match(r1.content, /edits must not be empty/);
    const r2 = await executeTool(
      "multi_edit",
      j({ path: f, edits: [{ old_string: "", new_string: "q" }] }),
      ctx(),
    );
    assert.match(r2.content, /old_string must not be empty/);
  });

  it("errors on a missing file and a missing path", async () => {
    const r1 = await executeTool(
      "multi_edit",
      j({ path: tmpFile("absent.txt"), edits: [{ old_string: "a", new_string: "b" }] }),
      ctx(),
    );
    assert.match(r1.content, /file does not exist/);
    const r2 = await executeTool("multi_edit", j({ edits: [{ old_string: "a", new_string: "b" }] }), ctx());
    assert.match(r2.content, /missing 'path'/);
  });

  it("does not write when the user rejects", async () => {
    const f = tmpFile("multi-reject.txt");
    fs.writeFileSync(f, "keep me");
    setAsker(async () => "no");
    const r = await executeTool(
      "multi_edit",
      j({ path: f, edits: [{ old_string: "keep", new_string: "drop" }] }),
      ctx({ yolo: false }),
    );
    assert.equal(r.rejected, true);
    assert.equal(fs.readFileSync(f, "utf8"), "keep me");
  });
});

// ---------------------------------------------------------------------------
// Approval gating semantics (shared across write/edit/bash/web_fetch)
// ---------------------------------------------------------------------------

describe("approval gating", () => {
  it("yolo bypasses the asker entirely", async () => {
    let asked = 0;
    setAsker(async () => {
      asked++;
      return "no";
    });
    const f = tmpFile("yolo.txt");
    const r = await executeTool("write_file", j({ path: f, content: "x" }), ctx({ yolo: true }));
    assert.match(r.content, /ok: created/);
    assert.equal(asked, 0, "asker must not be consulted under yolo");
  });

  it("'always' adds the tool to sessionApprovals so the next call skips the prompt", async () => {
    let asked = 0;
    const answer: ApprovalAnswer = "always";
    setAsker(async () => {
      asked++;
      return answer;
    });
    const c = ctx({ yolo: false });
    const r1 = await executeTool("write_file", j({ path: tmpFile("a.txt"), content: "1" }), c);
    assert.match(r1.content, /ok: created/);
    assert.equal(asked, 1);
    assert.ok(c.sessionApprovals?.has("write_file"));

    // Second write with the same ctx should not prompt again.
    const r2 = await executeTool("write_file", j({ path: tmpFile("b.txt"), content: "2" }), c);
    assert.match(r2.content, /ok: created/);
    assert.equal(asked, 1, "asker should not be consulted a second time");
  });
});

// ---------------------------------------------------------------------------
// bash  (echo works on /bin/sh and cmd.exe alike)
// ---------------------------------------------------------------------------

describe("bash", () => {
  it("runs a command and captures stdout + exit code", async () => {
    const r = await executeTool("bash", j({ command: "echo hello" }), ctx());
    assert.match(r.content, /exit_code: 0/);
    assert.match(r.content, /hello/);
  });

  it("errors on a missing command", async () => {
    const r = await executeTool("bash", j({}), ctx());
    assert.match(r.content, /missing 'command'/);
  });

  it("does not run when the user rejects", async () => {
    setAsker(async () => "no");
    const r = await executeTool(
      "bash",
      j({ command: "echo should-not-run" }),
      ctx({ yolo: false }),
    );
    assert.equal(r.rejected, true);
    assert.match(r.content, /rejected by user/);
  });

  it("reports a non-zero exit code", async () => {
    const r = await executeTool("bash", j({ command: "exit 3" }), ctx());
    assert.match(r.content, /exit_code: 3/);
  });
});

// ---------------------------------------------------------------------------
// grep  (skip the spawning tests on Windows, which may lack grep/rg)
// ---------------------------------------------------------------------------

describe("grep", () => {
  it("errors on a missing pattern", async () => {
    const r = await executeTool("grep", j({}), ctx());
    assert.match(r.content, /missing 'pattern'/);
  });

  it("finds matching lines", { skip: WIN }, async () => {
    const dir = path.join(TMP, `grep-${counter++}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "hay.txt"), "no match here\nfind the needle\nnope\n");
    const r = await executeTool("grep", j({ pattern: "needle", path: dir }), ctx());
    assert.match(r.content, /needle/);
  });

  it("reports no matches cleanly", { skip: WIN }, async () => {
    const dir = path.join(TMP, `grep-${counter++}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "hay.txt"), "just some text\n");
    const r = await executeTool("grep", j({ pattern: "zzz-not-present", path: dir }), ctx());
    assert.match(r.content, /no matches/);
  });
});

// ---------------------------------------------------------------------------
// glob  (fs.glob, Node 22+, cross-platform)
// ---------------------------------------------------------------------------

describe("glob", () => {
  it("errors on a missing pattern", async () => {
    const r = await executeTool("glob", j({}), ctx());
    assert.match(r.content, /missing 'pattern'/);
  });

  it("lists files matching the pattern", async () => {
    const dir = path.join(TMP, `glob-${counter++}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "one.md"), "");
    fs.writeFileSync(path.join(dir, "two.md"), "");
    fs.writeFileSync(path.join(dir, "skip.txt"), "");
    const r = await executeTool("glob", j({ pattern: "*.md", path: dir }), ctx());
    assert.match(r.content, /one\.md/);
    assert.match(r.content, /two\.md/);
    assert.doesNotMatch(r.content, /skip\.txt/);
  });

  it("reports no matches cleanly", async () => {
    const dir = path.join(TMP, `glob-${counter++}`);
    fs.mkdirSync(dir);
    const r = await executeTool("glob", j({ pattern: "*.nothing", path: dir }), ctx());
    assert.match(r.content, /no matches/);
  });
});

// ---------------------------------------------------------------------------
// web_fetch / web_search — validation paths only (no network)
// ---------------------------------------------------------------------------

describe("web_fetch validation", () => {
  it("errors on a missing url", async () => {
    const r = await executeTool("web_fetch", j({}), ctx());
    assert.match(r.content, /missing 'url'/);
  });

  it("rejects a non-http(s) scheme before any network or prompt", async () => {
    const r = await executeTool("web_fetch", j({ url: "ftp://example.com" }), ctx({ yolo: false }));
    assert.match(r.content, /must start with http/);
  });
});

describe("web_search validation", () => {
  it("errors on a missing query", async () => {
    const r = await executeTool("web_search", j({}), ctx());
    assert.match(r.content, /missing 'query'/);
  });
});

// ---------------------------------------------------------------------------
// task_create / task_update / task_list — mutate the global store
// ---------------------------------------------------------------------------

describe("task tools", () => {
  beforeEach(() => setState({ agentTasks: [] }));

  it("creates a task that lands in the store as pending", async () => {
    const r = await executeTool("task_create", j({ subject: "write tests" }), ctx());
    assert.match(r.content, /ok: created task/);
    const tasks = getState().agentTasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].subject, "write tests");
    assert.equal(tasks[0].status, "pending");
  });

  it("requires a subject", async () => {
    const r = await executeTool("task_create", j({ subject: "  " }), ctx());
    assert.match(r.content, /subject is required/);
    assert.equal(getState().agentTasks.length, 0);
  });

  it("updates a task's status", async () => {
    const created = await executeTool("task_create", j({ subject: "do it" }), ctx());
    const id = /task (\d+)/.exec(created.content)![1];
    const r = await executeTool("task_update", j({ id, status: "completed" }), ctx());
    assert.match(r.content, /→ completed/);
    assert.equal(getState().agentTasks[0].status, "completed");
  });

  it("rejects an invalid status", async () => {
    const created = await executeTool("task_create", j({ subject: "x" }), ctx());
    const id = /task (\d+)/.exec(created.content)![1];
    const r = await executeTool("task_update", j({ id, status: "bogus" }), ctx());
    assert.match(r.content, /invalid status/);
  });

  it("errors updating an unknown id", async () => {
    const r = await executeTool("task_update", j({ id: "999999", status: "completed" }), ctx());
    assert.match(r.content, /no task with id/);
  });

  it("lists tasks, and reports emptiness", async () => {
    const empty = await executeTool("task_list", j({}), ctx());
    assert.match(empty.content, /no tasks/);
    await executeTool("task_create", j({ subject: "first" }), ctx());
    const r = await executeTool("task_list", j({}), ctx());
    assert.match(r.content, /\[pending\] first/);
  });
});

// ---------------------------------------------------------------------------
// Static surface: schema + read-only classification
// ---------------------------------------------------------------------------

describe("tool surface", () => {
  it("READ_ONLY_TOOLS contains the no-approval tools and not the gated ones", () => {
    for (const t of ["read_file", "grep", "glob", "web_search", "task_create", "task_list"]) {
      assert.ok(READ_ONLY_TOOLS.has(t), `${t} should be read-only`);
    }
    for (const t of ["write_file", "edit_file", "multi_edit", "bash", "web_fetch"]) {
      assert.ok(!READ_ONLY_TOOLS.has(t), `${t} should require approval`);
    }
  });

  it("every schema entry is a well-formed function tool", () => {
    assert.ok(TOOL_SCHEMAS.length > 0);
    for (const s of TOOL_SCHEMAS) {
      assert.equal(s.type, "function");
      assert.equal(typeof s.function.name, "string");
      assert.ok(s.function.name.length > 0);
      assert.equal(typeof s.function.description, "string");
      assert.equal(typeof s.function.parameters, "object");
    }
  });

  it("advertises the documented built-in tools", () => {
    const names = new Set(TOOL_SCHEMAS.map((s) => s.function.name));
    for (const t of [
      "read_file", "write_file", "edit_file", "multi_edit", "bash", "grep", "glob",
      "web_fetch", "web_search", "task_create", "task_update", "task_list",
    ]) {
      assert.ok(names.has(t), `schema should advertise ${t}`);
    }
  });
});

before(() => {
  // Touch TMP so a failure to create it surfaces early with a clear message.
  assert.ok(fs.existsSync(TMP), `temp dir ${TMP} should exist`);
});
