import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadInstructions } from "../src/instructions.js";

describe("loadInstructions", () => {
  let tmpdir: string;
  let prevXdg: string | undefined;

  before(() => {
    // Point XDG_CONFIG_HOME at a nonexistent path so the user-global
    // lookup (~/.config/dsc/instructions.md) never picks up the dev's
    // real config file and contaminates test assertions.
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(
      os.tmpdir(),
      `dsc-test-xdg-${process.pid}`,
    );
    tmpdir = mkdtempSync(path.join(os.tmpdir(), "dsc-instr-test-"));
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  it("returns no overlays when nothing exists", () => {
    const dir = path.join(tmpdir, "empty");
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(loadInstructions(dir), []);
  });

  it("finds AGENTS.md in the cwd", () => {
    const dir = path.join(tmpdir, "agents-here");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "agents content");
    const r = loadInstructions(dir);
    const a = r.find((f) => f.kind === "agents");
    assert.ok(a, "AGENTS.md should be picked up");
    assert.equal(a.content, "agents content");
    assert.equal(a.path, path.join(dir, "AGENTS.md"));
  });

  it("walks up to find AGENTS.md in a parent directory", () => {
    const parent = path.join(tmpdir, "walkup");
    const child = path.join(parent, "deeply", "nested");
    mkdirSync(child, { recursive: true });
    writeFileSync(path.join(parent, "AGENTS.md"), "parent content");
    const r = loadInstructions(child);
    const a = r.find((f) => f.kind === "agents");
    assert.ok(a);
    assert.equal(a.content, "parent content");
  });

  it("finds .dsc/instructions.md", () => {
    const dir = path.join(tmpdir, "dsc-overlay");
    mkdirSync(path.join(dir, ".dsc"), { recursive: true });
    writeFileSync(path.join(dir, ".dsc", "instructions.md"), "dsc-specific");
    const r = loadInstructions(dir);
    const d = r.find((f) => f.kind === "dsc");
    assert.ok(d);
    assert.equal(d.content, "dsc-specific");
  });

  it("orders results: user → agents → dsc", () => {
    const dir = path.join(tmpdir, "ordered");
    mkdirSync(path.join(dir, ".dsc"), { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "agents body");
    writeFileSync(path.join(dir, ".dsc", "instructions.md"), "dsc body");
    const r = loadInstructions(dir);
    // No user file in our isolated XDG; expect agents then dsc.
    assert.equal(r.length, 2);
    assert.equal(r[0].kind, "agents");
    assert.equal(r[1].kind, "dsc");
  });

  it("treats empty files as absent", () => {
    const dir = path.join(tmpdir, "empty-file");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "");
    assert.equal(
      loadInstructions(dir).find((f) => f.kind === "agents"),
      undefined,
    );
  });

  it("strips a leading UTF-8 BOM", () => {
    const dir = path.join(tmpdir, "bom");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "AGENTS.md"), "﻿real content");
    const r = loadInstructions(dir);
    const a = r.find((f) => f.kind === "agents");
    assert.ok(a);
    assert.equal(a.content, "real content");
  });
});
