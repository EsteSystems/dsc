import React from "react";
import { Box, useApp, useInput } from "ink";
import { History } from "./History.js";
import { CurrentTurn } from "./CurrentTurn.js";
import { TaskLine } from "./TaskLine.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { StatusBar } from "./StatusBar.js";
import { PromptInput } from "./PromptInput.js";
import { AgentTaskList } from "./AgentTaskList.js";
import { QueuedPrompts } from "./QueuedPrompts.js";
import { useStore } from "./useStore.js";

interface AppProps {
  onSubmit: (text: string) => void;
  /** Aborts the in-flight agent turn. Called on ESC when busy. */
  onAbort: () => void;
  /** Past submissions, oldest-first; for arrow-up history recall. */
  history?: string[];
}

export function App({ onSubmit, onAbort, history }: AppProps) {
  return (
    <Box flexDirection="column">
      <History />
      <CurrentTurn />
      <AgentTaskList />
      <TaskLine />
      <ApprovalDialog />
      <KeyHandlers onAbort={onAbort} />
      <QueuedPrompts />
      <PromptInput onSubmit={onSubmit} history={history} />
      <StatusBar />
    </Box>
  );
}

// Global keyboard shortcuts. Mounted alongside PromptInput / ApprovalDialog —
// ink's useInput fans out to every subscribed component, so each owner gets
// to react. Approval-active state silences ESC here (the dialog handles ESC
// itself as a "no" answer).
function KeyHandlers({ onAbort }: { onAbort: () => void }) {
  const busy = useStore((s) => s.busy);
  const approvalActive = useStore((s) => s.approval !== null);
  const { exit } = useApp();

  useInput((input, key) => {
    if (approvalActive) return;
    if (key.escape && busy) {
      onAbort();
      return;
    }
    if (key.ctrl && input === "c") {
      // Match readline: abort the running turn first; explicit second press
      // (when idle) exits. Idle Ctrl+C just exits — no double-tap dance,
      // since the dynamic frame makes the "(press again)" hint awkward.
      if (busy) onAbort();
      else {
        exit();
        process.exit(130);
      }
      return;
    }
    if (key.ctrl && input === "d" && !busy) {
      // Ctrl+D on an empty prompt is the standard "I'm done" — TextInput
      // doesn't intercept it, so handle here. We don't gate on prompt
      // emptiness because PromptInput owns that state; in practice users
      // press Ctrl+D when they mean to exit.
      exit();
      process.exit(0);
    }
  });

  return null;
}
