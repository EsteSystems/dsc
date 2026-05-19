import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearPreferences,
  preferencesPath,
  readPreferences,
  savePreferences,
} from "../src/preferences.js";

describe("preferences", () => {
  let tmpdir: string;
  let prevXdg: string | undefined;

  before(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    tmpdir = mkdtempSync(path.join(os.tmpdir(), "dsc-prefs-test-"));
    process.env.XDG_CONFIG_HOME = tmpdir;
  });

  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(tmpdir, { recursive: true, force: true });
  });

  it("preferencesPath honors XDG_CONFIG_HOME", () => {
    const p = preferencesPath();
    assert.equal(p, path.join(tmpdir, "dsc", "preferences.json"));
  });

  it("readPreferences returns {} when no file exists", async () => {
    await clearPreferences();
    assert.deepEqual(await readPreferences(), {});
  });

  it("savePreferences creates the file and round-trips", async () => {
    await clearPreferences();
    await savePreferences({ yolo: true, reasoning: false, autoContinue: 3 });
    const got = await readPreferences();
    assert.equal(got.yolo, true);
    assert.equal(got.reasoning, false);
    assert.equal(got.autoContinue, 3);
  });

  it("savePreferences merges with the existing file", async () => {
    await clearPreferences();
    await savePreferences({ yolo: true });
    await savePreferences({ reasoning: false });
    const got = await readPreferences();
    assert.equal(got.yolo, true);
    assert.equal(got.reasoning, false);
  });

  it("savePreferences with null deletes a key", async () => {
    await clearPreferences();
    await savePreferences({ yolo: true, autoContinue: 5 });
    await savePreferences({ autoContinue: null });
    const got = await readPreferences();
    assert.equal(got.yolo, true);
    assert.equal(got.autoContinue, undefined);
  });

  it("rejects malformed values silently (type-safe deserialization)", async () => {
    const file = preferencesPath();
    writeFileSync(file, JSON.stringify({ yolo: "yes", autoContinue: "lots" }));
    const got = await readPreferences();
    // Wrong-typed fields are dropped, not coerced.
    assert.equal(got.yolo, undefined);
    assert.equal(got.autoContinue, undefined);
  });

  it("returns {} on a corrupt file rather than throwing", async () => {
    writeFileSync(preferencesPath(), "this is not json {");
    assert.deepEqual(await readPreferences(), {});
  });

  it("clearPreferences removes the file", async () => {
    await savePreferences({ yolo: true });
    await clearPreferences();
    assert.deepEqual(await readPreferences(), {});
  });

  it("rejects negative or zero budget values", async () => {
    writeFileSync(preferencesPath(), JSON.stringify({ budgetUsd: -1 }));
    assert.equal((await readPreferences()).budgetUsd, undefined);
    writeFileSync(preferencesPath(), JSON.stringify({ budgetUsd: 0 }));
    assert.equal((await readPreferences()).budgetUsd, undefined);
    writeFileSync(preferencesPath(), JSON.stringify({ budgetUsd: 0.5 }));
    assert.equal((await readPreferences()).budgetUsd, 0.5);
  });
});
