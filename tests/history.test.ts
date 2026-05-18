import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  exportSession,
  importSession,
  listSessions,
  loadSession,
  mostRecentForCwd,
  newSession,
  saveSession,
} from "../src/history.js";

describe("history", () => {
  let tmpdir: string;
  let prevXdg: string | undefined;

  before(() => {
    // Override XDG_DATA_HOME so the test never touches the user's real
    // sessions dir. history.sessionsDir() reads this env on every call.
    prevXdg = process.env.XDG_DATA_HOME;
    tmpdir = mkdtempSync(path.join(os.tmpdir(), "dsc-history-test-"));
    process.env.XDG_DATA_HOME = tmpdir;
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  it("round-trips a session through save + load", async () => {
    const s = newSession("/some/cwd", "deepseek-v4-pro");
    s.messages.push({ role: "user", content: "hello" });
    s.messages.push({ role: "assistant", content: "hi back" });
    await saveSession(s);
    const loaded = await loadSession(s.id);
    assert.ok(loaded);
    assert.equal(loaded.id, s.id);
    assert.equal(loaded.cwd, "/some/cwd");
    assert.equal(loaded.model, "deepseek-v4-pro");
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].content, "hello");
    assert.equal(loaded.messages[1].content, "hi back");
  });

  it("listSessions filters by cwd; mostRecentForCwd returns the latest", async () => {
    const a = newSession("/cwd-a", "deepseek-v4-pro");
    a.messages.push({ role: "user", content: "from a" });
    await saveSession(a);

    // Ensure b's updated_at is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    const b = newSession("/cwd-a", "deepseek-v4-pro");
    b.messages.push({ role: "user", content: "from b (newer)" });
    await saveSession(b);

    const other = newSession("/cwd-b", "deepseek-v4-pro");
    other.messages.push({ role: "user", content: "elsewhere" });
    await saveSession(other);

    const inA = await listSessions("/cwd-a");
    const ids = inA.map((m) => m.id);
    assert.ok(ids.includes(a.id), "session a should be listed for /cwd-a");
    assert.ok(ids.includes(b.id), "session b should be listed for /cwd-a");
    assert.ok(!ids.includes(other.id), "other should not appear under /cwd-a");

    const top = await mostRecentForCwd("/cwd-a");
    assert.ok(top);
    assert.equal(top.id, b.id);
  });

  it("export → import round-trips content; rebindCwd takes effect", async () => {
    const s = newSession("/orig/cwd", "deepseek-v4-pro");
    s.messages.push({ role: "user", content: "exported turn" });
    s.name = "my-export";
    await saveSession(s);

    const dest = path.join(tmpdir, "exported.json");
    const written = await exportSession(s.id, dest);
    assert.equal(written, dest);

    const imported = await importSession(dest, { rebindCwd: "/new/cwd" });
    assert.equal(imported.cwd, "/new/cwd");
    assert.equal(imported.name, "my-export");
    assert.equal(imported.messages[0].content, "exported turn");

    // Collision protection: original session is still in the dir under
    // its old id, so import must mint a fresh id rather than overwrite.
    assert.notEqual(imported.id, s.id);

    // Both versions are now present.
    const orig = await loadSession(s.id);
    const copy = await loadSession(imported.id);
    assert.ok(orig);
    assert.ok(copy);
    assert.equal(orig.cwd, "/orig/cwd");
    assert.equal(copy.cwd, "/new/cwd");
  });

  it("loadSession returns null for a nonexistent id", async () => {
    const r = await loadSession("does-not-exist-1234");
    assert.equal(r, null);
  });
});
