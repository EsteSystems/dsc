import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  apiKeySource,
  computeCostUsd,
  configPath,
  hasApiKey,
  newStats,
  type Stats,
} from "../src/api.js";

describe("configPath", () => {
  let prevXdg: string | undefined;
  before(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
  });
  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  it("honors XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/x/.config";
    assert.equal(configPath(), "/tmp/x/.config/deepseek/deepseek.json");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    const p = configPath();
    assert.ok(p.endsWith("/.config/deepseek/deepseek.json"), `got ${p}`);
  });
});

describe("apiKeySource / hasApiKey", () => {
  let prevEnv: string | undefined;
  let prevXdg: string | undefined;
  before(() => {
    prevEnv = process.env.DEEPSEEK_API_KEY;
    prevXdg = process.env.XDG_CONFIG_HOME;
    // Steer the file lookup at a nonexistent path so we can vary the
    // env-var presence in isolation.
    process.env.XDG_CONFIG_HOME = "/tmp/dsc-api-test-no-such-config";
  });
  after(() => {
    if (prevEnv === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevEnv;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  it("reports 'env' when DEEPSEEK_API_KEY is set", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test-env-key";
    assert.equal(apiKeySource(), "env");
    assert.equal(hasApiKey(), true);
  });

  it("reports null when neither env nor file has a key", () => {
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal(apiKeySource(), null);
    assert.equal(hasApiKey(), false);
  });
});

describe("computeCostUsd", () => {
  it("zero usage returns zero", () => {
    const s = newStats();
    assert.equal(computeCostUsd(s, "deepseek-v4-pro"), 0);
  });

  it("output tokens are billed at the model's out rate", () => {
    const s: Stats = { ...newStats(), completion_tokens: 1_000_000 };
    // Per src/api.ts, deepseek-v4-pro out rate is 0.828e-6/token.
    // 1M tokens → $0.828.
    const cost = computeCostUsd(s, "deepseek-v4-pro");
    assert.ok(Math.abs(cost - 0.828) < 1e-9, `got ${cost}`);
  });

  it("cache-hit prompt tokens are billed at the hit rate", () => {
    const s: Stats = { ...newStats(), prompt_tokens: 1_000_000, cache_hit_tokens: 1_000_000 };
    // deepseek-v4-pro: in_hit = 0.0034e-6 → 1M tokens = $0.0034.
    const cost = computeCostUsd(s, "deepseek-v4-pro");
    assert.ok(Math.abs(cost - 0.0034) < 1e-9, `got ${cost}`);
  });

  it("uncategorized prompt tokens fall back to the miss rate", () => {
    // Legacy API responses report prompt_tokens but no hit/miss breakdown;
    // we bill the remainder at miss (conservative — overestimates rather
    // than under).
    const s: Stats = { ...newStats(), prompt_tokens: 1_000_000 };
    const cost = computeCostUsd(s, "deepseek-v4-pro");
    // 1M @ in_miss 0.414e-6 → $0.414
    assert.ok(Math.abs(cost - 0.414) < 1e-9, `got ${cost}`);
  });

  it("flash model is cheaper than pro for identical usage", () => {
    const s: Stats = { ...newStats(), completion_tokens: 1_000_000 };
    const pro = computeCostUsd(s, "deepseek-v4-pro");
    const flash = computeCostUsd(s, "deepseek-v4-flash");
    assert.ok(flash < pro, `flash ${flash} should be < pro ${pro}`);
  });
});
