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

interface Props {
  source: string;
}

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

type ParsedBlock =
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

function parseBlocks(src: string): ParsedBlock[] {
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
    return (
      <Box flexDirection="column" marginY={0}>
        {block.lang ? (
          <Text dimColor>```{block.lang}</Text>
        ) : (
          <Text dimColor>```</Text>
        )}
        {block.lines.map((l, i) => (
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
    const cols = Math.max(...parsed.map((r) => r.length));
    const widths = new Array(cols).fill(0);
    for (const r of parsed) {
      for (let j = 0; j < r.length; j++) {
        widths[j] = Math.max(widths[j], r[j].text.length);
      }
    }
    return (
      <Box flexDirection="column">
        {parsed.map((row, i) => (
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
              const isLast = j === row.length - 1;
              const pad = isLast
                ? ""
                : " ".repeat(Math.max(0, widths[j] - cell.text.length));
              const sep = isLast ? "" : " │ ";
              return (
                <Text key={j}>
                  <Text bold={cell.bold}>{cell.text}</Text>
                  {pad}
                  {sep}
                </Text>
              );
            })}
          </Text>
        ))}
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
