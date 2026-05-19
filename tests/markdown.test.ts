import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks } from "../src/tui/Markdown.js";

describe("parseBlocks", () => {
  it("identifies ATX headings with their level", () => {
    const blocks = parseBlocks("# H1\n## H2\n###### H6");
    const headings = blocks.filter((b) => b.kind === "heading");
    assert.equal(headings.length, 3);
    if (headings[0].kind === "heading") {
      assert.equal(headings[0].level, 1);
      assert.equal(headings[0].text, "H1");
    }
    if (headings[2].kind === "heading") assert.equal(headings[2].level, 6);
  });

  it("collects code fences as a single code block", () => {
    const blocks = parseBlocks(
      "```python\nprint('hi')\nprint('bye')\n```\n",
    );
    const code = blocks.find((b) => b.kind === "code");
    assert.ok(code && code.kind === "code");
    assert.equal(code.lang, "python");
    assert.deepEqual(code.lines, ["print('hi')", "print('bye')"]);
  });

  it("blank lines inside a code fence are kept, not block-splitters", () => {
    const blocks = parseBlocks("```\nfoo\n\nbar\n```");
    const code = blocks.find((b) => b.kind === "code");
    assert.ok(code && code.kind === "code");
    assert.deepEqual(code.lines, ["foo", "", "bar"]);
  });

  it("recognizes bulleted lists (-, *, +)", () => {
    const blocks = parseBlocks("- one\n- two\n- three");
    const list = blocks.find((b) => b.kind === "list");
    assert.ok(list && list.kind === "list");
    assert.equal(list.ordered, false);
    assert.deepEqual(list.items, ["one", "two", "three"]);
  });

  it("recognizes ordered lists (1. style)", () => {
    const blocks = parseBlocks("1. one\n2. two\n3. three");
    const list = blocks.find((b) => b.kind === "list");
    assert.ok(list && list.kind === "list");
    assert.equal(list.ordered, true);
    assert.deepEqual(list.items, ["one", "two", "three"]);
  });

  it("collects blockquote runs", () => {
    const blocks = parseBlocks("> first line\n> second line");
    const q = blocks.find((b) => b.kind === "quote");
    assert.ok(q && q.kind === "quote");
    assert.deepEqual(q.lines, ["first line", "second line"]);
  });

  it("identifies tables with a separator row", () => {
    const blocks = parseBlocks(
      "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |",
    );
    const table = blocks.find((b) => b.kind === "table");
    assert.ok(table && table.kind === "table");
    assert.deepEqual(table.rows, [
      ["A", "B"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("does NOT treat pipe-prefixed lines as a table without a separator row", () => {
    // Otherwise random text starting with `|` would mis-render.
    const blocks = parseBlocks("| Board | CPU |\n| something else |");
    assert.equal(blocks.find((b) => b.kind === "table"), undefined);
  });

  it("joins contiguous non-blank lines into a paragraph", () => {
    const blocks = parseBlocks("one\ntwo\nthree");
    const paras = blocks.filter((b) => b.kind === "paragraph");
    assert.equal(paras.length, 1);
    if (paras[0].kind === "paragraph") {
      assert.equal(paras[0].text, "one two three");
    }
  });

  it("separates paragraphs by blank lines", () => {
    const blocks = parseBlocks("first para\n\nsecond para");
    const paras = blocks.filter((b) => b.kind === "paragraph");
    assert.equal(paras.length, 2);
  });

  it("handles an empty source", () => {
    // Empty input produces a single "blank" block (split("\n") on ""
    // returns [""], which the parser treats as one blank line). Nothing
    // visible renders, which is fine.
    const blocks = parseBlocks("");
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ["blank"],
    );
  });
});
