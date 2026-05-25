import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  _resetConfigCachesForTests,
  apiKeySource,
  computeCostUsd,
  configPath,
  consumeConfigMigrationNotice,
  getConfig,
  hasApiKey,
  legacyConfigPath,
  migrateLegacyConfigIfNeeded,
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
    // Use path.join in both expectation and assertion so the separator
    // matches the platform — on Windows configPath produces backslashes.
    const xdg = path.join(path.sep, "tmp", "x", ".config");
    process.env.XDG_CONFIG_HOME = xdg;
    assert.equal(
      configPath(),
      path.join(xdg, "dsc", "config.json"),
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    delete process.env.XDG_CONFIG_HOME;
    const p = configPath();
    const tail = path.join(".config", "dsc", "config.json");
    assert.ok(p.endsWith(tail), `got ${p}, expected to end with ${tail}`);
  });

  it("legacyConfigPath still points at deepseek/deepseek.json", () => {
    const xdg = path.join(path.sep, "tmp", "x", ".config");
    process.env.XDG_CONFIG_HOME = xdg;
    assert.equal(
      legacyConfigPath(),
      path.join(xdg, "deepseek", "deepseek.json"),
    );
  });
});

describe("migrateLegacyConfigIfNeeded", () => {
  let tmpDir: string;
  let prevXdg: string | undefined;
  let prevEnvKey: string | undefined;

  before(() => {
    prevXdg = process.env.XDG_CONFIG_HOME;
    prevEnvKey = process.env.DEEPSEEK_API_KEY;
    // Keep env-var path off so getConfig actually reads from disk.
    delete process.env.DEEPSEEK_API_KEY;
  });
  after(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevEnvKey;
  });

  beforeEach(() => {
    // Each scenario gets a clean XDG_CONFIG_HOME so we're not racing
    // against earlier test runs or the developer's real config file.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-cfg-test-"));
    process.env.XDG_CONFIG_HOME = tmpDir;
    _resetConfigCachesForTests();
    // Drain any pending notice from a prior describe block.
    consumeConfigMigrationNotice();
  });

  it("is a no-op when neither legacy nor new exists", () => {
    assert.equal(migrateLegacyConfigIfNeeded(), null);
    assert.equal(consumeConfigMigrationNotice(), null);
    assert.equal(fs.existsSync(configPath()), false);
  });

  it("is a no-op when the new file already exists", () => {
    // Even if legacy is present too, an existing new file wins — we
    // don't clobber the user's already-migrated state.
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '{"api_key":"sk-new"}');
    fs.mkdirSync(path.dirname(legacyConfigPath()), { recursive: true });
    fs.writeFileSync(legacyConfigPath(), '{"api_key":"sk-old"}');

    assert.equal(migrateLegacyConfigIfNeeded(), null);
    assert.equal(consumeConfigMigrationNotice(), null);
    assert.equal(
      fs.readFileSync(configPath(), "utf8"),
      '{"api_key":"sk-new"}',
      "new file must not be overwritten",
    );
  });

  it("copies legacy → new and surfaces the notice once", () => {
    fs.mkdirSync(path.dirname(legacyConfigPath()), { recursive: true });
    fs.writeFileSync(legacyConfigPath(), '{"api_key":"sk-legacy"}');

    const migrated = migrateLegacyConfigIfNeeded();
    assert.equal(migrated, legacyConfigPath());
    assert.equal(
      fs.readFileSync(configPath(), "utf8"),
      '{"api_key":"sk-legacy"}',
    );
    // Legacy file must remain in place — paranoid about destroying
    // user-curated config until they confirm the new path works.
    assert.equal(fs.existsSync(legacyConfigPath()), true);

    // First consume returns the path; second returns null.
    assert.equal(consumeConfigMigrationNotice(), legacyConfigPath());
    assert.equal(consumeConfigMigrationNotice(), null);
  });

  it("is idempotent: re-running after migration returns null", () => {
    fs.mkdirSync(path.dirname(legacyConfigPath()), { recursive: true });
    fs.writeFileSync(legacyConfigPath(), '{"api_key":"sk-legacy"}');

    assert.equal(migrateLegacyConfigIfNeeded(), legacyConfigPath());
    // Now the new file exists; a second call should be a clean no-op.
    assert.equal(migrateLegacyConfigIfNeeded(), null);
  });

  it("getConfig() reads the migrated config and applies the migration lazily", () => {
    fs.mkdirSync(path.dirname(legacyConfigPath()), { recursive: true });
    fs.writeFileSync(legacyConfigPath(), '{"api_key":"sk-lazy"}');

    const cfg = getConfig();
    assert.ok(cfg);
    assert.equal((cfg as Record<string, unknown>).api_key, "sk-lazy");
    // The lazy migration should have run as a side effect.
    assert.equal(fs.existsSync(configPath()), true);
    assert.equal(consumeConfigMigrationNotice(), legacyConfigPath());
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
    // Bust any cached config left over from the migration describe
    // block so getConfig actually re-reads against the new XDG path.
    _resetConfigCachesForTests();
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
