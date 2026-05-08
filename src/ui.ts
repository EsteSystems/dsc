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

export class StatusBar {
  private text = "";
  private active = false;
  private resizeHandler = (): void => {
    if (!this.active) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return;
    process.stdout.write(`\x1b[1;${rows - 1}r`);
    this.render(this.text);
  };

  enable(): void {
    if (this.active) return;
    if (!process.stdout.isTTY) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return;
    // Set scroll region to lines 1..rows-1, leaving last row for the status bar.
    process.stdout.write(`\x1b[1;${rows - 1}r\x1b[${rows - 1};1H`);
    this.active = true;
    process.stdout.on("resize", this.resizeHandler);
  }

  render(text: string): void {
    this.text = text;
    if (!this.active) return;
    const rows = process.stdout.rows ?? 24;
    // Save cursor, jump to bottom row, clear, write, restore cursor.
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K${DIM}${text}${RESET}\x1b8`);
  }

  disable(): void {
    if (!this.active) return;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b[r\x1b[${rows};1H\x1b[2K`);
    process.stdout.removeListener("resize", this.resizeHandler);
    this.active = false;
  }
}
