import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareSemver } from "../src/update.js";

describe("compareSemver", () => {
  it("equal versions return 0", () => {
    assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
    assert.equal(compareSemver("0.0.0", "0.0.0"), 0);
  });

  it("major version dominates", () => {
    assert.equal(compareSemver("1.9.9", "2.0.0"), -1);
    assert.equal(compareSemver("2.0.0", "1.9.9"), 1);
  });

  it("minor version compares within same major", () => {
    assert.equal(compareSemver("1.2.9", "1.3.0"), -1);
    assert.equal(compareSemver("1.3.0", "1.2.9"), 1);
  });

  it("patch version compares within same minor", () => {
    assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
    assert.equal(compareSemver("1.2.4", "1.2.3"), 1);
  });

  it("pre-release / build tails parse as 0 (don't flag false upgrades)", () => {
    // "0.3.0-beta.1" parses to [0, 3, 0]; we don't want to claim a -beta
    // release is "newer" than the same X.Y.Z without a suffix.
    assert.equal(compareSemver("0.3.0", "0.3.0-beta.1"), 0);
    assert.equal(compareSemver("0.3.0-rc.1", "0.3.0"), 0);
  });

  it("missing trailing segments parse as 0", () => {
    assert.equal(compareSemver("1", "1.0.0"), 0);
    assert.equal(compareSemver("1.2", "1.2.0"), 0);
  });

  it("non-numeric segments don't crash", () => {
    // We shouldn't get this from npm, but defensive against weird inputs.
    assert.equal(compareSemver("foo.bar.baz", "0.0.0"), 0);
  });

  it("scoped real-world npm-tagged versions sort as expected", () => {
    const versions = ["0.1.0", "0.1.7", "0.2.0", "0.3.0", "0.4.0", "0.5.0"];
    for (let i = 1; i < versions.length; i++) {
      assert.equal(
        compareSemver(versions[i - 1], versions[i]),
        -1,
        `${versions[i - 1]} should sort before ${versions[i]}`,
      );
    }
  });
});
