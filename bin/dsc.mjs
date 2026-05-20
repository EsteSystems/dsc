#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

// Resolve the package root from this file's location. With `npm link` the
// global symlink resolves through to the real repo, so this points at the
// editable source — no rebuild needed.
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
const tsxBin = join(pkgRoot, "node_modules", ".bin", "tsx");
const tsxBinCmd = process.platform === "win32" ? tsxBin + ".cmd" : tsxBin;

const argv = process.argv.slice(2);
const tsxAvailable = existsSync(tsxBin) || existsSync(tsxBinCmd);

// ── Subcommand dispatch ─────────────────────────────────────────────
// `dsc serve` routes to the WebSocket daemon; anything else uses the TUI.

const subcommand = argv[0];
const isServe = subcommand === "serve";

const srcEntry = join(
  pkgRoot, "src", isServe ? "serve.ts" : "tui.tsx",
);
const distEntry = join(
  pkgRoot, "dist", isServe ? "serve.js" : "tui.js",
);

if (isServe) argv.shift(); // strip "serve" from args

if (tsxAvailable && existsSync(srcEntry)) {
  const child = spawn(
    process.platform === "win32" ? tsxBinCmd : tsxBin,
    [srcEntry, ...argv],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // Fallback: compiled output from `npm run build`.
  // Needs `import()` which requires file:// URL on Windows.
  await import(pathToFileURL(distEntry).href);
}
