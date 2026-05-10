#!/usr/bin/env node
// Run `npm pack` and move the resulting tarball into ./pkg/.
//
// dist/ is rebuilt by the `prepack` lifecycle hook (scripts/build.mjs), so
// `npm pack`, `npm publish`, and this script all ship the same clean artifact.
//
// Usage:  npm run package   →   ./pkg/<name>-<version>.tgz

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgDir = join(root, "pkg");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Clean any prior tarballs so pkg/ always has just the latest.
mkdirSync(pkgDir, { recursive: true });
for (const f of readdirSync(pkgDir)) {
  if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
}

console.log(`▶ npm pack (prepack will rebuild dist/)`);
const r = spawnSync(npm, ["pack", "--silent"], { stdio: "inherit", cwd: root });
if (r.status !== 0) process.exit(r.status ?? 1);

// Discover the tarball — the filename depends on whether the package is
// scoped (`@scope/name` → `scope-name-version.tgz`) so don't predict it.
const tgzs = readdirSync(root).filter((f) => f.endsWith(".tgz"));
if (tgzs.length === 0) {
  process.stderr.write("npm pack produced no tarball\n");
  process.exit(1);
}
const tarball = tgzs[0];
renameSync(join(root, tarball), join(pkgDir, tarball));

const out = join(pkgDir, tarball);
console.log(`\n✓ packaged: ${out}`);
console.log(`\nInstall locally:`);
console.log(`  npm install -g ${out}`);
console.log(`Or use the wrappers:`);
console.log(`  scripts/install.sh   # linux / macOS`);
console.log(`  scripts/install.ps1  # Windows PowerShell`);
