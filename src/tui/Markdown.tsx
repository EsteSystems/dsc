import React from "react";
import { Box, Text } from "ink";

// Minimal markdown → ink Text-tree renderer. Handles the subset that's
// actually common in assistant output: headings, paragraphs, inline code,
// fenced code blocks, **bold**, *italic*, `code`, [link](url), `- ` lists,
// `> ` blockquotes. Anything not recognized falls through as plain text,
// so worst-case the user just sees the literal source — never an error.
//
// We intentionally don't pull in `marked` or similar — those produce HTML
// or ANSI strings, neither of which ink's Text component renders. A small
// purpose-built parser also lets us memoize per-source so streaming
// re-renders skip the parse when source hasn't changed.

// ── Syntax highlighting tables ──────────────────────────────────────────
// Compact keyword strings (split to Set at module-load time) + comment
// styles. Unrecognised languages fall through to flat cyan.

const KW_RAW: Record<string, string> = {
  ts:  "const let var function return if else for while do class interface type enum namespace module import export from default async await try catch throw new extends implements typeof instanceof in of as keyof infer is true false null undefined void never any unknown string number boolean symbol bigint readonly abstract static public private protected break continue switch case yield",
  py:  "def class return if elif else for while try except finally with as import from raise yield lambda pass break continue and or not in is True False None async await global nonlocal assert del",
  sh:  "if then else elif fi for while do done in case esac function return local export alias unset source echo exit break continue eval exec shift read declare",
  rs:  "fn let mut const return if else for while loop match impl struct enum trait type use mod pub crate self super where as in ref move async await true false Some None Ok Err unsafe extern static dyn box",
  go:  "func return if else for range var const type struct interface map chan go select case default defer package import true false nil break continue fallthrough switch make new append len cap close delete panic recover",
  java:"class interface enum extends implements package import public private protected static final abstract synchronized volatile transient native return if else for while do switch case default break continue throw try catch finally new this super true false null void int long float double boolean char byte short String",
  c:   "if else for while do switch case default break continue return goto struct union enum typedef sizeof static extern const volatile register auto signed unsigned int char float double void long short true false NULL",
  sql: "SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER ON AND OR NOT IN LIKE BETWEEN IS NULL AS ORDER BY GROUP HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW UNION ALL DISTINCT CASE WHEN THEN ELSE END EXISTS COUNT SUM AVG MIN MAX ASC DESC PRIMARY KEY FOREIGN REFERENCES CASCADE DEFAULT UNIQUE CONSTRAINT",
};

const KW: Record<string, Set<string>> = {};
for (const [lang, s] of Object.entries(KW_RAW)) {
  KW[lang] = new Set(s.split(/\s+/));
}

interface CommentStyle { lc?: string; bc?: [string, string] }
const COMMENT: Record<string, CommentStyle> = {
  ts: { lc: "//", bc: ["/*", "*/"] },
  py: { lc: "#" },
  sh: { lc: "#" },
  rs: { lc: "//", bc: ["/*", "*/"] },
  go: { lc: "//", bc: ["/*", "*/"] },
  java:{ lc: "//", bc: ["/*", "*/"] },
  c:   { lc: "//", bc: ["/*", "*/"] },
  sql: { lc: "--", bc: ["/*", "*/"] },
  yaml:{ lc: "#" },
  css: { bc: ["/*", "*/"] },
};

const LANG_ALIAS: Record<string, string> = {
  js: "ts", jsx: "ts", tsx: "ts", mjs: "ts", cjs: "ts",
  bash: "sh", zsh: "sh",
  cpp: "c", cc: "c", cxx: "c", hpp: "c", h: "c",
  rb: "py", python: "py",
  rust: "rs",
  yml: "yaml",
  scss: "css", less: "css",
  kt: "java", kotlin: "java",
  dockerfile: "sh", toml: "sh",
};

function resolveLang(lang: string): string | null {
  const l = lang.toLowerCase();
  const base = LANG_ALIAS[l] ?? l;
  return KW[base] || COMMENT[base] ? base : null;
}

