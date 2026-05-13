import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Open $VISUAL / $EDITOR (defaulting to `vi`) on a temporary file seeded with
 * `initial`. Returns the saved contents with trailing newlines trimmed, or
 * `null` if the editor failed to launch or read failed.
 *
 * The editor runs with inherited stdio, so the calling process must release
 * the terminal first (e.g. the ink TUI must unmount before calling this).
 */
export function openEditor(initial: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dsc-edit-"));
  const tmpFile = path.join(tmpDir, "prompt.md");
  try {
    writeFileSync(tmpFile, initial, "utf8");
    const r = spawnSync(editor, [tmpFile], { stdio: "inherit" });
    if (r.error) return null;
    const content = readFileSync(tmpFile, "utf8");
    return content.replace(/\n+$/, "");
  } catch {
    return null;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}
