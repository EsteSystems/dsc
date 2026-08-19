import React from "react";
import { Box, Text } from "ink";
import { useStore } from "./useStore.js";
import type { AgentTask } from "../store.js";

// Status glyphs — chosen for parity with Claude Code's task-list look.
// Filled circle for completed, half-filled for in-progress (the only one
// with motion when read), empty for pending.
const ICON: Record<AgentTask["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
};
const COLOR: Record<AgentTask["status"], string> = {
  pending: "gray",
  in_progress: "yellow",
  completed: "green",
};

export function AgentTaskList() {
  const tasks = useStore((s) => s.agentTasks, Object.is, ["agentTasks"]);
  if (tasks.length === 0) return null;
  // Hide once every task is done — the list is meant as a working view, not
  // a finished receipt. The model can still recall via task_list.
  const allDone = tasks.every((t) => t.status === "completed");
  if (allDone) return null;
  return (
    <Box flexDirection="column" marginY={1} paddingX={1}>
      {tasks.map((t) => {
        const label =
          t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject;
        return (
          <Box key={t.id}>
            <Text color={COLOR[t.status]}>{ICON[t.status]}</Text>
            <Text>
              {" "}
              <Text
                color={COLOR[t.status]}
                strikethrough={t.status === "completed"}
                dimColor={t.status === "completed"}
              >
                {label}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