export function hasSyntax(lang: string): boolean {
  return resolveLang(lang) !== null;
}

interface Props {
  source: string;
}

const TABLE_MAX_ROWS = 20;
const TABLE_MAX_CELL_CHARS = 40;

// React.memo on `source`: when the parent re-renders (e.g. every chunk
// of a streaming turn) but the source we're handed hasn't changed, skip
// the parse + ink tree rebuild entirely. The streaming pipeline relies
// on this — the "stable" prefix passed in is unchanged for many chunks
// in a row, only updated when a paragraph finishes.
export const Markdown = React.memo(function Markdown({ source }: Props) {
  const blocks = parseBlocks(source);
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </>
  );
});

export type ParsedBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "quote"; lines: string[] }
  | { kind: "table"; rows: string[][] }
  | { kind: "paragraph"; text: string }
  | { kind: "blank" };

const isTableRow = (l: string): boolean => {
  const t = l.trim();
  return t.length >= 3 && t.startsWith("|") && t.endsWith("|");
};
const isTableSeparator = (l: string): boolean =>
  /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(l);

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function parseCellEmphasis(raw: string): { bold: boolean; text: string } {
  // Only recognize the simple "whole-cell bold" pattern. Anything fancier
  // (e.g. partial-cell emphasis) keeps the literal markers — width math
  // would diverge from visible length and the column would skew.
  const m = raw.match(/^\*\*(.+)\*\*$/);
  if (m) return { bold: true, text: m[1] };
  return { bold: false, text: raw };
}

