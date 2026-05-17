const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// Quadrant blocks (U+2596–U+259D). Picked over the classic braille set
// because every mainstream dev mono font (IBM Plex, JetBrains, Cascadia,
// Consolas, Noto Sans Mono) actually contains these glyphs in its cmap —
// no font-linking fallback, so the spinner cell metrics match the rest of
// the line. Braille (U+28xx) is absent from all of those, which forces
// conhost to render the spinner in Segoe UI Symbol.
const SPINNER_FRAMES = ["▖", "▘", "▝", "▗"];
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
