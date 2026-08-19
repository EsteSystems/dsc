# DSC Roadmap & Research Notes

This document synthesizes research on terminal-native LLM coding agents and
turns it into a prioritized improvement path for DSC.

## Sources

- [Terminal Is All You Need: Design Properties for Human-AI Agent Collaboration](https://arxiv.org/html/2603.10664v1)
- [Building AI Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering, and Lessons Learned](https://arxiv.org/html/2603.05344v1)
- [Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems](https://arxiv.org/html/2604.14228v2)
- [Effective context engineering for AI agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [4 Principles for Agent-Facing CLI Design — Terry Li](https://terryli.ai/posts/4-principles-for-agent-facing-cli-design/)
- [Terminal-Bench](https://www.tbench.ai/)
- Competitors surveyed: Claude Code, OpenCode (archived → Crush), Kimi Code CLI, Codex CLI, Gemini CLI, Aider.

## Core research takeaways

1. **The terminal wins for agent UX for three reasons:**
   - Representational compatibility — agent text maps directly to shell/code/diffs.
   - Transparency — one text stream is channel, explanation, audit log, and approval gate.
   - Low barriers to human participation — natural-language intervention and explicit turn boundaries.

2. **Context is the binding constraint.** Tool outputs consume 70–80% of context. Treat context as a budget and apply graduated reduction before emergency compaction.

3. **Safety should be architectural.** Schema gating (removing tools from the agent's schema) is stronger than runtime blocking.

4. **Tools should absorb LLM imprecision.** Strict exact-match edits are a major failure source; fuzzy/chained matching converts near-misses into success.

5. **There is an emerging agent-facing CLI contract.** Stable structured output, `next_actions`, actionable errors, self-description in one call.

6. **The field converges on:** per-project sessions, approval/permission modes, MCP, subagents with isolated context, hooks, instruction-file hierarchy, compaction, editor/ACP integration, and TUI polish.

---

## Where DSC stands

DSC already has a strong skeleton:

- terminal-native TUI + one-shot mode
- per-cwd session resume
- tools: `bash`, `read_file`, `write_file`, `edit_file`, `multi_edit`, `grep`, `glob`, `web_fetch`, `web_search`, `task_*`
- MCP support
- approvals + audit logging
- compaction/history
- DeepSeek/Anthropic provider routing
- `AGENTS.md`/`README`/`CHANGELOG` auto-context index

Largest gaps: context engineering depth, verification loops, subagent isolation, schema-level safety, structured one-shot output, and an evaluation harness.

---

## Phase 0 — Context engineering (highest leverage, lowest risk)

1. **Graduated context management, not just `/compact`.**
   - Track API-reported `prompt_tokens` as ground truth.
   - Add cheap pre-compaction pruning of stale tool outputs before expensive LLM compaction.
   - Keep `/compact` as the last resort.

2. **Tool-result optimization.**
   - Per-tool-type summarization/truncation.
   - Large outputs → scratch file + preview + reference; let the agent read on demand.
   - Truncation hints should point to the actual recovery tool (`offset/limit`, subagent, etc.).

3. **Dual-memory / bounded thinking.**
   - Maintain a compressed long-range summary plus a verbatim recent window.
   - For providers that support it, separate a no-tool thinking call from the action call.

4. **Decision-time reminders.**
   - Replace long static rules with short, capped, `user`-role reminders injected at relevant decision points.
   - Example: "re-read before edit", "run tests after change".
   - Reminder frequency must be capped to avoid becoming background noise.

5. **Prompt-cache-friendly structure.**
   - Split the system prompt into a stable cacheable prefix and dynamic suffix.
   - Add cache-control markers for providers that support prompt caching.

---

## Phase 1 — Tool & interaction ergonomics

6. **Fuzzy/tolerant editing.**
   - Add progressively relaxed edit matchers that return actual file content and preserve formatting.
   - Keep exact match as the fast path.

7. **Retrieval decision tree.**
   - Encode concrete routing in the prompt:
     - symbol/function/class → semantic or structured search
     - literal string → grep
     - filename → glob
     - structural pattern → AST/LSP
   - This reduces wasted grep calls and context flooding.

8. **Background command promotion.**
   - Detect server-like/watch/test commands and run them in the background with captured output instead of hitting foreground timeouts.

9. **Agent-facing one-shot mode.**
   - Add `dsc --json` / `dsc --porcelain` with a stable envelope:
     `ok`, `result`, `error`, `fix`, `next_actions`.
   - Makes DSC scriptable and CI-friendly.

10. **TUI hardening.**
    - Collapsible tool results.
    - Graceful truncation of very large markdown tables.
    - Avoid full-UI re-renders on task updates.
    - Consider screen-reader/accessibility mode and flicker-free rendering.

---

## Phase 2 — Safety & verification

11. **Schema-level safety for read-only modes/subagents.**
    - In plan mode or read-only subagents, remove write/bash tools from the schema rather than relying only on permission prompts.

12. **Deny-first, progressive trust.**
    - Deny rules always win.
    - Unmatched risk-bearing actions ask by default.
    - User approvals can become permanent rules.

13. **Verification loops.**
    - After edits, run the project's cheapest check (tests, build, linter, fixture diff) and read the result before declaring done.
    - Add a lightweight `verify` convention in the agent prompt.

14. **Actionable error classification.**
    - Classify common failures (edit mismatch, missing dependency, command timeout, context overflow) and return targeted recovery templates.

---

## Phase 3 — Memory, extensibility, orchestration

15. **Persistent cross-session memory.**
    - Promote the current in-memory auto-context index into a persistent, decaying per-project knowledge store.
    - Store "what worked / what failed" and retrieve semantically.

16. **Subagents with isolated context.**
    - `explore` (read-only, isolated context) and `plan` subagents so exploration does not pollute the main context.

17. **Lifecycle hooks.**
    - Add PreToolUse / PostToolUse hooks for power users and CI integration.

18. **ACP/IDE bridge later.**
    - Keep the agent loop backend/frontend-separable so an ACP/stdio server can reuse the same core.

---

## Phase 4 — Evaluation & hardening

19. **Evaluation harness.**
    - Run DSC against small task suites inspired by Terminal-Bench / SWE-bench / LongCLI-Bench.
    - Track task success, tool-call count, context consumed, approval count, recovery rate.

20. **Empirical threshold tuning.**
    - Tune compaction thresholds, reminder caps, and concurrency caps from run data rather than fixed constants.

---

## Suggested immediate next steps

1. Instrument context usage — add a status-bar token/context meter backed by API-reported `prompt_tokens`.
2. Implement large-output offloading + previews in `tools.ts`.
3. Add a `verify` loop primitive — "after edits, run `<check>` and read output".
4. Prototype decision-time reminders with a small event detector and capped templates.
5. Draft the `dsc --json` envelope for one-shot mode.
