#!/usr/bin/env node
// Build dist/ and run `npm pack` into ./pkg/. Cross-platform: only depends
// on Node and npm being on PATH, so it works on linux/mac/windows the same.
//
// Usage:  npm run package
//         node scripts/package.mjs
//
// Output: ./pkg/dsc-<version>.tgz   (delete the dir or run again to refresh)

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const pkgDir = join(root, "pkg");
const distDir = join(root, "dist");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tarball = `${pkg.name}-${pkg.version}.tgz`;

function run(cmd, args, opts = {}) {
  const npmCmd = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const r = spawnSync(npmCmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) {
    process.stderr.write(`\n${cmd} ${args.join(" ")} exited ${r.status}\n`);
    process.exit(r.status ?? 1);
  }
}

// tsc doesn't clean dist/ between builds, so stale artifacts (e.g. left over
// after a branch checkout) can leak into the tarball. Wipe and rebuild.
console.log(`▶ wiping dist/ and rebuilding`);
rmSync(distDir, { recursive: true, force: true });
run("npm", ["run", "build"]);

// Refresh pkg/ — keep just the latest tarball there.
mkdirSync(pkgDir, { recursive: true });
for (const f of readdirSync(pkgDir)) {
  if (f.endsWith(".tgz")) rmSync(join(pkgDir, f));
}

console.log(`▶ npm pack`);
run("npm", ["pack", "--silent"]);
renameSync(join(root, tarball), join(pkgDir, tarball));

const out = join(pkgDir, tarball);
console.log(`\n✓ packaged: ${out}`);
console.log(`\nInstall locally:`);
console.log(`  npm install -g ${out}`);
console.log(`Or use the wrappers:`);
console.log(`  scripts/install.sh   # linux / macOS`);
console.log(`  scripts/install.ps1  # Windows PowerShell`);
