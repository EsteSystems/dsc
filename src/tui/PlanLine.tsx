import React from "react";
import { Box, Text } from "ink";
import { useStore } from "./useStore.js";

/** Compact one-line plan progress indicator shown above the prompt.
 *  Renders nothing when there's no active plan. */
export function PlanLine() {
  const plan = useStore((s) => s.plan);
  if (!plan) return null;

  const done = plan.tasks.filter((t) => t.done).length;
  const total = plan.tasks.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = plan.tasks.map((t) => (t.done ? "✓" : "◌")).join("");

  return (
    <Box>
      <Text dimColor>plan: </Text>
      <Text>{plan.title}</Text>
      <Text dimColor>  [{bar}] {done}/{total} ({pct}%)</Text>
    </Box>
  );
}
