import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "./useStore.js";
import { setState } from "../store.js";

export function ApprovalDialog() {
  const approval = useStore((s) => s.approval);

  useInput(
    (input, key) => {
      if (!approval) return;
      const ch = input.toLowerCase();
      if (ch === "y") {
        approval.resolve("y");
        setState({ approval: null });
      } else if (ch === "n" || key.escape) {
        approval.resolve("n");
        setState({ approval: null });
      }
    },
    { isActive: approval !== null },
  );

  if (!approval) return null;
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      flexDirection="column"
      marginBottom={1}
    >
      <Text bold color="yellow">
        {approval.title}
      </Text>
      {approval.body ? <Text>{approval.body}</Text> : null}
      <Text dimColor>{approval.question} [y]es / [n]o (Esc rejects)</Text>
    </Box>
  );
}
