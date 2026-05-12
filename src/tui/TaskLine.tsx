import React from "react";
import { Box, Text } from "ink";
import { useStore } from "./useStore.js";

// One-line indicator for the currently-running tool, e.g. "→ bash(npm test)".
// Shown only while busy AND a tool is in flight.
export function TaskLine() {
  const task = useStore((s) => s.task);
  if (!task) return null;
  return (
    <Box>
      <Text dimColor>→ {task}</Text>
    </Box>
  );
}
