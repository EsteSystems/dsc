import React from "react";
import { useStore } from "./useStore.js";
import { MessageRow } from "./History.js";

// The single in-progress assistant message lives outside <Static> so it
// re-renders on every streamed chunk. Once the agent finalizes the turn,
// the imperative layer moves it into history and clears `current`.
export function CurrentTurn() {
  const current = useStore((s) => s.current);
  if (!current) return null;
  return <MessageRow message={current} />;
}
