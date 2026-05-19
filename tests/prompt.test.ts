import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/prompt.js";

const FIXED_DATE = new Date("2026-05-19T12:34:56Z");

describe("buildSystemPrompt", () => {
  it("starts with the static SYSTEM_PROMPT (cache prefix)", () => {
    const p = buildSystemPrompt({ cwd: "/home/x", date: FIXED_DATE });
    assert.ok(
      p.startsWith("You are dsc"),
      "prompt should open with the stable system text",
    );
  });

  it("includes cwd and ISO-date (YYYY-MM-DD only, not full timestamp)", () => {
    const p = buildSystemPrompt({ cwd: "/home/work/foo", date: FIXED_DATE });
    assert.ok(p.includes("- cwd: /home/work/foo"));
    assert.ok(p.includes("- date: 2026-05-19"));
    // We deliberately strip the time so the cache prefix stays stable
    // within a day — make sure no `T12:34:56` slipped in.
    assert.ok(!p.includes("T12:34:56"));
  });

  it("renders identical bytes for identical inputs (cache-stable)", () => {
    const ctx = { cwd: "/a", date: FIXED_DATE };
    assert.equal(buildSystemPrompt(ctx), buildSystemPrompt(ctx));
  });

  it("includes the /compact summary when provided", () => {
    const p = buildSystemPrompt({
      cwd: "/a",
      date: FIXED_DATE,
      summary: "earlier we discussed X and Y",
    });
    assert.ok(
      p.includes("Previously in this session"),
      "summary should be in its own labeled section",
    );
    assert.ok(p.includes("earlier we discussed X and Y"));
  });

  it("includes the language directive when provided", () => {
    const p = buildSystemPrompt({
      cwd: "/a",
      date: FIXED_DATE,
      language: "Romanian",
    });
    assert.ok(/respond exclusively in Romanian/i.test(p));
  });

  it("renders each instruction overlay as its own labeled section", () => {
    const p = buildSystemPrompt({
      cwd: "/a",
      date: FIXED_DATE,
      instructions: [
        { path: "/global", kind: "user", content: "use 2-space indents" },
        { path: "/proj/AGENTS.md", kind: "agents", content: "favor ripgrep" },
        { path: "/proj/.dsc/instructions.md", kind: "dsc", content: "extra: dsc-only" },
      ],
    });
    assert.ok(p.includes("User instructions from /global"));
    assert.ok(p.includes("use 2-space indents"));
    assert.ok(p.includes("Project instructions (AGENTS.md) from /proj/AGENTS.md"));
    assert.ok(p.includes("favor ripgrep"));
    assert.ok(p.includes("Project instructions (.dsc/instructions.md)"));
    assert.ok(p.includes("extra: dsc-only"));
    // Order is preserved: user → agents → dsc.
    const idxUser = p.indexOf("User instructions");
    const idxAgents = p.indexOf("Project instructions (AGENTS");
    const idxDsc = p.indexOf("Project instructions (.dsc");
    assert.ok(idxUser < idxAgents);
    assert.ok(idxAgents < idxDsc);
  });

  it("does not embed time-varying status info (cache-prefix hygiene)", () => {
    const p = buildSystemPrompt({ cwd: "/a", date: FIXED_DATE });
    // Old shape used to inject "- status: <model … timer …>". That
    // string-shaped marker should not appear anywhere — we moved
    // status to the user-facing status bar precisely so the prefix
    // cache could extend through the whole message history.
    assert.ok(!p.includes("- status:"));
  });
});
