#!/usr/bin/env node
// Wipe dist/ and rebuild. Used as the npm `prepack` lifecycle hook so every
// `npm pack` / `npm publish` ships a clean compile, no leftover artifacts
// from a previous branch checkout.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");

console.log(`▶ wiping dist/ and rebuilding`);
rmSync(distDir, { recursive: true, force: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["run", "build"], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
