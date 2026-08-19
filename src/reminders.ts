// Decision-time reminders: tiny, event-driven notes injected at the tail of
// the system prompt for the *next* model call. They are not persisted in
// history and not shown to the user — they exist only to steer the model at
// the moment it is about to decide what to do next.
//
// The detector is deliberately small and stateful per runAgent invocation:
// it remembers "files changed, not yet verified" and "a bash command ran
// unusually long", then emits each reminder once until the underlying state
// changes. This keeps the prompt tail cheap and cache-friendly — no
// per-turn reminder unless something actually happened.

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
const LONG_BASH_MS = 30_000;

const EDIT_TEMPLATE =
  "Files were modified in this turn. Run verify with the project's check command (e.g. npm test) and read the result before telling the user the task is done.";

function longBashTemplate(seconds: number): string {
  return `The previous bash command ran for ${seconds}s. Confirm its exit_code and output before proceeding — do not assume it succeeded.`;
}

export class ReminderDetector {
  private editsUnverified = false;
  private editsReminderEmitted = false;
  private longBashMessage: string | null = null;
  private longBashEmitted = false;

  /** Record a completed tool call. `content` is the compressed tool result. */
  onToolEnd(
    name: string,
    content: string,
    _rejected: boolean,
    durationMs: number,
  ): void {
    if (WRITE_TOOLS.has(name)) {
      this.editsUnverified = true;
      this.editsReminderEmitted = false;
      return;
    }

    if (name === "verify") {
      const passed = /exit_code: 0/.test(content);
      if (passed) {
        this.editsUnverified = false;
      } else {
        // A failed check doesn't clear the obligation; re-arm so the model
        // gets told to verify again after fixing.
        this.editsReminderEmitted = false;
      }
      return;
    }

    if (name === "bash" && durationMs > LONG_BASH_MS) {
      this.longBashMessage = longBashTemplate(Math.round(durationMs / 1000));
      this.longBashEmitted = false;
    }
  }

  /** Return the next reminder to inject, or null when nothing is pending. */
  getReminder(): string | null {
    if (this.longBashMessage && !this.longBashEmitted) {
      this.longBashEmitted = true;
      return this.longBashMessage;
    }
    if (this.editsUnverified && !this.editsReminderEmitted) {
      this.editsReminderEmitted = true;
      return EDIT_TEMPLATE;
    }
    return null;
  }
}
