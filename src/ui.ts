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

/**
 * Status bar pinned to the last row via DECSTBM. Sets the scroll region
 * to 1..N-1 at enable + on resize; paint() writes to row N without
 * touching margins.
 *
 * Repaint strategy is "overwrite, then trim". We write the status text
 * and then emit `\x1b[K` (clear-to-end-of-line) to wipe any trailing
 * characters from a previously-longer status. We never `\x1b[2K` (clear
 * whole row) before writing — that's the flash that made the earlier
 * version flicker on every periodic repaint.
 *
 * A 1 s timer repaints unconditionally so the status survives
 * terminal-side weirdness (some terminals clobber row N when the scroll
 * region scrolls). With overwrite-in-place, identical repaints are
 * visually a no-op.
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
    const cols = process.stdout.columns ?? 80;
    if (rows < 4) return;

    // Truncate to fit. We add 1 leading + 1 trailing space inside the
    // reverse-video block, so usable width is cols-2. Without this, a
    // status wider than the terminal auto-wraps onto a non-existent
    // row N+1, scrolling the whole screen up and leaving only the
    // wrapped tail visible on row N.
    const maxLen = Math.max(0, cols - 2);
    const display =
      this.text.length > maxLen
        ? this.text.slice(0, Math.max(0, maxLen - 1)) + "…"
        : this.text;

    // Save cursor → jump to row N col 1 → write reverse-video status
    // (overwrites in place; no pre-clear means no blank flash) →
    // \x1b[K trims any trailing characters from a longer prior status →
    // restore cursor. Region is left alone — setting it here would
    // force the cursor to (1,1) and break the prompt position.
    process.stdout.write(
      `\x1b7` +
        `\x1b[${rows};1H` +
        `\x1b[7m ${display} \x1b[0m` +
        `\x1b[K` +
        `\x1b8`,
    );
  }

  private onResize(): void {
    if (!this.active) return;
    const rows = process.stdout.rows ?? 24;
    if (rows < 4) return;
    process.stdout.write(`\x1b[r\x1b[1;${rows - 1}r`);
    this.paint();
  }
}
