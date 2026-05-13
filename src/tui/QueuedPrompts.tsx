import React from "react";
import { Box, Text } from "ink";
import { useStore } from "./useStore.js";

// Renders the type-ahead queue above the prompt input. Each pending line
// is shown dim with a "→" marker, so the user can confirm what's about
// to run after the current turn finishes. Hidden when the queue is empty.
export function QueuedPrompts() {
  const queue = useStore((s) => s.queue);
  if (queue.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>queued ({queue.length}):</Text>
      {queue.map((line, i) => (
        <Box key={i}>
          <Text dimColor>→ </Text>
          <Text dimColor>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}
