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
  /** Skip markdown parsing for the currently-streaming message — re-parsing
   *  on every chunk would burn CPU and cause flicker. The streamed text
   *  shows raw; once it moves to <Static> it gets the rich rendering. */
  streaming?: boolean;
}

export function MessageRow({ message: m, streaming = false }: MessageRowProps) {
  if (m.role === "tool") {
    const label = m.tool_name ? `← ${m.tool_name}` : "← tool";
    return (
      <Box marginBottom={1}>
        <Text dimColor>
          {label}: {truncate(m.content, 600)}
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
  const renderRich = m.role === "assistant" && !streaming && !!m.content;
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
      {renderRich ? (
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
