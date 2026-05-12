import React from "react";
import { Box } from "ink";
import { History } from "./History.js";
import { CurrentTurn } from "./CurrentTurn.js";
import { TaskLine } from "./TaskLine.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { StatusBar } from "./StatusBar.js";
import { PromptInput } from "./PromptInput.js";

interface AppProps {
  onSubmit: (text: string) => void;
}

export function App({ onSubmit }: AppProps) {
  return (
    <Box flexDirection="column">
      <History />
      <CurrentTurn />
      <TaskLine />
      <ApprovalDialog />
      <PromptInput onSubmit={onSubmit} />
      <StatusBar />
    </Box>
  );
}