export function parseBlocks(src: string): ParsedBlock[] {
  const lines = src.split(/\r?\n/);
  const out: ParsedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block: ``` or ```lang. Collect until matching fence.
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing ```
      out.push({ kind: "code", lang, lines: body });
      continue;
    }
    // ATX heading: #, ##, ... (up to 6).
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    // Blockquote run: consecutive `> ` lines.
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", lines: body });
      continue;
    }
    // Table: header row + separator + zero or more data rows. Recognized by
    // the second line being a separator (|---|---|...) — without that we'd
    // mis-classify any text that happens to start with `|`.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [parseTableRow(line)];
      i += 2; // skip header + separator
      while (i < lines.length && isTableRow(lines[i])) {
        if (!isTableSeparator(lines[i])) rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push({ kind: "table", rows });
      continue;
    }
    // Bulleted or numbered list: consecutive lines starting with `-`/`*`/`+ ` or `N. `.
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && /^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""));
        i++;
      }
      out.push({ kind: "list", items, ordered });
      continue;
    }
    // Blank line.
    if (line.trim() === "") {
      out.push({ kind: "blank" });
      i++;
      continue;
    }
    // Paragraph: collect contiguous non-special lines.
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}

function Block({ block }: { block: ParsedBlock }) {
  if (block.kind === "blank") {
    return <Text> </Text>;
  }
  if (block.kind === "heading") {
    const color = block.level <= 2 ? "cyan" : "magenta";
    return (
      <Box>
        <Text bold color={color}>
          {"#".repeat(block.level)} {block.text}
        </Text>
      </Box>
    );
  }
  if (block.kind === "code") {
    const langOk = hasSyntax(block.lang);
    return (
      <Box flexDirection="column" marginY={0}>
        {block.lang ? (
          <Text dimColor>```{block.lang}</Text>
        ) : (
          <Text dimColor>```</Text>
        )}
        {langOk
          ? block.lines.map((l, i) => (
              <Text key={i}>
                {"  "}
                {highlightLine(l, resolveLang(block.lang)!)}
              </Text>
            ))
          : block.lines.map((l, i) => (
              <Text key={i} color="cyan">
                {"  "}
                {l}
              </Text>
            ))}
        <Text dimColor>```</Text>
      </Box>
    );
  }
  if (block.kind === "quote") {
    return (
      <Box flexDirection="column">
        {block.lines.map((l, i) => (
          <Box key={i}>
            <Text dimColor>│ </Text>
            <Text dimColor italic>
              <Inline source={l} />
            </Text>
          </Box>
        ))}
      </Box>
    );
  }
  if (block.kind === "table") {
    // Strip simple **bold** wrappers from each cell so the markers don't
    // appear as literal text. Width measurement uses the stripped length so
    // columns line up regardless of how many cells were emphasized.
    const parsed = block.rows.map((r) => r.map(parseCellEmphasis));
    // Cap cell content so a pathological one-liner can't push a table to
    // hundreds of terminal columns. The full text stays available in the
    // terminal scrollback via the original message; only the rendered row
    // is clipped.
    const cellText = (raw: string): string =>
      raw.length > TABLE_MAX_CELL_CHARS
        ? raw.slice(0, TABLE_MAX_CELL_CHARS - 1) + "…"
        : raw;
    const shown = parsed.slice(0, TABLE_MAX_ROWS);
    const cols = Math.max(...shown.map((r) => r.length));
    const widths = new Array(cols).fill(0);
    for (const r of shown) {
      for (let j = 0; j < r.length; j++) {
        widths[j] = Math.max(widths[j], cellText(r[j].text).length);
      }
    }
    return (
      <Box flexDirection="column">
        {shown.map((row, i) => (
          // Render the row as one Text node (not a nested Box) so each row
          // occupies exactly one terminal line and there's no flexbox-driven
          // gap between rows. Bold spans inside the row are emitted as
          // inline <Text bold> children — ink composes them into a single
          // styled string. Header row gets bold for the whole line.
          <Text key={i} bold={i === 0}>
            {row.map((cell, j) => {
              // Pad to column width to keep the columns aligned, EXCEPT on
              // the final cell — trailing spaces past the last visible
              // character would push the line over the terminal width, ink
              // would wrap them onto a new line, and that line would render
              // as a phantom blank between rows.
              const display = cellText(cell.text);
              const isLast = j === row.length - 1;
              const pad = isLast
                ? ""
                : " ".repeat(Math.max(0, widths[j] - display.length));
              const sep = isLast ? "" : " │ ";
              return (
                <Text key={j}>
                  <Text bold={cell.bold}>{display}</Text>
                  {pad}
                  {sep}
                </Text>
              );
            })}
          </Text>
        ))}
        {parsed.length > TABLE_MAX_ROWS ? (
          <Text dimColor>… ({parsed.length - TABLE_MAX_ROWS} more table rows)</Text>
        ) : null}
      </Box>
    );
  }
  if (block.kind === "list") {
    return (
      <Box flexDirection="column">
        {block.items.map((it, i) => (
          <Box key={i}>
            <Text dimColor>{block.ordered ? `${i + 1}. ` : "• "}</Text>
            <Text>
              <Inline source={it} />
            </Text>
          </Box>
        ))}
      </Box>
    );
  }
  return (
    <Box>
      <Text>
        <Inline source={block.text} />
      </Text>
    </Box>
  );
}

// ── Syntax highlighting ─────────────────────────────────────────────────

/** Scan `line` and return styled spans for the given language's tokens.
 *  Unrecognised languages never reach here (caller checks hasSyntax first).
 *  Uses a single left-to-right pass with a plain-text buffer: keywords
 *  (blue bold), numbers (yellow), strings (green), comments (dim italic). */
