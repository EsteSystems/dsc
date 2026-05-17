import React from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "./useStore.js";
import { setState } from "../store.js";

const MAX_BODY_LINES = 24;

export function ApprovalDialog() {
  const approval = useStore((s) => s.approval);

  useInput(
    (input, key) => {
      if (!approval) return;
      const ch = input.toLowerCase();
      if (ch === "y") {
        approval.resolve("y");
        setState({ approval: null });
      } else if (ch === "a") {
        // Approve this call AND auto-approve future calls of the same tool
        // for the rest of this session. The asker translates "a" to the
        // "always" ApprovalAnswer, and the tool's gateApproval adds the
        // tool name to ctx.sessionApprovals.
        approval.resolve("a");
        setState({ approval: null });
      } else if (ch === "n" || key.escape) {
        approval.resolve("n");
        setState({ approval: null });
      }
    },
    { isActive: approval !== null },
  );

  if (!approval) return null;
  const lines = approval.body ? approval.body.split("\n") : [];
  const overflow = Math.max(0, lines.length - MAX_BODY_LINES);
  const shown = overflow > 0 ? lines.slice(0, MAX_BODY_LINES) : lines;

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
      {shown.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {shown.map((line, i) => (
            <BodyLine key={i} line={line} kind={approval.kind} />
          ))}
          {overflow > 0 ? (
            <Text dimColor>… ({overflow} more line{overflow === 1 ? "" : "s"})</Text>
          ) : null}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{approval.question}[y]es / [n]o (Esc rejects)</Text>
      </Box>
    </Box>
  );
}

// Structural coloring per line. Diff lines get green/red/cyan based on prefix;
// command bodies highlight the `$` prefix; everything else stays default.
// Keeps the body plain text in the store — color is a render concern.
function BodyLine({
  line,
  kind,
}: {
  line: string;
  kind?: "diff" | "preview" | "command" | "url";
}) {
  if (kind === "diff") {
    if (line.startsWith("+++") || line.startsWith("---")) {
      return <Text bold>{line}</Text>;
    }
    if (line.startsWith("@@")) return <Text color="cyan">{line}</Text>;
    if (line.startsWith("+")) return <Text color="green">{line}</Text>;
    if (line.startsWith("-")) return <Text color="red">{line}</Text>;
    return <Text>{line}</Text>;
  }
  if (kind === "command") {
    if (line.startsWith("$ ")) {
      return (
        <Text>
          <Text color="cyan">$</Text> {line.slice(2)}
        </Text>
      );
    }
    return <Text dimColor>{line}</Text>;
  }
  if (kind === "url") return <Text color="cyan">{line}</Text>;
  if (line.startsWith("--- ")) return <Text dimColor>{line}</Text>;
  return <Text>{line}</Text>;
}
