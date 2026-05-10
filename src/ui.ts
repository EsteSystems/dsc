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
 * Status bar pinned to the last row of the terminal via DECSTBM
 * (DEC Set Top and Bottom Margins). Reserves the bottom row for the bar,
 * lets everything else scroll within rows 1..N-1. Re-asserts the region
 * on a periodic timer so tools that write past it don't dislodge things.
 *
 * Falls back to no-op when stdout isn't a TTY (piped output stays clean).
 */
export class StatusBar {
  private text = "";
  private active = false;
  private timer?: NodeJS.Timeout;
  private resizeHandler = (): void => this.onResize();

  enable(): void {
    if (this.active) return;
    if (!process.stdout.isTTY) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return; // too short to bother

    // Reset any stale region, set ours, drop the cursor at the bottom of
    // the scrollable area so the prompt lands one row above the status.
    process.stdout.write(`\x1b[r\x1b[1;${rows - 1}r\x1b[${rows - 1};1H`);
    this.active = true;

    // Periodic re-paint defends against scroll-region drift (some tools
    // reset the region or move the cursor past it).
    this.timer = setInterval(() => this.paint(), 1000);
    this.timer.unref?.();
    process.stdout.on("resize", this.resizeHandler);
  }

  render(text: string): void {
    this.text = text;
    this.paint();
  }

  disable(): void {
    if (!this.active) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.removeListener("resize", this.resizeHandler);
    this.active = false;

    // Reset scroll region to full screen and clear the bottom row so
    // exit doesn't leave a stale status line stuck on screen.
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b[r\x1b[${rows};1H\x1b[2K`);
  }

  private paint(): void {
    if (!this.active) return;
    if (!process.stdout.isTTY) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return;

    // Sequence: re-assert scroll region, save cursor, jump to bottom row,
    // clear it, write reverse-video status, restore cursor.
    process.stdout.write(
      `\x1b[1;${rows - 1}r` +
        `\x1b7` +
        `\x1b[${rows};1H` +
        `\x1b[2K` +
        `\x1b[7m ${this.text} \x1b[0m` +
        `\x1b8`,
    );
  }

  private onResize(): void {
    if (!this.active) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return;
    // Reset → set new region → repaint. The reset is needed because the
    // old region is wrong dimensions for the new size.
    process.stdout.write(`\x1b[r\x1b[1;${rows - 1}r`);
    this.paint();
  }
}
