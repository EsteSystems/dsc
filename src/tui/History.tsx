import React from "react";
import { Box, Static, Text } from "ink";
import type { UIMessage } from "../store.js";
import { useStore } from "./useStore.js";
import { Markdown } from "./Markdown.js";

// Finalized messages pushed into <Static> render exactly once each, then
// scroll into terminal scrollback like any normal stdout output — meaning
// they're selectable and copy/paste-able.
export function History() {
  const history = useStore((s) => s.history);
  return (
    <Static items={history}>
      {(m) => <MessageRow key={m.id} message={m} />}
    </Static>
  );
}

interface MessageRowProps {
  message: UIMessage;
  /** Kept for callers that want to opt out of rich rendering during
   *  streaming (none currently). The default — render Markdown through
   *  the live turn — relies on Markdown's React.memo to skip re-parse
   *  when source is unchanged between ticks. */
  streaming?: boolean;
}

export function MessageRow({ message: m, streaming = false }: MessageRowProps) {
  if (m.role === "tool") {
    const label = m.tool_name ? `← ${m.tool_name}` : "← tool";
    return (
      <Box marginBottom={1}>
        <Text dimColor>
          {label}: {toolTruncate(m.content, 600)}
        </Text>
      </Box>
    );
  }
  if (m.role === "system") {
    // Errors get red; everything else (slash-command output, notices) goes
    // dim so it reads like the REPL's status/info lines rather than a bold
    // header.
    const isError = /^(error|API error|\(interrupted)/i.test(m.content);
    return (
      <Box marginBottom={1}>
        <Text color={isError ? "red" : undefined} dimColor={!isError}>
          {m.content}
        </Text>
      </Box>
    );
  }
  if (m.role === "user") {
    // Highlight the prompt with a subtly different background — no role
    // label, no header. Each physical line is its own Text so the bg color
    // paints behind every line independently (a single Text containing
    // newlines doesn't keep the bg across the break in most terminals).
    const lines = m.content.split("\n");
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Text key={i} backgroundColor="blackBright">
            {" "}
            {line}
            {" "}
          </Text>
        ))}
      </Box>
    );
  }
  const isAssistant = m.role === "assistant";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="magenta">
        {m.role}
      </Text>
      {m.reasoning ? (
        // Render reasoning as its own labeled block: a dim "thinking"
        // header with the body indented two columns and styled italic
        // dim. Sits between the assistant label and the answer so the
        // user can skim past it once they trust the model on a task.
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>thinking</Text>
          <Box marginLeft={2}>
            <Text dimColor italic>
              {m.reasoning}
            </Text>
          </Box>
        </Box>
      ) : null}
      {isAssistant && m.content ? (
        // Always render through Markdown — even during streaming. The
        // previous "wait for a blank line before any rich render" rule
        // was too conservative: most assistant turns don't emit a blank
        // line until very late, so users saw plain text the whole time
        // and rich rendering only on finalize. With React.memo on the
        // Markdown component, the parse + ink reconcile only happen
        // when `source` changes (i.e. when a chunk arrives), not on
        // every parent re-render (spinner tick, status sync). Partial
        // markdown markers (open **, half-typed ```) render as literal
        // text and snap to formatted once they pair — brief flicker on
        // those characters in exchange for rich rendering throughout.
        <Markdown source={m.content} />
      ) : m.content ? (
        <Text>{m.content}</Text>
      ) : null}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// Tool-result truncation. The model sees the full output (it's stored as
// the tool message's content); the TUI just renders a head slice so the
// dynamic frame stays readable. The marker explains the gap so the user
// knows nothing was silently lost from the model's perspective.
function toolTruncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  const omittedChars = s.length - maxChars;
  const omittedLines = s.slice(maxChars).split("\n").length - 1;
  const lineHint = omittedLines > 0 ? ` / ${omittedLines} more lines` : "";
  return `${head}\n… (${omittedChars} more chars${lineHint}, full output sent to model)`;
}
