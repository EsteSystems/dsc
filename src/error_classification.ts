// Shared error classification for one-shot JSON and the interactive TUI.
// Best-effort recovery templates for failures we can handle without a human;
// unknown errors get a generic "inspect and retry" hint rather than nothing.

export interface ErrorClassification {
  /** Short actionable recovery hint. */
  fix?: string;
  /** Concrete follow-ups the caller can take or prompt the agent with. */
  next_actions?: string[];
}

export function classifyError(error: string): ErrorClassification {
  const e = error.toLowerCase();
  if (
    e.includes("api key") ||
    e.includes("api_key") ||
    e.includes("apikey") ||
    e.includes("unauthorized") ||
    e.includes("authentication")
  ) {
    return {
      fix: "Configure an API key with /api-key or set DEEPSEEK_API_KEY.",
      next_actions: ["/api-key sk-...", "export DEEPSEEK_API_KEY=sk-..."],
    };
  }
  if (e.includes("old_string not found")) {
    return {
      fix: "Re-read the target file and retry edit_file with the current exact content.",
      next_actions: ["read_file the target path", "retry edit_file with corrected old_string"],
    };
  }
  if (e.includes("old_string is not unique")) {
    return {
      fix: "Add more surrounding context or pass replace_all=true if replacing every match is intended.",
      next_actions: ["read_file the target path", "retry edit_file with more context or replace_all=true"],
    };
  }
  if (e.includes("budget reached")) {
    return {
      fix: "Raise or clear the budget with /budget.",
      next_actions: ["/budget <amount>", "/budget off"],
    };
  }
  if (
    e.includes("context") &&
    (e.includes("overflow") || e.includes("too long") || e.includes("maximum context") || e.includes("window"))
  ) {
    return {
      fix: "Compact the conversation, read smaller file slices, or retry with a narrower prompt.",
      next_actions: ["/compact", "read_file with offset/limit", "retry with a narrower prompt"],
    };
  }
  if (
    e.includes("command not found") ||
    e.includes("missing dependency") ||
    e.includes("cannot find module") ||
    e.includes("module not found")
  ) {
    return {
      fix: "Install the missing dependency or adjust the command to use what is available.",
      next_actions: ["run the project's install command", "ask the agent to install the dependency"],
    };
  }
  if (e.includes("timeout") || e.includes("killed")) {
    return {
      fix: "Use bash_status with background=true for long-running commands, or raise timeout_ms.",
      next_actions: ["rerun with background=true and poll bash_status", "raise timeout_ms and retry"],
    };
  }
  if (e.includes("max_tool_depth") || e.includes("auto_continue")) {
    return {
      fix: "The agent did not converge. Split the work into smaller explicit steps and retry.",
      next_actions: ["retry with a narrower prompt", "ask the agent to do one step at a time"],
    };
  }
  return {
    fix: "Inspect the error and retry with adjusted arguments or a narrower prompt.",
  };
}
