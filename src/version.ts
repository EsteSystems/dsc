import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve package.json at module load time. Works for both src/version.ts
// (tsx dev mode, sibling-of-src package.json) and dist/version.js (shipped
// build, sibling-of-dist package.json). Falls back to "0.0.0" if anything
// goes wrong — we don't want a missing manifest to crash dsc on startup.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    // ignore
  }
  return "0.0.0";
}

export const VERSION = readVersion();

export function formatVersionInfo(): string {
  return `dsc ${VERSION}\nNode ${process.version}, ${process.platform}/${process.arch}`;
}
