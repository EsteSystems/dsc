/**
 * Protocol types for `dsc serve` — WebSocket daemon ↔ programmatic client.
 *
 * Protocol version 1. All messages are JSON-RPC-like objects with a `type`
 * discriminator. The server never sends more than one JSON message per line
 * (newline-delimited JSON for readability over `wscat`/`websocat`).
 */

// ── Version ─────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = 1;

// ── Server → Client ──────────────────────────────────────────────────

/** Sent immediately after a client connects. */
export interface HelloMsg {
  type: "hello";
  protocol_version: number;
  version: string; // dsc semver
}

/** Streaming assistant response content (text delta). */
export interface TokenMsg {
  type: "token";
  text: string;
}

/** Streaming reasoning content (thinking tokens). */
export interface ThinkingMsg {
  type: "thinking";
  text: string;
}

/** A turn has ended (assistant finished generating). */
export interface TurnEndMsg {
  type: "turn_end";
  // Empty for now; could carry turn metadata in the future.
}

/** Assistant is about to call a tool. */
export interface ToolStartMsg {
  type: "tool";
  name: string;
  args: Record<string, unknown> | string;
}

/** Tool call finished with a result. */
export interface ToolResultMsg {
  type: "tool_result";
  name: string;
  content: string;
  rejected: boolean;
}

/** Informational notice (status, error, etc.). */
export interface NoticeMsg {
  type: "notice";
  text: string;
}

/** The daemon needs the user to approve a tool before it can proceed. */
export interface ApprovalRequestMsg {
  type: "approval_request";
  id: number;
  title: string;
  body?: string;
  kind: string;
}

// ── Client → Server ──────────────────────────────────────────────────

/** Send a prompt to the agent loop. */
export interface PromptMsg {
  type: "prompt";
  text: string;
}

/** Answer an approval request. */
export interface ApprovalResponseMsg {
  type: "approval_response";
  id: number;
  answer: "yes" | "no" | "always";
}

/** Run a slash command (/clear, /cost, /help, etc). */
export interface SlashMsg {
  type: "slash";
  command: string;
  arg?: string;
}

// ── Union types ──────────────────────────────────────────────────────

export type ServerMessage =
  | HelloMsg
  | TokenMsg
  | ThinkingMsg
  | TurnEndMsg
  | ToolStartMsg
  | ToolResultMsg
  | NoticeMsg
  | ApprovalRequestMsg;

export type ClientMessage =
  | PromptMsg
  | ApprovalResponseMsg
  | SlashMsg;
