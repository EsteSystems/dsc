import { spawn, spawnSync } from "node:child_process";

/**
 * Cross-platform clipboard write. Picks the right helper per OS:
 *
 *   - macOS:   pbcopy
 *   - Windows: clip.exe
 *   - Linux:   wl-copy → xclip → xsel (first that's installed)
 *
 * Throws when no helper is available so the caller can surface a clear
 * error to the user (e.g. "install xclip"). Keeping this out of the
 * regular tool surface — it's UI sugar for the user, not something the
 * agent should ever need to call.
 */

function which(cmd: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(lookup, [cmd], { stdio: "ignore" });
  return r.status === 0;
}

interface ClipboardCmd {
  cmd: string;
  args: string[];
}

function pickHelper(): ClipboardCmd | null {
  if (process.platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (process.platform === "win32") return { cmd: "clip", args: [] };
  // Linux: try Wayland first since modern desktops default to it, then X11.
  if (which("wl-copy")) return { cmd: "wl-copy", args: [] };
  if (which("xclip")) return { cmd: "xclip", args: ["-selection", "clipboard"] };
  if (which("xsel")) return { cmd: "xsel", args: ["--clipboard", "--input"] };
  return null;
}

export function copyToClipboard(text: string): Promise<void> {
  const helper = pickHelper();
  if (!helper) {
    return Promise.reject(
      new Error(
        process.platform === "linux"
          ? "no clipboard helper found — install wl-clipboard, xclip, or xsel"
          : "no clipboard helper available on this platform",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(helper.cmd, helper.args, {
      stdio: ["pipe", "ignore", "pipe"],
      // clip.exe on Windows is found via PATH; shell:true is safest there.
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let err = "";
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(e));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `${helper.cmd} exited ${code}`));
    });
    child.stdin.end(text, "utf8");
  });
}
