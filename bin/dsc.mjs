#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve the package root from this file's location. With `npm link` the
// global symlink resolves through to the real repo, so this points at the
// editable source — no rebuild needed.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
const srcEntry = join(pkgRoot, "src", "index.ts");
const distEntry = join(pkgRoot, "dist", "index.js");

if (existsSync(tsxBin) && existsSync(srcEntry)) {
  // Dev: run TS sources directly. Live changes pick up on next launch.
  const child = spawn(tsxBin, [srcEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // Fallback: production-style install without devDeps. Use the compiled
  // output instead. Run `npm run build` to refresh `dist/`.
  await import(distEntry);
}
