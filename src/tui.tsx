// Minimal TUI entry — just enough to verify the layout renders and
// PromptInput works. The agent will be wired in the next commit; for now
// submissions just echo into history as user/assistant pairs so we can see
// <Static> doing its job.

import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { getState, setState } from "./store.js";
import { randomUUID } from "node:crypto";

function handleSubmit(text: string) {
  if (text === "/exit" || text === "/quit") {
    process.exit(0);
  }
  // Push as a finalized user message so it goes to <Static>.
  const userMsg = {
    id: "u-" + randomUUID().slice(0, 8),
    role: "user" as const,
    content: text,
  };
  setState({ history: [...getState().history, userMsg] });

  // Echo back as assistant for now — to be replaced by the real agent loop.
  const echoMsg = {
    id: "a-" + randomUUID().slice(0, 8),
    role: "assistant" as const,
    content: `(mock) you said: ${text}`,
  };
  setState((s) => ({ history: [...s.history, echoMsg] }));
}

render(<App onSubmit={handleSubmit} />);
