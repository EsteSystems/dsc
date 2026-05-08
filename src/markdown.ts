const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";

// ---------------------------------------------------------------------------
// LaTeX → Unicode
// ---------------------------------------------------------------------------

const GREEK_LC: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  varepsilon: "ε", vartheta: "ϑ", varpi: "ϖ", varrho: "ϱ",
  varsigma: "ς", varphi: "φ",
};

const GREEK_UC: Record<string, string> = {
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ",
  Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  "\\infty": "∞", "\\to": "→", "\\rightarrow": "→", "\\leftarrow": "←",
  "\\Rightarrow": "⇒", "\\Leftarrow": "⇐", "\\leftrightarrow": "↔",
  "\\cdot": "·", "\\times": "×", "\\pm": "±", "\\mp": "∓",
  "\\approx": "≈", "\\neq": "≠", "\\equiv": "≡", "\\sim": "∼",
  "\\leq": "≤", "\\geq": "≥", "\\ll": "≪", "\\gg": "≫",
  "\\partial": "∂", "\\nabla": "∇", "\\int": "∫", "\\iint": "∬",
  "\\iiint": "∭", "\\oint": "∮", "\\sum": "∑", "\\prod": "∏",
  "\\ldots": "…", "\\cdots": "⋯", "\\vdots": "⋮", "\\ddots": "⋱",
  "\\angle": "∠", "\\parallel": "∥", "\\perp": "⊥", "\\propto": "∝",
  "\\subset": "⊂", "\\supset": "⊃", "\\subseteq": "⊆", "\\supseteq": "⊇",
  "\\cap": "∩", "\\cup": "∪", "\\forall": "∀", "\\exists": "∃",
  "\\neg": "¬", "\\land": "∧", "\\lor": "∨", "\\implies": "⟹",
  "\\iff": "⇔", "\\mapsto": "↦", "\\emptyset": "∅", "\\varnothing": "∅",
  "\\in": "∈", "\\notin": "∉", "\\ni": "∋",
  "\\therefore": "∴", "\\because": "∵",
  "\\cdotp": "·", "\\colon": ":", "\\circ": "∘",
  "\\langle": "⟨", "\\rangle": "⟩", "\\lceil": "⌈", "\\rceil": "⌉",
  "\\lfloor": "⌊", "\\rfloor": "⌋",
};

const SUPER_DIGITS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
};
const SUB_DIGITS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
};

const SUPER_CHARS: Record<string, string> = {
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ",
  h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ",
  n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ",
  u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ",
  I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ",
  O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
};

const SUB_CHARS: Record<string, string> = {
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ",
  l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ",
  s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
};

/**
 * Return a braced group starting at s[start] (which must be '{').
 * Returns { content, end } where `end` is the index of the matching '}'.
 */
function extractBraced(s: string, start: number): { content: string; end: number } | null {
  if (start >= s.length || s[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return { content: s.slice(start + 1, i), end: i };
    }
  }
  return null;
}

