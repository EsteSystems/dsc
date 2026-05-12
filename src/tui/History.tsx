import React from "react";
import { Box, Static, Text } from "ink";
import type { UIMessage } from "../store.js";
import { useStore } from "./useStore.js";

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

export function MessageRow({ message: m }: { message: UIMessage }) {
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
  const labelColor =
    m.role === "user" ? "cyan" : m.role === "system" ? "red" : "magenta";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={labelColor}>
        {m.role}
      </Text>
      {m.reasoning ? (
        <Text dimColor italic>
          {m.reasoning}
        </Text>
      ) : null}
      {m.content ? <Text>{m.content}</Text> : null}
    </Box>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