function highlightLine(line: string, lang: string): React.ReactNode[] {
  const kw = KW[lang];
  const cmt = COMMENT[lang] ?? {};
  const lc = cmt.lc;
  const [bo, bc] = cmt.bc ?? [];

  const out: React.ReactNode[] = [];
  let plain = "";
  const flush = () => { if (plain) { out.push(plain); plain = ""; } };

  let i = 0;
  while (i < line.length) {
    // Line comment — consume rest of line
    if (lc && line.startsWith(lc, i)) {
      flush();
      out.push(<Text key={out.length} dimColor italic>{line.slice(i)}</Text>);
      return out;
    }
    // Block comment
    if (bo && bc && line.startsWith(bo, i)) {
      const end = line.indexOf(bc, i + bo.length);
      if (end !== -1) {
        flush();
        out.push(<Text key={out.length} dimColor italic>{line.slice(i, end + bc.length)}</Text>);
        i = end + bc.length;
        continue;
      }
    }
    // String: "..." or '...'
    if (line[i] === '"' || line[i] === "'") {
      const end = findQuoteEnd(line, i, line[i]);
      if (end !== -1) {
        flush();
        out.push(<Text key={out.length} color="green">{line.slice(i, end + 1)}</Text>);
        i = end + 1;
        continue;
      }
    }
    // Template literal: `...`
    if (line[i] === '`') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '`') break;
        j++;
      }
      if (j < line.length) {
        flush();
        out.push(<Text key={out.length} color="green">{line.slice(i, j + 1)}</Text>);
        i = j + 1;
        continue;
      }
    }
    // Number (must start on a word boundary — not mid-identifier like foo123)
    if (i === 0 || !/\w/.test(line[i - 1])) {
      const m = line.slice(i).match(/^(0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/);
      if (m) {
        flush();
        out.push(<Text key={out.length} color="yellow">{m[0]}</Text>);
        i += m[0].length;
        continue;
      }
    }
    // Keyword (must start on a word boundary)
    if (kw && (i === 0 || !/\w/.test(line[i - 1]))) {
      const m = line.slice(i).match(/^[a-zA-Z_]\w*/);
      if (m && kw.has(m[0])) {
        flush();
        out.push(<Text key={out.length} color="blue" bold>{m[0]}</Text>);
        i += m[0].length;
        continue;
      }
    }
    // Plain character
    plain += line[i];
    i++;
  }
  flush();
  return out;
}

/** Find the closing quote for a string starting at `start` with `quote`,
 *  skipping backslash-escaped characters. Returns -1 if unclosed. */
function findQuoteEnd(line: string, start: number, quote: string): number {
  let j = start + 1;
  while (j < line.length) {
    if (line[j] === '\\') { j += 2; continue; }
    if (line[j] === quote) return j;
    j++;
  }
  return -1;
}

// ── Inline markdown parser ──────────────────────────────────────────────

// Inline span parser: scans the string left-to-right and emits styled spans
// for **bold**, *italic*, `code`, [text](url). The unambiguous markers are
// chosen for predictability — markdown's full inline grammar is famously
// fiddly, so we keep this dumb-but-deterministic.
function Inline({ source }: { source: string }) {
  const parts = parseInline(source);
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === "string") return p;
        if (p.kind === "bold") return <Text key={i} bold>{p.text}</Text>;
        if (p.kind === "italic") return <Text key={i} italic>{p.text}</Text>;
        if (p.kind === "code")
          return (
            <Text key={i} color="cyan" dimColor>
              {"`"}{p.text}{"`"}
            </Text>
          );
        if (p.kind === "link")
          return (
            <Text key={i} color="cyan" underline>
              {p.text}
              {p.href ? <Text dimColor> ({p.href})</Text> : null}
            </Text>
          );
        return null;
      })}
    </>
  );
}

type InlineSpan =
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

function parseInline(src: string): (string | InlineSpan)[] {
  const out: (string | InlineSpan)[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length) {
      out.push(buf);
      buf = "";
    }
  };
  let i = 0;
  while (i < src.length) {
    // Greedy **bold** before *italic*.
    if (src.startsWith("**", i)) {
      const close = src.indexOf("**", i + 2);
      if (close !== -1) {
        flush();
        out.push({ kind: "bold", text: src.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    if (src[i] === "*" && src[i + 1] !== "*" && src[i + 1] !== " ") {
      const close = src.indexOf("*", i + 1);
      if (close !== -1) {
        flush();
        out.push({ kind: "italic", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (src[i] === "[") {
      const closeBracket = src.indexOf("]", i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === "(") {
        const closeParen = src.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          flush();
          out.push({
            kind: "link",
            text: src.slice(i + 1, closeBracket),
            href: src.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }
    buf += src[i];
    i++;
  }
  flush();
  return out;
}
