// Tool lifecycle hooks. Power users / CI can configure per-tool commands in
// ~/.config/dsc/config.json:
//
//   {
//     "hooks": {
//       "pre_tool_use":  { "bash": "echo about-to-run; exit 0" },
//       "post_tool_use": { "bash": "echo ran" }
//     }
//   }
//
// A pre hook that exits non-zero blocks the tool. Post hooks are best-effort
// observers; their stdout/stderr is appended to the tool result as a note.

import { spawnSync } from "node:child_process";
import { getConfig } from "./api.js";

const HOOK_TIMEOUT_MS = 5_000;

interface HooksConfig {
  pre_tool_use?: Record<string, string>;
  post_tool_use?: Record<string, string>;
}

function readHooksConfig(): HooksConfig {
  try {
    const cfg = getConfig();
    const hooks = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).hooks : undefined;
    if (!hooks || typeof hooks !== "object") return {};
    const obj = hooks as Record<string, unknown>;
    const stringMap = (v: unknown): Record<string, string> | undefined =>
      v && typeof v === "object" ? (v as Record<string, string>) : undefined;
    return {
      pre_tool_use: stringMap(obj.pre_tool_use),
      post_tool_use: stringMap(obj.post_tool_use),
    };
  } catch {
    return {};
  }
}

function findHook(section: Record<string, string> | undefined, tool: string): string | undefined {
  if (!section) return undefined;
  return section[tool] ?? section["*"];
}

function runHook(command: string, tool: string, argsJson: string, cwd: string) {
  try {
    const r = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: HOOK_TIMEOUT_MS,
      env: {
        ...process.env,
        DSC_TOOL_NAME: tool,
        DSC_TOOL_ARGS: argsJson,
      },
    });
    const stdout = r.stdout?.trim() ?? "";
    const stderr = r.stderr?.trim() ?? "";
    return {
      exitCode: r.error ? 1 : r.status ?? 0,
      output: [stdout, stderr].filter(Boolean).join("\n"),
    };
  } catch {
    return { exitCode: 1, output: "hook failed to spawn" };
  }
}

export interface PreHookResult {
  blocked: boolean;
  output: string;
}

/** Run a pre-tool hook if configured. Never throws. */
export function runPreToolHook(tool: string, argsJson: string, cwd: string): PreHookResult {
  const hooks = readHooksConfig();
  const command = findHook(hooks.pre_tool_use, tool);
  if (!command) return { blocked: false, output: "" };
  const r = runHook(command, tool, argsJson, cwd);
  return { blocked: r.exitCode !== 0, output: r.output };
}

/** Run a post-tool hook if configured. Returns the note to append, or null. */
export function runPostToolHook(
  tool: string,
  argsJson: string,
  cwd: string,
  resultContent: string,
): string | null {
  const hooks = readHooksConfig();
  const command = findHook(hooks.post_tool_use, tool);
  if (!command) return null;
  const r = runHook(command, tool, argsJson, cwd);
  if (!r.output) return null;
  return r.output;
}
