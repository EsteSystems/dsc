const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// Renders markdown-ish text incrementally. Buffers the current line so that
// per-line patterns (headings, fenced code) can be matched. Anything before
// the most recent newline is emitted with formatting; anything after is held.
export class MarkdownRenderer {
  private lineBuf = "";
  private inFence = false;

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (ch === "\n") {
        out += this.renderLine(this.lineBuf) + "\n";
        this.lineBuf = "";
      } else {
        this.lineBuf += ch;
      }
    }
    return out;
  }

  flush(): string {
    if (!this.lineBuf) return "";
    const out = this.renderLine(this.lineBuf);
    this.lineBuf = "";
    return out;
  }

  private renderLine(line: string): string {
    // Code fence toggles on lines that start with ```
    if (/^\s*```/.test(line)) {
      this.inFence = !this.inFence;
      return DIM + line + RESET;
    }
    if (this.inFence) {
      return CYAN + line + RESET;
    }
    // Headings: # through ######
    if (/^#{1,6}\s+\S/.test(line)) {
      return BOLD + MAGENTA + line + RESET;
    }
    // Bullet list markers — replace `- ` / `* ` prefix with a unicode bullet.
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bulletMatch) {
      return `${bulletMatch[1]}${DIM}•${RESET} ${inline(bulletMatch[2])}`;
    }
    return inline(line);
  }
}

function inline(line: string): string {
  // Inline code first (highest priority), then bold. Keep bold non-greedy and
  // single-line so it doesn't swallow stars from later in the document.
  return line
    .replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`)
    .replace(/\*\*([^*\n]+?)\*\*/g, `${BOLD}$1${RESET}`);
}
