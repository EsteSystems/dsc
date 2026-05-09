import { chat, type Message, type Model } from "./api.js";
import type { CompactionState, SessionState } from "./history.js";

const MAX_INPUT_CHARS = 80_000; // hard cap on what we send to the summarizer

const SUMMARIZER_SYSTEM = `You are summarizing an ongoing CLI coding-assistant session for compaction. Produce a concise, plain-prose summary covering: the user's overall goal, key decisions and trade-offs, files touched, the current state of partial work, and any pending tasks. Keep it under ~800 tokens. The summary will be shown to the assistant on future turns; write it as factual session notes, not a story. Do not invent details that aren't in the conversation.`;

export interface CompactResult {
  summary: string;
  turnsRemoved: number;
  /** New messages array — the kept tail. */
  remainingMessages: Message[];
}

/**
 * Pick the index in `messages` where we start KEEPING messages (everything at
 * or after the index is preserved verbatim). We keep the last `keepUserTurns`
 * user-initiated turns and any assistant/tool messages that follow them.
 *
 * Returns -1 when there's nothing worth compacting (fewer user turns than the
 * keep threshold).
 */
export function pickCutpoint(messages: Message[], keepUserTurns: number): number {
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIdxs.push(i);
  }
  if (userIdxs.length <= keepUserTurns) return -1;
  if (keepUserTurns <= 0) return messages.length;
  return userIdxs[userIdxs.length - keepUserTurns];
}

function messageToText(m: Message): string {
  const role = m.role;
  const content = typeof m.content === "string" ? m.content : "";
  if (role === "tool") {
    return `[tool result for ${m.tool_call_id ?? "?"}]: ${truncate(content, 600)}`;
  }
  if (role === "assistant") {
    let out = `[assistant]: ${content || "(no content)"}`;
    if (m.tool_calls && m.tool_calls.length) {
      const calls = m.tool_calls
        .map((t) => `${t.function.name}(${truncate(t.function.arguments, 120)})`)
        .join(", ");
      out += `\n  → called ${calls}`;
    }
    return out;
  }
  if (role === "user") return `[user]: ${content}`;
  return `[${role}]: ${content}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Summarize all messages older than the cutpoint and return the new state.
 * Folds any prior /compact summary into the new one so successive compactions
 * accumulate rather than forget history.
 */
export async function compactSession(
  state: SessionState,
  keepUserTurns: number,
  modelOverride?: Model,
  signal?: AbortSignal,
): Promise<CompactResult | null> {
  const cutAt = pickCutpoint(state.messages, keepUserTurns);
  if (cutAt < 0) return null;

  const toSummarize = state.messages.slice(0, cutAt);
  const remainingMessages = state.messages.slice(cutAt);
  if (toSummarize.length === 0) return null;

  const priorSummary = state.compaction?.summary ?? null;
  const conversationText = toSummarize.map(messageToText).join("\n\n");

  const trimmedConversation =
    conversationText.length > MAX_INPUT_CHARS
      ? conversationText.slice(-MAX_INPUT_CHARS)
      : conversationText;

  const userPrompt =
    (priorSummary
      ? `Previous summary of even older turns (fold this in):\n${priorSummary}\n\n`
      : "") +
    `Conversation to summarize:\n${trimmedConversation}\n\n` +
    `Now produce the updated summary.`;

  const resp = await chat({
    model: modelOverride ?? state.model,
    messages: [
      { role: "system", content: SUMMARIZER_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    signal,
  });

  const content = resp.choices[0]?.message?.content?.trim() ?? "";
  if (!content) return null;

  const compaction: CompactionState = {
    summary: content,
    compacted_at: Date.now(),
    turns_removed: (state.compaction?.turns_removed ?? 0) + countUserTurns(toSummarize),
  };

  return {
    summary: content,
    turnsRemoved: countUserTurns(toSummarize),
    remainingMessages,
  };

  // Note: caller is responsible for assigning state.compaction = {...} since
  // we don't mutate `state` here. The above CompactionState is just to keep
  // the contract clear if we ever want to return it directly.
}

function countUserTurns(messages: Message[]): number {
  return messages.filter((m) => m.role === "user").length;
}
