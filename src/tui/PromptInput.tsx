import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useStore } from "./useStore.js";

interface Props {
  onSubmit: (text: string) => void;
}

export function PromptInput({ onSubmit }: Props) {
  const busy = useStore((s) => s.busy);
  const approval = useStore((s) => s.approval);
  const [value, setValue] = useState("");

  // When an approval is pending, ApprovalDialog owns the keyboard. We still
  // mount the input so the prompt visually stays put, but disable submit.
  const blocked = !!approval;

  const handleSubmit = (v: string) => {
    if (blocked) return;
    const trimmed = v.trim();
    setValue("");
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Box>
      <Text bold color={blocked ? "gray" : busy ? "yellow" : "green"}>
        {blocked ? "? " : busy ? "… " : "> "}
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        focus={!blocked}
      />
    </Box>
  );
}
