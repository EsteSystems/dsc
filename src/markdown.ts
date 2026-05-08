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
    let out = "";
    if (this.inBlockMath && this.blockMathLines.length) {
      out += renderBlockMath(this.blockMathLines.join("\n")) + "\n";
      this.inBlockMath = false;
      this.blockMathLines = [];
    }
    if (this.lineBuf) {
      out += this.renderLine(this.lineBuf);
      this.lineBuf = "";
    }
    return out;
  }

  private renderLine(line: string): string {
    // 1. Code fences
    if (/^\s*```/.test(line)) {
      this.inFence = !this.inFence;
      return DIM + line + RESET;
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
        return after.trim() ? block + "\n" + this.renderLine(after) : block;
      }
      this.blockMathLines.push(line);
      return "";
    }

    // Opening $$ — may be alone or paired on the same line
    const openIdx = line.indexOf("$$");
    if (openIdx !== -1) {
      const before = line.slice(0, openIdx);
      const after = line.slice(openIdx + 2);
      const closeIdx = after.indexOf("$$");
      const parts: string[] = [];
      if (before.trim()) parts.push(this.renderLine(before));

      if (closeIdx !== -1) {
        // Single-line block math
        parts.push(renderBlockMath(after.slice(0, closeIdx)));
        const rest = after.slice(closeIdx + 2);
        if (rest.trim()) parts.push(this.renderLine(rest));
      } else {
        // Multi-line block math starts here
        this.inBlockMath = true;
        this.blockMathLines = [after];
      }
      return parts.join("\n") || "";
    }

    // 3. Inline math $...$
    line = replaceInlineMath(line);

    // 4. Headings
    if (/^#{1,6}\s+\S/.test(line)) {
      return BOLD + MAGENTA + line + RESET;
    }

    // 5. Bullet list markers
    const bulletMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bulletMatch) {
      return `${bulletMatch[1]}${DIM}•${RESET} ${inline(bulletMatch[2])}`;
    }

    return inline(line);
  }
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
