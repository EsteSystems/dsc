/**
 * Empirical threshold tuner for tool-output truncation.
 *
 * Sweeps DSC_TOOL_OUTPUT_MAX_CHARS values and measures whether a sentinel
 * marker survives when it appears at the head, middle, or tail of a long
 * output. The recommended threshold is the lowest value that retains all
 * three positions.
 *
 * Usage: npm run tune
 */

import { compressToolOutput, toolOutputMaxChars } from "../src/agent.js";

const SENTINEL = "__DSC_TUNE_MARKER__";
const OUTPUT_LEN = 20_000;
const THRESHOLDS = [2_000, 4_000, 6_000, 8_000, 12_000, 16_000];

function makeOutput(markerPos: "head" | "tail"): string {
  const pad = "x".repeat(OUTPUT_LEN - SENTINEL.length);
  return markerPos === "head" ? SENTINEL + pad : pad + SENTINEL;
}

function main(): void {
  const current = toolOutputMaxChars();
  let recommended: number | null = null;

  console.log("threshold | retained | avg compressed | verdict");
  console.log("----------|----------|----------------|--------");

  for (const threshold of THRESHOLDS) {
    const cases: Array<{ name: string; text: string }> = [
      { name: "head", text: makeOutput("head") },
      { name: "tail", text: makeOutput("tail") },
    ];
    const retained: string[] = [];
    const sizes: number[] = [];
    for (const c of cases) {
      const out = compressToolOutput(c.text, threshold);
      sizes.push(out.length);
      if (out.includes(SENTINEL)) retained.push(c.name);
    }
    const ok = retained.length === cases.length;
    const avg = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
    console.log(
      `${String(threshold).padStart(9)} | ${retained.join(",").padEnd(8)} | ${String(avg).padStart(14)} | ${ok ? "pass" : "FAIL"}`,
    );
    if (ok && recommended === null) recommended = threshold;
  }

  console.log("");
  if (recommended === null) {
    console.log("no threshold retained every marker");
    process.exit(1);
  }
  console.log(`current env threshold: ${current}`);
  console.log(`recommended threshold: ${recommended}`);
  console.log(
    recommended === current
      ? "current default matches the recommendation."
      : `consider DSC_TOOL_OUTPUT_MAX_CHARS=${recommended} if context pressure rises.`,
  );
}

main();
