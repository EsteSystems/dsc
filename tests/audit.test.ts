import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  auditLogPath,
  record,
  verifyAuditLog,
  _resetAuditForTests,
} from "../src/audit.js";

const OLD_STATE = process.env.XDG_STATE_HOME;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-audit-test-"));

before(() => {
  process.env.XDG_STATE_HOME = path.join(TMP, "state");
});

after(() => {
  _resetAuditForTests();
  if (OLD_STATE === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = OLD_STATE;
  fs.rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  _resetAuditForTests();
  try {
    fs.rmSync(auditLogPath(), { force: true });
  } catch {
    // ignore
  }
});

describe("audit hash chain", () => {
  it("records entries and verifies cleanly", async () => {
    await record({ tool: "bash", approved: true });
    await record({ tool: "write_file", approved: true });
    const r = await verifyAuditLog();
    assert.equal(r.ok, true);
    assert.match(r.message, /2 records/);
  });

  it("detects a sequence gap", async () => {
    await record({ tool: "bash" });
    const file = auditLogPath();
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.ok(lines.length === 1);
    const tampered = lines[0].replace('"seq":1', '"seq":9');
    fs.writeFileSync(file, tampered + "\n", "utf8");
    const r = await verifyAuditLog();
    assert.equal(r.ok, false);
    assert.match(r.message, /sequence gap/);
  });

  it("detects a modified payload", async () => {
    await record({ tool: "bash" });
    const file = auditLogPath();
    let line = fs.readFileSync(file, "utf8").trim();
    line = line.replace('"tool":"bash"', '"tool":"edit_file"');
    fs.writeFileSync(file, line + "\n", "utf8");
    const r = await verifyAuditLog();
    assert.equal(r.ok, false);
    assert.match(r.message, /hash mismatch/);
  });
});
