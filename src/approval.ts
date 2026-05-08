import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createPatch } from "diff";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";

function colorize(diffText: string): string {
  return diffText
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return BOLD + line + RESET;
      if (line.startsWith("@@")) return CYAN + line + RESET;
      if (line.startsWith("+")) return GREEN + line + RESET;
      if (line.startsWith("-")) return RED + line + RESET;
      return line;
    })
    .join("\n");
}

type Asker = (question: string) => Promise<string>;
let activeAsker: Asker | null = null;

export function setAsker(fn: Asker | null): void {
  activeAsker = fn;
}

async function ask(question: string): Promise<boolean> {
  let answer: string;
  if (activeAsker) {
    answer = (await activeAsker(question)).trim().toLowerCase();
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      answer = (await rl.question(question)).trim().toLowerCase();
    } finally {
      rl.close();
    }
  }
  return answer === "y" || answer === "yes";
}

export async function confirmWrite(
  path: string,
  oldContent: string,
  newContent: string,
  existed: boolean,
): Promise<boolean> {
  const verb = existed ? "Overwrite" : "Create";
  process.stdout.write(`\n${YELLOW}${verb} ${path}${RESET}\n`);
  if (existed) {
    const patch = createPatch(path, oldContent, newContent, "", "", { context: 3 });
    process.stdout.write(colorize(patch) + "\n");
  } else {
    const preview = newContent.length > 4000 ? newContent.slice(0, 4000) + "\n…(truncated)" : newContent;
    process.stdout.write(`${DIM}--- proposed content (${newContent.length} chars) ---${RESET}\n`);
    process.stdout.write(preview + "\n");
  }
  return ask(`Apply? [y/N] `);
}

export async function confirmEdit(
  path: string,
  oldContent: string,
  newContent: string,
): Promise<boolean> {
  process.stdout.write(`\n${YELLOW}Edit ${path}${RESET}\n`);
  const patch = createPatch(path, oldContent, newContent, "", "", { context: 3 });
  process.stdout.write(colorize(patch) + "\n");
  return ask(`Apply? [y/N] `);
}

export async function confirmBash(command: string, description: string): Promise<boolean> {
  process.stdout.write(`\n${YELLOW}Run shell command${RESET}\n`);
  if (description) process.stdout.write(`${DIM}${description}${RESET}\n`);
  process.stdout.write(`  $ ${command}\n`);
  return ask(`Run? [y/N] `);
}

export async function confirmFetch(url: string): Promise<boolean> {
  process.stdout.write(`\n${YELLOW}Fetch URL${RESET}\n`);
  process.stdout.write(`  ${url}\n`);
  return ask(`Fetch? [y/N] `);
}
