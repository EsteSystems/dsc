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

// Pick the entry. TUI (ink) is the default and handles its own one-shot
// mode now (`dsc "prompt"` runs the agent against stdout and exits without
// ever rendering ink). `--repl` opts into the readline REPL when the user
// explicitly wants it.
const argv = process.argv.slice(2);
const wantsRepl = argv.includes("--repl");
const filteredArgv = argv.filter((a) => a !== "--repl");

const entryName = wantsRepl ? "index" : "tui";
const srcEntry = join(pkgRoot, "src", wantsRepl ? "index.ts" : "tui.tsx");
const distEntry = join(pkgRoot, "dist", `${entryName}.js`);

const tsxAvailable = existsSync(tsxBin) || existsSync(tsxBinCmd);

if (tsxAvailable && existsSync(srcEntry)) {
  // Dev: run TS sources directly. Live changes pick up on next launch.
  // On Windows, npm installs shim .cmd alongside the bare executable —
  // spawn with shell:true so either is found, and quote argv values that
  // might contain spaces (e.g. paths in C:\Program Files\...).
  const child = spawn(
    process.platform === "win32" ? tsxBinCmd : tsxBin,
    [srcEntry, ...filteredArgv],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  // Fallback: production-style install without devDeps. Use the compiled
  // output instead. Run `npm run build` to refresh `dist/`.
  //
  // Dynamic import() requires a file:// URL on Windows (an absolute path
  // like `C:\path\file.js` gets parsed with `c:` as a URL scheme, which
  // fails with ERR_UNSUPPORTED_ESM_URL_SCHEME). pathToFileURL handles
  // the conversion correctly on every platform.
  await import(pathToFileURL(distEntry).href);
}
