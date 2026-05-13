import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { Input } from "./Input.js";
import { useStore } from "./useStore.js";

interface Props {
  onSubmit: (text: string) => void;
  /** Past submissions for arrow-up recall, oldest-first. */
  history?: string[];
}

export function PromptInput({ onSubmit, history }: Props) {
  const busy = useStore((s) => s.busy);
  const approval = useStore((s) => s.approval);
  const [value, setValue] = useState("");
  // Accumulated prior lines from backslash-continuation. Rendered dimly
  // above the active input so the user sees the running buffer.
  const [buffer, setBuffer] = useState<string[]>([]);

  // When an approval is pending, ApprovalDialog owns the keyboard. We still
  // mount the input so the prompt visually stays put, but disable submit.
  const blocked = !!approval;
  const continuing = buffer.length > 0;

  // ESC clears an in-progress multiline buffer. Gated to non-busy/non-approval
  // so it doesn't fight with the abort and approval-dialog handlers.
  useInput(
    (_input, key) => {
      if (key.escape && continuing) {
        setBuffer([]);
        setValue("");
      }
    },
    { isActive: !blocked && !busy && continuing },
  );

  const handleSubmit = (v: string) => {
    if (blocked) return;
    // Bash-style continuation: odd number of trailing backslashes means
    // "keep going on the next line" — strip the final backslash, push the
    // rest into the buffer, clear the input. Even count (e.g. \\) is a
    // literal trailing backslash and the line submits.
    const trailing = (v.match(/\\+$/) || [""])[0].length;
    if (trailing % 2 === 1) {
      setBuffer((b) => [...b, v.slice(0, -1)]);
      setValue("");
      return;
    }
    const full = [...buffer, v].join("\n").trim();
    setBuffer([]);
    setValue("");
    if (!full) return;
    onSubmit(full);
  };

  const promptChar = blocked
    ? "? "
    : continuing
      ? "… "
      : busy
        ? "… "
        : "> ";
  const promptColor = blocked ? "gray" : busy || continuing ? "yellow" : "green";

  return (
    <Box flexDirection="column">
      {buffer.map((line, i) => (
        <Box key={i}>
          <Text dimColor>… </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      <Box>
        <Text bold color={promptColor}>
          {promptChar}
        </Text>
        <Input
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          focus={!blocked}
          history={history}
        />
      </Box>
    </Box>
  );
}
