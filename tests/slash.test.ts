import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, completeSlash } from "../src/slash.js";

describe("completeSlash", () => {
  it("returns no matches when input doesn't start with /", () => {
    assert.deepEqual(completeSlash("hello"), { matches: [], completion: "" });
    assert.deepEqual(completeSlash(""), { matches: [], completion: "" });
  });

  it("returns every command for bare /", () => {
    const r = completeSlash("/");
    assert.equal(r.matches.length, SLASH_COMMANDS.length);
    assert.ok(r.matches.every((m) => m.startsWith("/")));
  });

  it("returns a single match with trailing space for a unique prefix", () => {
    const r = completeSlash("/cle");
    assert.deepEqual(r.matches, ["/clear"]);
    // Single match gets a trailing space so the user can immediately type args.
    assert.equal(r.completion, "/clear ");
  });

  it("returns longest common prefix for multiple matches", () => {
    // /compact, /copy, /cost all start with /co.
    const r = completeSlash("/co");
    assert.ok(r.matches.includes("/compact"));
    assert.ok(r.matches.includes("/copy"));
    assert.ok(r.matches.includes("/cost"));
    // Shared prefix is exactly "/co" — beyond that the commands diverge.
    assert.equal(r.completion, "/co");
  });

  it("returns no matches for an unknown prefix", () => {
    const r = completeSlash("/xyz-nope");
    assert.deepEqual(r.matches, []);
    assert.equal(r.completion, "");
  });

  it("doesn't complete past the command word (subcommand args)", () => {
    // Once the user has typed a space, they're past the command name.
    // We don't try to complete /resume <name> or /audit show etc.
    const r = completeSlash("/clear something");
    assert.deepEqual(r, { matches: [], completion: "" });
  });
});

describe("SLASH_COMMANDS", () => {
  it("is sorted (so /help reads alphabetically)", () => {
    const sorted = SLASH_COMMANDS.slice().sort();
    assert.deepEqual([...SLASH_COMMANDS], sorted);
  });

  it("contains every command we ship", () => {
    // Spot-check a handful so an accidental removal trips this test.
    for (const cmd of [
      "clear",
      "cost",
      "exit",
      "help",
      "instructions",
      "model",
      "resume",
      "save",
      "search",
      "update",
    ]) {
      assert.ok(SLASH_COMMANDS.includes(cmd), `missing slash: ${cmd}`);
    }
  });
});
