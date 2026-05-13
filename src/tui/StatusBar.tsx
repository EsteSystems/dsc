import React from "react";
import { Box, Text, useStdout } from "ink";
import { useStore } from "./useStore.js";

function formatCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function StatusBar() {
  const s = useStore((x) => x);
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  const flags =
    (s.yolo ? " yolo" : "") +
    (!s.reasoning ? " no-reasoning" : "") +
    (s.compacted ? " compacted" : "");
  const cache =
    s.cacheHitTokens > 0 || s.cacheMissTokens > 0
      ? ` (h:${formatCount(s.cacheHitTokens)} m:${formatCount(s.cacheMissTokens)})`
      : "";
  const left =
    `${s.model}${flags} · $${s.cost.toFixed(4)}  ` +
    `▲${formatCount(s.inTokens)}${cache} ▼${formatCount(s.outTokens)}  ` +
    `ctx:${formatCount(s.contextTokens)}` +
    (s.queueDepth > 0 ? `  queued:${s.queueDepth}` : "");
  const right = s.busy
    ? s.task
      ? `${s.task}`
      : "thinking"
    : formatDuration(s.sessionSeconds);

  // Pad left + right to fill terminal width so the reverse-video block
  // spans edge-to-edge without wrapping. The rendered line is framed by a
  // single leading + trailing space, so subtract 2 from `width` to leave
  // room for them.
  const inner = Math.max(0, width - 2);
  const rightLen = right.length;
  const leftMax = Math.max(0, inner - rightLen - 1);
  const leftClipped =
    left.length > leftMax ? left.slice(0, Math.max(0, leftMax - 1)) + "…" : left;
  const padCount = Math.max(1, inner - leftClipped.length - rightLen);
  const line = ` ${leftClipped}${" ".repeat(padCount)}${right} `;

  return (
    <Box>
      <Text inverse>{line}</Text>
    </Box>
  );
}
