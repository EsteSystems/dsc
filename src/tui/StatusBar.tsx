import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { useStore } from "./useStore.js";
import { modelSpec } from "../api.js";

// Braille-block spinner — same shape Ora/cli-spinners use. Each entry is a
// single column wide so it doesn't shift the status-bar layout per tick.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// StatusBar is the only component that intentionally mirrors many fields at
// once. Subscribing with these keys means task-list updates (which only touch
// `agentTasks`) don't wake it — the task list re-renders alone.
const STATUS_KEYS = [
  "model",
  "yolo",
  "reasoning",
  "compacted",
  "cacheHitTokens",
  "cacheMissTokens",
  "lastPromptTokens",
  "contextTokens",
  "cost",
  "inTokens",
  "outTokens",
  "queueDepth",
  "busy",
  "task",
  "sessionSeconds",
];

function useSpinnerFrame(active: boolean): string | null {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);
  return active ? SPINNER_FRAMES[frame] : null;
}

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
  const s = useStore((x) => x, Object.is, STATUS_KEYS);
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  const spinner = useSpinnerFrame(s.busy);

  const flags =
    (s.yolo ? " yolo" : "") +
    (!s.reasoning ? " no-reasoning" : "") +
    (s.compacted ? " compacted" : "");
  const cache =
    s.cacheHitTokens > 0 || s.cacheMissTokens > 0
      ? ` (h:${formatCount(s.cacheHitTokens)} m:${formatCount(s.cacheMissTokens)})`
      : "";

  const ctxWindow = modelSpec(s.model).contextWindow;
  // Prefer the API-reported last request size; it includes the system prompt,
  // tool schemas, and provider-injected content that the local char/4
  // estimate misses. Until the first response arrives, fall back to the
  // estimate and mark it approximate.
  const ctxTokens = s.lastPromptTokens > 0 ? s.lastPromptTokens : s.contextTokens;
  const ctxApproximate = s.lastPromptTokens <= 0;
  const ctxPct = ctxWindow ? Math.round((ctxTokens / ctxWindow) * 100) : null;
  const ctxLabel =
    ctxWindow && ctxPct !== null
      ? `${ctxApproximate ? "~ctx:" : "ctx:"}${formatCount(ctxTokens)}/${formatCount(ctxWindow)} (${ctxPct}%)`
      : `${ctxApproximate ? "~ctx:" : "ctx:"}${formatCount(ctxTokens)}`;
  // Color the ctx label when approaching the context window: yellow at 80%,
  // red at 95%. The inverse background swaps fg/bg; these colors stay legible.
  const ctxColor =
    ctxPct !== null && ctxPct >= 95 ? "red"
    : ctxPct !== null && ctxPct >= 80 ? "yellow"
    : undefined;

  const leftBeforeCtx =
    `${s.model}${flags} · ${s.cost.toFixed(4)}  ` +
    `▲${formatCount(s.inTokens)}${cache} ▼${formatCount(s.outTokens)}  `;
  const afterCtx = s.queueDepth > 0 ? `  queued:${s.queueDepth}` : "";
  const fullLeft = leftBeforeCtx + ctxLabel + afterCtx;

  const rightBody = s.busy
    ? s.task
      ? s.task
      : "thinking"
    : formatDuration(s.sessionSeconds);
  const right = spinner ? `${spinner} ${rightBody}` : rightBody;

  // Pad left + right to fill terminal width. Framed by leading + trailing space.
  const inner = Math.max(0, width - 2);
  const rightLen = right.length;

  if (ctxColor) {
    // When ctx is at warning level, render it as a colored span inside the
    // inverse bar. We recompute clipping so the ctx portion stays visible.
    const leftMax = Math.max(0, inner - rightLen - 1);
    let beforeClipped = leftBeforeCtx;
    let ctxClipped = ctxLabel;
    let afterClipped = afterCtx;
    if (fullLeft.length > leftMax) {
      // Clip the left side, keeping ctx as intact as possible
      const overflow = fullLeft.length - leftMax;
      if (overflow >= leftBeforeCtx.length) {
        beforeClipped = leftBeforeCtx.slice(0, Math.max(0, leftBeforeCtx.length - overflow - 1)) + "…";
      } else {
        beforeClipped = leftBeforeCtx.slice(0, Math.max(0, leftBeforeCtx.length - overflow));
      }
      const remaining = leftMax - beforeClipped.length;
      if (remaining < ctxLabel.length) {
        ctxClipped = ctxLabel.slice(0, Math.max(0, remaining - 1)) + "…";
      }
      if (ctxClipped.length + beforeClipped.length < leftMax && afterCtx) {
        afterClipped = afterCtx.slice(0, leftMax - beforeClipped.length - ctxClipped.length);
      }
    }
    const padLen = Math.max(1, inner - beforeClipped.length - ctxClipped.length - afterClipped.length - rightLen);
    return (
      <Box>
        <Text inverse>
          {" "}{beforeClipped}
          <Text color={ctxColor}>{ctxClipped}</Text>
          {afterClipped}
          {" ".repeat(padLen)}{right}{" "}
        </Text>
      </Box>
    );
  }

  // No ctx warning — single-string render as before.
  const leftMax = Math.max(0, inner - rightLen - 1);
  const leftClipped =
    fullLeft.length > leftMax ? fullLeft.slice(0, Math.max(0, leftMax - 1)) + "…" : fullLeft;
  const padCount = Math.max(1, inner - leftClipped.length - rightLen);
  const line = ` ${leftClipped}${" ".repeat(padCount)}${right} `;

  return (
    <Box>
      <Text inverse>{line}</Text>
    </Box>
  );
}