/** Replace \frac{a}{b} → (a)/(b), recursing into arguments. */
function replaceFrac(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("\\frac", i) && (i + 5 >= s.length || s[i + 5] === "{")) {
      const num = extractBraced(s, i + 5);
      if (!num) { out += s[i]; i++; continue; }
      const den = extractBraced(s, num.end + 1);
      if (!den) { out += s.slice(i, num.end + 1); i = num.end + 1; continue; }
      out += `(${toUnicode(num.content)})/(${toUnicode(den.content)})`;
      i = den.end + 1;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Replace \sqrt{x} → √(x), recursing into the argument. */
function replaceSqrt(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s.startsWith("\\sqrt", i) && (i + 5 >= s.length || s[i + 5] === "{")) {
      const arg = extractBraced(s, i + 5);
      if (!arg) { out += s[i]; i++; continue; }
      out += `√(${toUnicode(arg.content)})`;
      i = arg.end + 1;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Convert a string into Unicode superscript where possible. */
function toSuper(s: string): string {
  let out = "";
  for (const ch of s) {
    out += SUPER_CHARS[ch] ?? SUPER_DIGITS[ch] ?? ch;
  }
  return out;
}

/** Convert a string into Unicode subscript where possible. */
function toSub(s: string): string {
  let out = "";
  for (const ch of s) {
    out += SUB_CHARS[ch] ?? SUB_DIGITS[ch] ?? ch;
  }
  return out;
}

/** Replace ^ {...} and ^x with Unicode superscript. */
function replaceSuper(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "^" && i + 1 < s.length) {
      if (s[i + 1] === "{") {
        const arg = extractBraced(s, i + 1);
        if (arg) { out += toSuper(arg.content); i = arg.end + 1; continue; }
      }
      out += toSuper(s[i + 1]);
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Replace _ {...} and _x with Unicode subscript. */
function replaceSub(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "_" && i + 1 < s.length) {
      if (s[i + 1] === "{") {
        const arg = extractBraced(s, i + 1);
        if (arg) { out += toSub(arg.content); i = arg.end + 1; continue; }
      }
      out += toSub(s[i + 1]);
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

/** Apply simple LaTeX symbol → Unicode replacements. */
function applySymbols(s: string): string {
  // Greek (lc first so \pi doesn't match the "pi" inside "\varpi")
  for (const [cmd, ch] of Object.entries(GREEK_LC)) {
    s = s.replaceAll("\\" + cmd, ch);
  }
  for (const [cmd, ch] of Object.entries(GREEK_UC)) {
    s = s.replaceAll("\\" + cmd, ch);
  }
  // Longer commands first to avoid partial matches
  const sorted = Object.entries(SYMBOLS).sort((a, b) => b[0].length - a[0].length);
  for (const [cmd, ch] of sorted) {
    s = s.replaceAll(cmd, ch);
  }
  // Strip \left, \right, \big variants
  s = s.replace(/\\left[\(\{\[]/g, "(");
  s = s.replace(/\\right[\)\}\]]/g, ")");
  s = s.replace(/\\big[lr]?[\(\{\[]/g, "(");
  s = s.replace(/\\big[lr]?[\)\}\]]/g, ")");
  s = s.replace(/\\big[lr]?\|/g, "|");
  s = s.replace(/\\big[lr]?\\/g, "");
  // Clean up any remaining backslash-commands
  s = s.replace(/\\[a-zA-Z]+/g, "");
  return s;
}

/** Convert a LaTeX math string to Unicode. */
function toUnicode(latex: string): string {
  let s = latex.trim();
  s = replaceFrac(s);
  s = replaceSqrt(s);
  s = replaceSuper(s);
  s = replaceSub(s);
  s = applySymbols(s);
  return s.trim();
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Renders markdown-ish text incrementally. Buffers the current line so that
 * per-line patterns (headings, fenced code, block math) can be matched.
 * Anything before the most recent newline is emitted with formatting; anything
 * after is held.
 */
export class MarkdownRenderer {
  private lineBuf = "";
  private inFence = false;
  private inBlockMath = false;
  private blockMathLines: string[] = [];
  // Tables are committed to once we see a header followed by a separator.
  // pendingRow holds a "could-be-table" line we're waiting to disambiguate.
  // tableBuf holds confirmed table rows once the separator has shown up.
  private pendingRow: string | null = null;
  private tableBuf: string[] = [];

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (ch === "\n") {
        const rendered = this.renderLine(this.lineBuf);
        // null = the renderer absorbed this line into a multi-line buffer
        // (table or block-math); don't emit the trailing newline either,
        // otherwise we'd get a blank line per buffered input line.
        if (rendered !== null) out += rendered + "\n";
        this.lineBuf = "";
      } else {
        this.lineBuf += ch;
      }
    }
    return out;
  }

  flush(): string {
    let out = "";
    if (this.inBlockMath && this.blockMathLines.length) {
      out += renderBlockMath(this.blockMathLines.join("\n")) + "\n";
      this.inBlockMath = false;
      this.blockMathLines = [];
    }
    out += this.flushPendingTable();
    if (this.lineBuf) {
      const rendered = this.renderLine(this.lineBuf);
      if (rendered !== null) out += rendered;
      this.lineBuf = "";
    }
    return out;
  }

  /** Emit any held-back table state. Returns the rendered chunk (with trailing newline if non-empty). */
  private flushPendingTable(): string {
    if (this.tableBuf.length > 0) {
      const out = renderTable(this.tableBuf) + "\n";
      this.tableBuf = [];
      this.pendingRow = null;
      return out;
    }
    if (this.pendingRow !== null) {
      const out = this.renderLeafLine(this.pendingRow) + "\n";
      this.pendingRow = null;
      return out;
    }
    return "";
  }

  private renderLine(line: string): string | null {
    // 1. Code fences
    if (/^\s*```/.test(line)) {
      const prefix = this.flushPendingTable();
      this.inFence = !this.inFence;
      return prefix + DIM + line + RESET;
    }
    if (this.inFence) {
      return CYAN + line + RESET;
    }

    // 2. Block math — $$ ... $$
    if (this.inBlockMath) {
      const closeIdx = line.indexOf("$$");
      if (closeIdx !== -1) {
        this.inBlockMath = false;
        this.blockMathLines.push(line.slice(0, closeIdx));
        const content = this.blockMathLines.join("\n");
        this.blockMathLines = [];
        const after = line.slice(closeIdx + 2);
        const block = renderBlockMath(content);
        if (after.trim()) {
          const tail = this.renderLine(after);
          return tail !== null ? block + "\n" + tail : block;
        }
        return block;
      }
      this.blockMathLines.push(line);
      return null; // buffered
    }

    // Opening $$ — may be alone or paired on the same line
    const openIdx = line.indexOf("$$");
    if (openIdx !== -1) {
      const prefix = this.flushPendingTable();
      const before = line.slice(0, openIdx);
      const after = line.slice(openIdx + 2);
      const closeIdx = after.indexOf("$$");
      const parts: string[] = [];
      if (prefix) parts.push(prefix.replace(/\n$/, ""));
      if (before.trim()) {
        const r = this.renderLine(before);
        if (r !== null) parts.push(r);
      }

      if (closeIdx !== -1) {
        parts.push(renderBlockMath(after.slice(0, closeIdx)));
        const rest = after.slice(closeIdx + 2);
        if (rest.trim()) {
          const r = this.renderLine(rest);
          if (r !== null) parts.push(r);
        }
      } else {
        this.inBlockMath = true;
        this.blockMathLines = [after];
      }
      return parts.length ? parts.join("\n") : null;
    }

    // 3. Tables (must come before inline math so $-substitutions don't fire
    //    inside table cells before we know it IS a table — renderTable
    //    handles inline rendering of cell contents itself).
    if (isTableRow(line)) {
      if (this.tableBuf.length > 0) {
        this.tableBuf.push(line);
        return null;
      }
      if (this.pendingRow !== null) {
        if (isTableSeparator(line)) {
          this.tableBuf.push(this.pendingRow, line);
          this.pendingRow = null;
          return null;
        }
        // Two consecutive row-shaped lines but the second isn't a separator —
        // not a table. Emit both as ordinary lines.
        const a = this.renderLeafLine(this.pendingRow);
        const b = this.renderLeafLine(line);
        this.pendingRow = null;
        return a + "\n" + b;
      }
      this.pendingRow = line;
      return null;
    }
    // Non-row line — flush any pending table state before rendering it.
    const tablePrefix = this.flushPendingTable();

    // 4. Horizontal rule — three or more -, *, or _ on a line by themselves.
    //    Bullet check below requires `\s+` after the marker, so `---` doesn't
    //    accidentally match as a bullet.
    if (/^\s*[-*_]{3,}\s*$/.test(line)) {
      const cols = process.stdout.columns ?? 80;
      const width = Math.max(8, Math.min(cols - 2, 80));
      return tablePrefix + DIM + "─".repeat(width) + RESET;
    }

    // 5. Inline math $...$
    line = replaceInlineMath(line);

    // 6. Heading / bullet / inline (the "leaf" formats)
    return tablePrefix + this.renderLeafLine(line);
  }

  private renderLeafLine(line: string): string {
    if (/^#{1,6}\s+\S/.test(line)) {
      return BOLD + MAGENTA + line + RESET;
    }
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bulletMatch) {
      return `${bulletMatch[1]}${DIM}•${RESET} ${inline(bulletMatch[2])}`;
    }
    return inline(line);
  }
}

// ─── Tables ──────────────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  // Need at least one inner pipe (so at least one cell boundary).
  return (t.match(/\|/g) ?? []).length >= 2;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  const inner = t.slice(1, -1);
  // Each inner cell is only -, :, or whitespace, with at least one - per cell.
  return inner.split("|").every((c) => /^\s*:?-{2,}:?\s*$/.test(c));
}

type Align = "left" | "right" | "center";

function parseRow(row: string): string[] {
  let r = row.trim();
  if (r.startsWith("|")) r = r.slice(1);
  if (r.endsWith("|")) r = r.slice(0, -1);
  return r.split("|").map((c) => c.trim());
}

function alignmentsFromSeparator(sep: string): Align[] {
  return parseRow(sep).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function pad(text: string, width: number, align: Align): string {
  // visualLength strips ANSI sequences before measuring so cells with bold/
  // inline-code escapes still align properly.
  const visible = visualLength(text);
  if (visible >= width) return text;
  const space = width - visible;
  if (align === "right") return " ".repeat(space) + text;
  if (align === "center") {
    const l = Math.floor(space / 2);
    return " ".repeat(l) + text + " ".repeat(space - l);
  }
  return text + " ".repeat(space);
}

function visualLength(s: string): number {
  // Strip ANSI CSI escapes (\x1b[...m), then return code-point count.
  return [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
}

function renderTable(rows: string[]): string {
  if (rows.length < 2) return rows.join("\n");
  const header = parseRow(rows[0]);
  const separator = rows[1];
  const data = rows.slice(2).map(parseRow);
  const aligns = alignmentsFromSeparator(separator);
  const ncols = header.length;

  // Pre-render every cell through inline() so backticks/bold inside cells
  // get colored. Then compute widths from the visible (ANSI-stripped) length.
  const renderedHeader = header.map((c) => inline(c));
  const renderedData = data.map((r) =>
    Array.from({ length: ncols }, (_, i) => inline(r[i] ?? "")),
  );
  const widths = new Array<number>(ncols).fill(0);
  const considerRow = (cells: string[]) => {
    for (let i = 0; i < ncols; i++) {
      const w = visualLength(cells[i] ?? "");
      if (w > widths[i]) widths[i] = w;
    }
  };
  considerRow(renderedHeader);
  for (const r of renderedData) considerRow(r);

  const gap = "  "; // two spaces between columns
  const lines: string[] = [];

  // Header (bold)
  lines.push(
    renderedHeader
      .map((c, i) => pad(BOLD + c + RESET, widths[i], aligns[i] ?? "left"))
      .join(gap),
  );
  // Separator (dim ─ matching widths)
  lines.push(
    DIM + widths.map((w) => "─".repeat(Math.max(1, w))).join(gap) + RESET,
  );
  // Data rows
  for (const r of renderedData) {
    lines.push(
      r.map((c, i) => pad(c, widths[i], aligns[i] ?? "left")).join(gap),
    );
  }
  return lines.join("\n");
}

/** Replace $...$ pairs with dimmed Unicode math. */
function replaceInlineMath(line: string): string {
  return line.replace(/\$(.+?)\$/g, (_full: string, math: string) => {
    return DIM + toUnicode(math) + RESET;
  });
}

/** Render a block-math body (may be multi-line), indented and dimmed. */
function renderBlockMath(latex: string): string {
  const unicode = toUnicode(latex);
  const lines = unicode.split("\n");
  const prefix = "    "; // 4-space indent
  return lines.map((l) => prefix + DIM + l + RESET).join("\n");
}

function inline(line: string): string {
  return line
    .replace(/`([^`\n]+)`/g, `${CYAN}$1${RESET}`)
    .replace(/\*\*([^*\n]+?)\*\*/g, `${BOLD}$1${RESET}`);
}
