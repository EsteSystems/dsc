import React, { useState } from "react";
import { Text, useInput } from "ink";
import { completeSlash } from "../slash.js";

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (value: string) => void;
  /** When false, key events are ignored — used while an approval is pending. */
  focus: boolean;
  /** Past entries for arrow-up navigation, oldest-first. */
  history?: string[];
}

/**
 * Single-line controlled input with cursor, arrow-key navigation, history
 * recall (Up/Down), TAB completion for `/slash` commands, and standard
 * line-edit shortcuts. We don't use ink-text-input because we need to own
 * TAB and arrow handling — ink's useInput doesn't support stopping event
 * propagation, so a parallel handler would fight ink-text-input's own
 * processing.
 *
 * The component is "controlled" — `value` and `onChange` come from the
 * parent. Cursor position, history index, and the saved draft (what the
 * user had typed before pressing Up) are local state.
 */
export function Input({ value, onChange, onSubmit, focus, history = [] }: Props) {
  const [cursor, setCursor] = useState(value.length);
  // null = editing a fresh line; otherwise an index into `history` (latest = -1
  // is fresh, history.length - 1 is the most recent, 0 is the oldest).
  const [histIdx, setHistIdx] = useState<number | null>(null);
  // What the user had typed before they started navigating history — restored
  // when they press Down past the newest entry.
  const [draft, setDraft] = useState("");

  // Keep the cursor in range when the parent rewrites `value` (e.g. clears
  // after submit, or completion replaces the whole line).
  if (cursor > value.length) {
    setCursor(value.length);
  }

  const setValueCursor = (next: string, nextCursor: number) => {
    onChange(next);
    setCursor(Math.max(0, Math.min(next.length, nextCursor)));
    // User-driven edit cancels history navigation; the displayed line is no
    // longer the historical entry but the user's mutation of it.
    setHistIdx(null);
  };

  useInput(
    (input, key) => {
      if (!focus) return;

      if (key.return) {
        // Submit. Reset cursor/history; parent decides what to do with the
        // value (clear it, continue buffering for backslash-multiline, etc.)
        onSubmit(value);
        setCursor(0);
        setHistIdx(null);
        setDraft("");
        return;
      }

      if (key.tab) {
        // Complete a slash command. Only act when the cursor is at the end
        // of the partial — completing mid-text would be jarring.
        const { completion } = completeSlash(value);
        if (completion && completion !== value) {
          setValueCursor(completion, completion.length);
        }
        return;
      }

      if (key.upArrow) {
        if (history.length === 0) return;
        if (histIdx === null) {
          setDraft(value);
          const idx = history.length - 1;
          const entry = history[idx];
          setHistIdx(idx);
          onChange(entry);
          setCursor(entry.length);
        } else if (histIdx > 0) {
          const idx = histIdx - 1;
          const entry = history[idx];
          setHistIdx(idx);
          onChange(entry);
          setCursor(entry.length);
        }
        return;
      }

      if (key.downArrow) {
        if (histIdx === null) return;
        const nextIdx = histIdx + 1;
        if (nextIdx >= history.length) {
          // Past the newest entry — restore the draft the user was editing.
          setHistIdx(null);
          onChange(draft);
          setCursor(draft.length);
        } else {
          const entry = history[nextIdx];
          setHistIdx(nextIdx);
          onChange(entry);
          setCursor(entry.length);
        }
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      if (key.backspace || key.delete) {
        // Treat both as backspace (delete-before-cursor) — terminal/ink
        // disagree on which key sends which event across platforms, and
        // "backspace deletes left" is the universally expected behavior.
        if (cursor > 0) {
          const next = value.slice(0, cursor - 1) + value.slice(cursor);
          setValueCursor(next, cursor - 1);
        }
        return;
      }

      // Emacs-style line shortcuts that most terminals leak through.
      if (key.ctrl && input === "a") {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === "e") {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === "u") {
        // Clear to start of line.
        setValueCursor(value.slice(cursor), 0);
        return;
      }
      if (key.ctrl && input === "k") {
        // Clear to end of line.
        setValueCursor(value.slice(0, cursor), cursor);
        return;
      }
      if (key.ctrl && input === "w") {
        // Delete the word before the cursor.
        const left = value.slice(0, cursor);
        const trimmed = left.replace(/\s*\S+\s*$/, "");
        setValueCursor(trimmed + value.slice(cursor), trimmed.length);
        return;
      }

      // Ignore other ctrl/meta combos — KeyHandlers in App.tsx owns Ctrl+C
      // and Ctrl+D, ApprovalDialog owns its own keys, etc.
      if (key.ctrl || key.meta) return;

      // Printable character (or paste — ink delivers multi-char input in a
      // single useInput call when the user pastes). Drop control chars.
      if (input && input.length > 0) {
        const clean = input.replace(/[\x00-\x08\x0b-\x1f]/g, "");
        if (!clean) return;
        const next = value.slice(0, cursor) + clean + value.slice(cursor);
        setValueCursor(next, cursor + clean.length);
      }
    },
    { isActive: focus },
  );

  // Render: split into [pre-cursor, cursor-char, post-cursor]. The cursor
  // is shown as an inverse-video single cell so it sits on the character
  // it'd act on (or a space at end-of-line).
  const pre = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const post = value.slice(cursor + 1);

  // Ghost-text suggestion: when typing a /slash command and the cursor is
  // at the end, show what TAB would complete to as dim suffix. Skip when
  // a multiline buffer continuation is active or when the cursor isn't at
  // the end (mid-edit completions would look like the cursor jumped).
  const isAtEnd = cursor === value.length;
  let ghost = "";
  if (isAtEnd && value.startsWith("/")) {
    const { completion } = completeSlash(value);
    if (completion && completion.startsWith(value) && completion.length > value.length) {
      ghost = completion.slice(value.length);
    }
  }

  if (ghost) {
    // Render the cursor on top of the first ghost char so the user sees
    // "press TAB to take this" with the caret positioned to commit.
    return (
      <Text>
        {pre}
        {focus ? (
          <Text inverse dimColor>
            {ghost[0]}
          </Text>
        ) : (
          <Text dimColor>{ghost[0]}</Text>
        )}
        <Text dimColor>{ghost.slice(1)}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {pre}
      {focus ? <Text inverse>{at}</Text> : <Text>{at}</Text>}
      {post}
    </Text>
  );
}
