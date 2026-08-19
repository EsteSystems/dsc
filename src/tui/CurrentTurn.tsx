import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "./useStore.js";
import { MessageRow } from "./History.js";

// Tool results stream into the live turn as they happen, so the default
// rendering collapses them to a short head and lets the user expand the full
// result with Ctrl+O. Once the turn finalizes, the message is pushed into
// <Static> scrollback where the full text is selectable/copyable anyway.
const TOOL_PREVIEW_CHARS = 600;

function LiveToolResult({ content, toolName }: { content: string; toolName?: string }) {
  const [expanded, setExpanded] = useState(false);
  useInput((input, key) => {
    if (key.ctrl && input === "o") setExpanded((v) => !v);
  });
  const label = toolName ? `← ${toolName}` : "← tool";
  const long = content.length > TOOL_PREVIEW_CHARS;
  const shown = expanded || !long
    ? content
    : content.slice(0, TOOL_PREVIEW_CHARS) +
      `\n… (${content.length - TOOL_PREVIEW_CHARS} more chars; Ctrl+O to expand)`;
  return (
    <Box marginBottom={1}>
      <Text dimColor>
        {label}: {shown}
      </Text>
    </Box>
  );
}

// The single in-progress assistant message lives outside <Static> so it
// re-renders on every streamed chunk. Once the agent finalizes the turn,
// the imperative layer moves it into history and clears `current`.
export function CurrentTurn() {
  const current = useStore((s) => s.current);
  if (!current) return null;
  if (current.role === "tool") {
    return <LiveToolResult content={current.content} toolName={current.tool_name} />;
  }
  return <MessageRow message={current} streaming />;
}
