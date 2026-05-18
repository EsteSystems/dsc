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
  /** Currently-streaming message — render finalized paragraphs through
   *  Markdown, leave the in-progress tail (the paragraph still being
   *  typed) as plain text so mid-construct markers (half-typed **, an
   *  open ```) don't cause flicker as the parser flips interpretation
   *  on each chunk. */
  streaming?: boolean;
}

/**
 * Split `content` at the last blank line that isn't inside a code fence.
 * Lines before that point are "stable" (no more characters will arrive in
 * those paragraphs); lines after it are the tail still being streamed.
 *
 * Splitting on blank lines is safe because every markdown block-level
 * construct (paragraph, heading, list block, blockquote, table) is
 * terminated by one — so anything before the last blank is a complete
 * block the parser can render without surprises. Mid-line edits within
 * the tail are kept as plain text until they're "committed" by a blank
 * line, at which point they shift into the stable prefix on the next
 * chunk.
 */
function splitStableTail(content: string): { stable: string; tail: string } {
  const lines = content.split("\n");
  let inFence = false;
  let lastBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && lines[i].trim() === "") lastBlank = i;
  }
  if (lastBlank < 0) return { stable: "", tail: content };
  return {
    stable: lines.slice(0, lastBlank + 1).join("\n"),
    tail: lines.slice(lastBlank + 1).join("\n"),
  };
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
        streaming ? (
          // Streaming: render stable paragraphs through Markdown (memoized
          // — the parse only re-runs when `stable` changes), keep the
          // still-streaming tail as plain Text so partial markers don't
          // flicker.
          (() => {
            const { stable, tail } = splitStableTail(m.content);
            return (
              <>
                {stable ? <Markdown source={stable} /> : null}
                {tail ? <Text>{tail}</Text> : null}
              </>
            );
          })()
        ) : (
          <Markdown source={m.content} />
        )
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
