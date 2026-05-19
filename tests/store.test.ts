import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getState, setState, subscribe } from "../src/store.js";

// Tests share the module-level store; each test should restore state
// it touched so we don't leak across cases. The hot fields are small
// scalars + arrays — easy to reset.

describe("store", () => {
  it("getState returns the current snapshot", () => {
    const s = getState();
    assert.equal(typeof s.busy, "boolean");
    assert.equal(Array.isArray(s.history), true);
  });

  it("setState with an object patch merges in", () => {
    const before = getState().busy;
    setState({ busy: !before });
    assert.equal(getState().busy, !before);
    setState({ busy: before });
  });

  it("setState with a function receives current state and returns a patch", () => {
    setState({ inTokens: 0 });
    setState((s) => ({ inTokens: s.inTokens + 5 }));
    setState((s) => ({ inTokens: s.inTokens + 7 }));
    assert.equal(getState().inTokens, 12);
    setState({ inTokens: 0 });
  });

  it("subscribers fire on every setState", () => {
    let count = 0;
    const unsub = subscribe(() => {
      count++;
    });
    setState({ busy: true });
    setState({ busy: false });
    unsub();
    assert.equal(count, 2);
  });

  it("subscribers stop firing after unsubscribe", () => {
    let count = 0;
    const unsub = subscribe(() => {
      count++;
    });
    setState({ busy: true });
    unsub();
    setState({ busy: false });
    assert.equal(count, 1);
  });

  it("multiple subscribers all fire", () => {
    let a = 0;
    let b = 0;
    const ua = subscribe(() => a++);
    const ub = subscribe(() => b++);
    setState({ busy: true });
    ua();
    ub();
    assert.equal(a, 1);
    assert.equal(b, 1);
    setState({ busy: false });
  });

  it("partial patches don't clobber unrelated fields", () => {
    setState({ inTokens: 42, outTokens: 17 });
    setState({ inTokens: 99 });
    const s = getState();
    assert.equal(s.inTokens, 99);
    assert.equal(s.outTokens, 17);
    setState({ inTokens: 0, outTokens: 0 });
  });
});
