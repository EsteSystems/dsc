const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STALL_THRESHOLD_MS = 10_000;

export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private active = false;
  private label: string;
  private startedAt = 0;
  private lastActivity = 0;

  constructor(label: string) {
    this.label = label;
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.active) this.draw();
  }

  start(): void {
    if (this.active) return;
    if (!process.stdout.isTTY) return;
    this.active = true;
    this.startedAt = Date.now();
    this.lastActivity = this.startedAt;
    this.draw();
    this.timer = setInterval(() => this.draw(), 100);
    this.timer.unref?.();
  }

  // Reset the stall clock. Call whenever we receive a byte from the API.
  bump(): void {
    this.lastActivity = Date.now();
  }

  private draw(): void {
    const f = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length];
    const elapsedMs = Date.now() - this.startedAt;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const sinceActivityMs = Date.now() - this.lastActivity;
    const stalled = sinceActivityMs > STALL_THRESHOLD_MS;
    const noBytesYet = this.lastActivity === this.startedAt;

    let body: string;
    let color = DIM;
    if (stalled) {
      color = YELLOW;
      if (noBytesYet) {
        body = `${this.label}… stalled (no bytes after ${elapsedSec}s)`;
      } else {
        const sinceSec = Math.floor(sinceActivityMs / 1000);
        body = `${this.label}… stalled (${sinceSec}s since last byte)`;
      }
    } else {
      body = `${this.label}… ${elapsedSec}s`;
    }
    process.stdout.write(`\r\x1b[K${color}${f} ${body}${RESET}`);
  }

  stop(): void {
    if (!this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
  }
}

/**
 * Status bar printed as a regular line after each agent turn.
 *
 * Simple and safe: no scroll regions, no cursor juggling, no timer.
 * The status line appears just before the prompt so it's always the
 * most recent thing before you type.
 */
export class StatusBar {
  private text = "";
  private active = false;

  enable(): void {
    this.active = true;
  }

  render(text: string): void {
    if (!this.active) return;
    if (text === this.text) return; // skip duplicate renders
    this.text = text;
    process.stdout.write(`\n${DIM}── ${text}${RESET}\n`);
  }

  disable(): void {
    this.active = false;
  }
}
