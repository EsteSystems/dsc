# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-06-11

### Added
- `list_dir` tool — non-recursive directory listing (directories first with a `/` suffix, symlinks marked `@`, dotfiles included), defaulting to the cwd. Read-only (no approval) and cross-platform via `fs`, so the agent no longer spends an approval round-trip on `bash ls`/`dir` just to see what's in a directory; `glob` remains for recursive/pattern matching. `read_file`'s "that's a directory" hint now points at `list_dir`. Added to `TOOL_SCHEMAS`, `READ_ONLY_TOOLS`, the system-prompt tool list, and the README. 7 new tests; total 222.
- `multi_edit` tool — apply a sequence of edits to a single file in one atomic call. Each edit is `{old_string, new_string, replace_all?}` applied in order (each sees the previous edit's result); if any edit fails to match — not found, or non-unique without `replace_all` — nothing is written, so the file is never left half-patched. One approval shows the cumulative diff (reusing the `edit_file` dialog). Cuts the tool-call count for multi-change refactors that previously needed N separate `edit_file` calls. Added to `TOOL_SCHEMAS`, the system-prompt tool list, and the README tool table; gated under its own `multi_edit` approval. 8 new tests; total 215.
- Multi-provider key management + model availability UX. `/api-key` is now provider-aware: no arg shows every provider's key status + signup URL; `<key>` alone still saves the DeepSeek key (back-compat); `<provider> <key>` saves any provider's key (`deepseek` → top-level `api_key`, others → `providers.<id>.api_key`); `<provider>` alone shows that provider's status. `/model` (and `-m`, and `--help`) now list only the models usable right now — a model surfaces once its provider has a key (DeepSeek always shows for first-launch onboarding), and switching to a model whose key is missing prints how to set it instead of failing on the next turn. New `api.ts` exports: `availableModels()`, `isKnownModel()`, `modelAvailable()`, `providerKeySource()`, `saveProviderKey()`, `PROVIDER_KEY_INFO`. README gains a "Providers & models" section; `config.json.example` shows the `providers.anthropic` block. 11 new tests; total 207.
- Anthropic (Claude) provider. `claude-sonnet-4-6` is now selectable via `/model` (or `-m`), backed by a dedicated provider in `api.ts` that translates the normalized OpenAI-shaped request/response to Anthropic's Messages API in both directions: the system message lifts to a top-level field; assistant `tool_calls` become `tool_use` content blocks; runs of `tool` messages coalesce into one user turn of `tool_result` blocks; the event-typed SSE stream (`message_start`/`content_block_delta`/`message_delta`) is parsed back into streamed content + assembled tool calls; `thinking` deltas map to reasoning; and Anthropic's split usage (cached-read vs. fresh/cache-write input) maps onto dsc's hit/miss cost model. Auth via `ANTHROPIC_API_KEY` (env) or `providers.anthropic.api_key` (config). 11 new tests (translation units + end-to-end `chat`/`chatStream` over a stubbed transport); total 196. A slash command to save the Anthropic key, `/model` availability filtering by configured key, and docs land with the multi-provider config/UX work; the exact Claude API model string should be confirmed against the live API.
- Provider abstraction seam in `api.ts` (Phase 1 of multi-provider support; no behavior change). A model registry (`MODEL_REGISTRY`) maps each model id to a `ModelSpec` (`provider` + per-token `rates` + `contextWindow`), and the active model is now the routing key: `chat`/`chatStream`/`computeCostUsd` look up the model's provider and delegate. A `Provider` interface abstracts the transport; `openAICompatProvider(...)` factory implements the OpenAI-compatible wire format (DeepSeek today; OpenAI + Ollama drop in with just a different URL/key). `Model` changed from a hardcoded union to a bare `string` (the provider is implied by the registry), so `/model <name>` stays open-ended and session JSON is unchanged. New exports: `ProviderId`, `ModelSpec`, `ModelRates`, `Provider`, `MODEL_REGISTRY`, `modelSpec()`, `providerFor()`, `DEEPSEEK_API_URL`. `MODEL_RATES`/`API_URL` removed (folded into the registry). 5 new routing tests; total 185.
- Slash-command dispatcher extracted from `tui.tsx` into `src/slash_dispatch.ts` and given a test suite (`tests/slash_dispatch.test.ts`, 29 tests). The dispatcher (`dispatchSlash(line, ctx)`) owns all command parsing, routing, and user-facing message formatting; it reaches its host front-end only through an injected `SlashContext` — `emit` (the output sink, was the TUI's `info()`), getters for the reassignable session state, and a few action callbacks for genuinely front-end-specific work (`applySession` view rebuild, `runEditor` ink unmount/remount, `exit`, `compact`, `submit`). Everything else (preferences, history, search/api-key config, update, audit, instructions) is now plain module calls shared by any front-end. This shrinks `tui.tsx` from 1,724 to ~880 lines, makes every command unit-testable, and is the seam `dsc serve` Phase 2 needs to run `{type:"slash"}` over the wire. `formatRelative` moved from `tui.tsx` to `history.ts` (exported) since `/list` is its only user. No behavior change. Total now 180 tests across 45 suites.
- Test coverage for the two highest-risk previously-untested modules: the agent loop (`tests/agent.test.ts`, 23 tests) and the tool executors (`tests/tools.test.ts`, 44 tests). Total now 151 tests across 33 suites (was 84/21). The agent suite pins the loop invariants a silent regression would otherwise hide — `repairToolCallPairing` healing interrupted-turn tool-call/tool-message pairing, the throw→synthetic-error-result + remaining-call stub-fill path, abort→`interrupted`/rejected, the `MAX_TOOL_DEPTH` stop notice, and the `maxAutoContinue` budget-grant loop — plus the pure formatters (`estimateContextTokens`, `formatStatus`, `formatCost`). The tools suite covers every executor: `read_file` (line numbers, paging, directory/long-line handling), `write_file`/`edit_file` (create/overwrite/unique-vs-replace_all/rejection, `filesTouched`), `bash` (stdout + exit code, rejection, non-zero exit), `grep`/`glob` (matches + clean no-match), `web_fetch`/`web_search` validation paths (no network), the `task_*` store mutations, and the static schema/`READ_ONLY_TOOLS` surface. Suites stay hermetic — `DSC_NO_AUDIT=1`, `setAsker`-driven approvals, per-test store reset, temp dirs — and the `grep`-spawning cases skip on Windows where the binary isn't guaranteed.

### Changed
- `runAgent` gained an optional `chatStream` transport override on `RunOptions`, mirroring the existing `dispatchExtraTool`/`extraTools` injection points. Defaults to the real DeepSeek `chatStream`, so production behavior is unchanged; it lets tests drive the loop with scripted responses (no network) and lets an embedder swap the transport without touching the loop. `repairToolCallPairing` is now exported for direct testing (same pattern as `parseBlocks`/`autoRequiresApproval`/`expandEnv`).

## [1.1.1] - 2026-05-25

### Documentation
- Document `dsc serve` daemon. New `## Headless mode (dsc serve)` README section covers usage, the WebSocket protocol table (hello / token / thinking / tool / tool_result / notice / approval_request / turn_end inbound and outbound), a `wscat` quick-try, the `ws` optional-dependency caveat, and points at `docs/headless-serve-plan.md` for the multi-client / approval round-trip roadmap. `dsc --help` now lists the `serve` subcommand alongside TUI and one-shot. No behavior change — strictly docs the marquee 1.1.0 feature should have shipped with.

## [1.1.0] - 2026-05-25

### Changed
- **Config file relocated** from `~/.config/deepseek/deepseek.json` to `~/.config/dsc/config.json` (XDG-aware). The old path was a leftover from the pre-rebrand days; the new path matches the binary name and XDG conventions. On first launch with the new version, dsc copies the legacy file forward to the new path and prints a one-line `migrated config:` notice (TUI `info()` line; stderr in one-shot mode). The legacy file is left in place — paranoid about destroying user-curated config — so existing tooling that still reads `deepseek.json` keeps working. Once you've confirmed the new file is good, the old one is safe to delete. Repo template renamed `deepseek.json.example` → `config.json.example`. Writers (`/api-key`, `/search key`) automatically target the new path. New helpers: `legacyConfigPath()`, `migrateLegacyConfigIfNeeded()`, `consumeConfigMigrationNotice()`. New `tests/api.test.ts` migration suite (5 scenarios: no-op, new-exists-wins, fresh copy + once-only notice, idempotent re-run, lazy `getConfig()` trigger).
- Rebranded `dsc` → **Dev Shell Companion** (still abbreviated `dsc`, same binary, same npm package). The name `dsc` historically read as "DeepSeek Client"; making it provider-agnostic reverse-acronym sets up the multi-provider work coming in 1.x without forcing a rename or fork. User-facing surfaces updated: README intro, `package.json` description, system prompt opening, `--help` header, welcome panel. System prompt edit costs one prefix-cache bust on every existing session's first turn, same as any other SYSTEM_PROMPT change.

### Added
- `dsc serve` — headless WebSocket daemon. New subcommand boots a WebSocket server on `localhost:9090` (configurable via `--port`) and accepts prompts over a typed JSON protocol (`hello`, `prompt`, `approval_response`, `slash` inbound; `token`, `thinking`, `tool`, `tool_result`, `notice`, `approval_request`, `turn_end` outbound). Enables integration with editors, other agents, and remote frontends without dragging ink into the consumer's environment. `ws` added as an `optionalDependency` so users who don't run the daemon don't pay for it. Protocol shapes live in `src/serve_protocol.ts`; smoke test in `scripts/serve-smoke.mjs`. Multi-phase plan in `docs/headless-serve-plan.md` (Phase 1 shipping; slash dispatch + multi-client coordination land in 1.x).
- Slash-set toggle preferences (`/yolo`, `/reasoning`, `/auto-continue`, `/budget`) now persist to `~/.config/dsc/preferences.json` (XDG-aware) and apply on the next launch. Boot precedence: command-line flags > saved preferences > defaults. `$DSC_AUTO_CONTINUE` still wins over the saved auto-continue value for scripted invocations.
- Loud red `warning:` announcement on launch when persisted `yolo` is on or a persisted `budget` is active — keeps a forgotten-from-last-session setting from silently bypassing approvals or aborting a turn.
- `/preferences` slash command: show the saved preferences and the file path; `/preferences reset` deletes the file (current session keeps its in-memory state).
- New `tests/preferences.test.ts` (9 tests): round-trip, merge semantics, `null`-clears-key, malformed/corrupt file handling, budget validation. Total 84 tests across 15 suites with the new config-migration suite.

### Fixed
- `dsc serve` daemon no longer crashes when a client disconnects without sending a proper WebSocket close frame. The Python `websockets` library (and others) drop the connection without the handshake; without `ws.on('error')` and `wss.on('error')` handlers, the resulting unhandled error event took the whole daemon down. Both error events now log and continue.

## [1.0.2] - 2026-05-25

### Fixed
- MCP stdio servers no longer corrupt the TUI on boot. The SDK's default `stderr: "inherit"` forwarded child stderr (Python `logging`, JS `console.error`, `tqdm` progress bars, TLS handshakes, anything) straight to dsc's terminal. Each stray write displaced ink's pinned status bar; the next 1-second `syncStatus` tick painted a fresh frame below the old one, so users with N MCP servers saw up to N stacked status bars during boot. Now stdio transports get `stderr: "pipe"` + the child's stderr piped to `~/.local/state/dsc/mcp-<server>.log` (XDG-aware) with a session-header line on each connection. TUI stays clean; debugging output stays accessible.

## [1.0.1] - 2026-05-20

### Fixed
- Auto-compact silently disabled since 0.2.0. The TUI's port of the auto-compact wiring read `process.env.DSC_AUTO_COMPACT` instead of the documented `DSC_AUTO_COMPACT_AT`, and defaulted to `0` (disabled) instead of the REPL's `50_000`. Users setting the documented env var got nothing; users without it got auto-compact off entirely, so `/transcript` and the prompt cache silently bloated turn-after-turn. Fix restores the REPL's behavior: read `DSC_AUTO_COMPACT_AT`, default `50_000`, accept `"off"` / `"0"` / `"false"` as explicit disables.

## [1.0.0] - 2026-05-19

First stable release. The TUI, the agent loop, the tool surface, the
session model, the approval flow, the MCP integration, the install/
update story — all of it has been used in real work for weeks and the
rough edges are sanded. Future minor versions remain backwards-
compatible in the slash command surface, the config file shape, and
the on-disk session format.

### Added
- MCP stdio transport. `mcp.servers.<name>` now supports `transport: "stdio"` with `command` / `args` / `env`, spawning a local subprocess MCP server (filesystem, git, custom in-house, anything `npx`-distributable). Child env merges on top of `process.env` so the subprocess still sees PATH etc; `${VAR}` references expand in command, args, and env values. Transport is inferred from which of `url`/`command` is set when not explicit.
- MCP approval gating. Every server has a `requireApproval` policy: `"always"` (every call asks), `"never"` (pass through), `"auto"` (heuristic — tool names / descriptions matching destructive verbs like write/delete/send/run/etc get prompted, clearly read-only ones pass). Defaults: `"always"` for stdio, `"auto"` for HTTP. The `a` (always) answer adds the namespaced tool name to a per-session allowlist so repeated identical calls skip the dialog. Args are pretty-printed in the approval body so the user sees what's about to happen before saying yes.
- Expanded test coverage. 5 new suites: `prompt.test.ts` (system-prompt assembly + cache-prefix hygiene), `markdown.test.ts` (block-parser invariants), `mcp.test.ts` (approval heuristic + env-var expansion), `store.test.ts` (pub/sub contract), `api.test.ts` (configPath, key sources, cost math). 42 new tests; total 69 across 13 suites. `parseBlocks` (Markdown), `autoRequiresApproval` and `expandEnv` (mcp) are now exported for direct testing.
- `/budget [usd|off]` sets a per-session USD ceiling. One-time `info()` warning at 80% of the limit; the next turn after the limit is reached refuses to send with a clear error pointing at `/budget off` and `/budget <amount>`. Catches runaway `/auto-continue` loops where you walk away from dsc and come back to a $4 conversation. Session-scoped (not persisted across restarts); resetting the limit clears the warned flag so the new threshold gets its own notice.
- `/edit` added to the in-app `/help` listing (already worked; was undocumented).

### Fixed
- MCP "auto" approval heuristic now catches `write_file` / `delete_record` / etc. The previous `\bwrite\b`-style regex didn't fire on snake_case names because JS treats `_` as a word character. Replaced with tokenizing on non-letters and checking against a set of destructive verbs (including common `-s` / irregular `-ed` forms so verb-shaped descriptions like "sends a message" also trip). Test added.
- `/update` now retries once after an 8 s delay when npm fails with `ETARGET` — the publish-propagation race where the registry's metadata is updated but the tarball hasn't reached every CDN edge yet. Stops legitimate "yes there's a newer version but I can't install it" failures in the minute or two after `npm publish`.

## [0.6.0] - 2026-05-19

### Added
- Generic MCP (Model Context Protocol) client. Configure remote MCP servers under `mcp.servers` in `~/.config/deepseek/deepseek.json`; dsc connects at boot, discovers tools via `listTools`, and exposes them to the agent alongside the built-ins. Tool names get namespaced as `mcp_<server>_<tool>` so multiple servers don't collide. Headers/query support `${VAR}` env expansion so API keys don't have to live in the config file. `/mcp` lists connected servers and their tools. HTTP (Streamable HTTP) transport only in this release; stdio is a future addition. New runtime dependency on `@modelcontextprotocol/sdk`.
- Test scaffold using `node --test` invoked through `tsx` — no new dependency. `npm test` discovers and runs `tests/*.test.ts`. Seed coverage on `completeSlash`, `compareSemver`, `loadInstructions` (with temp-dir + isolated XDG_CONFIG_HOME), and `history` save/load/list/export/import (with isolated XDG_DATA_HOME). 27 tests, 5 suites at landing.
- GitHub Actions CI: typecheck + tests on Linux / macOS / Windows for every push and PR.

## [0.5.3] - 2026-05-19

### Fixed
- Streaming markdown actually streams now. 0.5.2 only rendered rich once a paragraph "committed" via a trailing blank line — too conservative for typical model output, which rarely emits a blank until the end. Now the entire streaming content goes through `Markdown` on every chunk; `React.memo` skips the parse when `source` is unchanged (spinner ticks etc). Partial markers (open `**`, half-typed ```) render literal and snap to formatted once they pair.

## [0.5.2] - 2026-05-18

### Changed
- Streaming markdown render. The currently-streaming assistant turn now splits at the last blank line outside a code fence: paragraphs before that point render through the full Markdown component (bold, italic, code, lists, tables, etc), the still-streaming tail stays plain so half-typed markers don't flip interpretation on every chunk. Once a paragraph "commits" by being followed by a blank line it shifts into the stable prefix. Markdown is memoized on its `source` prop so re-renders that only change the tail don't re-parse the stable portion. Finalized turns in `<Static>` render the same as before — fully rich.

## [0.5.1] - 2026-05-18

### Changed
- `/search-key` is replaced by `/search` with subcommands. `/search` prints the active provider + per-provider key status + signup URLs. `/search use <brave|tavily|ddg>` writes `search.provider` to the config. `/search key <provider> [key]` shows or saves a key. The old half-feature (you could save a key but not switch provider without editing the JSON) is gone.

## [0.5.0] - 2026-05-18

### Added
- Per-project instructions overlay. dsc now appends content from `~/.config/dsc/instructions.md` (user-global), `AGENTS.md` (project, walked up from cwd, shared with other agents), and `.dsc/instructions.md` (project, dsc-only) to the system prompt every turn. Each file gets its own labeled section so the model knows the source; the dsc-specific one appears last and effectively wins on conflict. Files re-read per turn — edits land in the next request.
- `/instructions` slash command lists the active overlays and shows their content; the TUI also prints a one-line summary at session start when any are present.

## [0.4.1] - 2026-05-17

### Added
- `/update` on EACCES (Linux / macOS) now offers to do the user-prefix setup itself. The yellow approval dialog asks first; on `y` it runs `mkdir -p ~/.local/{bin,lib}`, `npm config set prefix ~/.local`, and retries the install. If `~/.local/bin` isn't on PATH afterwards, a second dialog offers to append the export line to the detected shell rc (`~/.bashrc` / `~/.bash_profile` / `~/.zshrc` / `~/.config/fish/config.fish`). Idempotent — re-running is safe. Skipping the dialogs leaves the manual one-liner instructions intact.

### Changed
- README leads the install with a one-time `npm config set prefix ~/.local` + PATH export so `npm install -g` (and `/update`) work without `sudo` on Linux / macOS. Windows already uses a user-owned prefix and is unchanged.
- `scripts/install.sh` detects a root-owned npm prefix and auto-configures `~/.local` when run as a non-root user. `--system` opts out (use the existing prefix, may need sudo); `--user` forces the switch.

## [0.4.0] - 2026-05-17

### Added
- `/search-key [provider] [key]` — list/save search-provider API keys (Brave, Tavily) and print signup URLs so the user knows where to get one. Mirrors `/api-key`'s shape.
- `/api-key` and the welcome panel now point at https://platform.deepseek.com/api_keys when no DeepSeek key is configured.
- System prompt + bash tool description teach the model about Windows package managers (winget / scoop) and Node version managers (nvm-windows / fnm). Stops the model from suggesting `apt install` on Windows.

### Removed
- The readline REPL is gone. The TUI has been the default entry for five releases; the `--repl` opt-out and its supporting code (`src/index.ts`, the DECSTBM `StatusBar` in `src/ui.ts`, the streaming markdown→ANSI renderer in `src/markdown.ts`) are deleted. One-shot mode (`dsc "prompt"`) is unchanged — the TUI's stdout adapter still handles it.

### Changed
- `bin/dsc.mjs` always routes to `src/tui.tsx` now; the `--repl` branch is gone.
- TUI's arg parser absorbs the flags the REPL used to handle: `--model` / `-m <name>` and `--resume [id]`. Unknown flags now error with a clear message instead of being silently ignored.
- One-shot output is plain text — the agent no longer routes its stdout writes through the ANSI markdown renderer. Cleaner pipes; fewer escape codes in scripted use.

## [0.3.0] - 2026-05-17

### Added
- `/api-key [key]` — save the DeepSeek key to the config file, or report where the current key is coming from (env / file / unset). Boot no longer hard-exits when no key is configured; a one-line in-app prompt points at the slash command.
- `/update` — force-check npm for a newer release and install it; the TUI also runs a cached once-a-day check on startup and surfaces a passive "X available" notice when behind.
- `/copy` — copy the last assistant message to the OS clipboard (pbcopy / clip / wl-copy / xclip / xsel).
- `/export [path]` — write the current session JSON to a chosen path for transfer between machines.
- `/import <path> [--keep-cwd]` — load a session JSON; rebinds cwd to the current directory by default so auto-resume picks it up. Collisions get a fresh id (no overwrites).
- One-time welcome panel on first launch, stamped via `$XDG_STATE_HOME/dsc/welcomed` so it doesn't repeat.
- Inline ghost-text suggest as you type a `/slash` command (dim suffix of the longest match).
- Truncation marker on long tool output — `(N more chars / M more lines, full output sent to model)` — so the user knows the gap is rendering, not data loss.
- Approval shortcut `a` (always) auto-approves future calls of the same tool for this session; cleared by `/clear`.

### Changed
- Approval dialog renders the diff / command / URL preview **inline** in the yellow box (24-line cap, structural per-line coloring, "(N more)" tail). No more raw ANSI bleed above the ink frame.
- Slash commands echo into history as user messages so their output is no longer orphaned in scrollback.

## [0.2.5] - 2026-05-17

### Fixed
- EINVAL when the build / package scripts spawn `npm.cmd` on Windows.

## [0.2.4] - 2026-05-17

### Changed
- Swapped the busy spinner from Braille to quadrant blocks — Windows console fonts can't render Braille consistently.

## [0.2.3] - 2026-05-17

### Fixed
- Kill the entire cmd.exe process tree on abort / timeout / grace so PowerShell grandchildren don't leak and keep the agent stuck.

## [0.2.2] - 2026-05-14

### Fixed
- Windows bash hang: grandchildren inheriting stdio kept `child.on("close")` from firing, leaving the tool Promise pending forever. Now spawns with `stdio:["ignore","pipe","pipe"]` + `windowsHide:true`, listens on both `exit` and `close`, and force-settles 500 ms after `exit` if `close` hasn't arrived.

### Added
- Genuinely empty assistant turns (no content, no reasoning, no tool calls) now show a `(model returned no content)` marker instead of disappearing silently.

## [0.2.1] - 2026-05-14

### Added
- Animated Braille spinner in the status bar while busy; `/compact` now flips `busy` so the spinner shows during compaction too.

### Changed
- Status-bar task labels are pretty-printed per tool (`bash: npm test`, `edit_file: src/foo.ts`) instead of dumping the raw JSON arguments.

### Fixed
- Status bar no longer renders one column past the terminal width (off-by-one in the padding math).

## [0.2.0] - 2026-05-13

### Added
- Brand-new TUI built on [ink](https://github.com/vadimdemedes/ink) as the default entry. Prompt + status bar pin to the bottom; finalized turns live in normal scrollback so they stay selectable. The readline REPL stays available behind `--repl`.
- Custom prompt input with cursor movement, Emacs-style line-edit shortcuts (Ctrl+A/E/U/K/W), Up/Down history shared with the REPL, TAB completion, paste tolerance.
- Agent task list — three new tools (`task_create`, `task_update`, `task_list`) backed by an in-memory list; the TUI renders ○ pending / ◐ in-progress / ● completed bullets above the prompt.
- Visible type-ahead queue (dim, above the prompt) instead of just a `queued:N` count in the status bar.
- Reasoning rendered as a dedicated "thinking" block (dim italic, indented) instead of dangling under the assistant header.
- Native one-shot mode in the TUI: `dsc "prompt"` runs the agent against stdout and exits without rendering ink.
- TUI slash commands: `/help`, `/clear`, `/list`, `/resume`, `/save`, `/rename`, `/model`, `/yolo`, `/reasoning`, `/cost`, `/version`, `/lang`, `/auto-continue`, `/queue`, `/audit`, `/transcript`, `/compact`, `/edit`, `/exit`.
- ESC aborts the in-flight turn; Ctrl+D / Ctrl+C exit semantics.
- Multiline input via backslash continuation, with the accumulated buffer rendered dim above the prompt; ESC clears it.
- `/edit` unmounts ink, opens `$EDITOR`, and remounts.
- Markdown rendering (headings, code fences, lists, blockquotes, tables, inline bold / italic / code / links) applied to finalized assistant messages.

### Changed
- System prompt no longer embeds the per-turn status line (cost / tokens / session timer). That string changed every turn and broke DeepSeek's prefix cache for the *entire* message history — every prior message got re-billed as a miss. Removing it restores cache hits across long sessions.
- User prompts in history render with a subtle bright-black background and no role label.

## [0.1.7] - 2026-05-12

### Added
- `--version` / `-v` CLI flag and `/version` slash command — prints dsc version + Node + platform/arch.

## [0.1.6] - 2026-05-12

### Changed
- Strengthened the bash tool description with explicit POSIX↔Windows command pairs (ls↔dir, cat↔type, rm↔del, mv↔move) and a system-prompt rule "Never refuse to run shell commands because of the platform."

## [0.1.5] - 2026-05-12

### Fixed
- Bash and `which` on Windows. `spawn("/bin/sh", ...)` was broken — switched to `spawn(command, [], { shell: true })`. Use `where` on Windows, `which` elsewhere.

## [0.1.4] - 2026-05-12

### Fixed
- TDZ crash on startup: hoisted the `promptQueue` declaration before `currentStatusLine` references it.

## [0.1.3] - 2026-05-12

### Fixed
- Windows-only `ERR_UNSUPPORTED_ESM_URL_SCHEME` in `bin/dsc.mjs`. `await import("C:\\...")` parses `C:` as a URL scheme; use `pathToFileURL()` instead.

## [0.1.2] - 2026-05-12

### Added
- `/auto-continue [N|off]` — when the agent hits `MAX_TOOL_DEPTH` without converging, auto-grant up to N more 24-call budgets instead of stopping. Initial value comes from `DSC_AUTO_CONTINUE`.
- `/lang [name|off]` — force the model to reply exclusively in a named language; persisted per session.
- Type-ahead prompt queue — captured lines pile up while a turn is running and drain in order afterwards.
- `deepseek.json.example` settings template.

## [0.1.1] - 2026-05-11

### Changed
- README polish: npm / license / node version badges; per-platform install steps for Linux / macOS / Windows.

## [0.1.0] - 2026-05-10

Initial public release.

### Added
- Readline REPL with streaming responses from DeepSeek's API.
- Tool surface: `bash`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `web_fetch`, `web_search` (Brave / Tavily / DuckDuckGo).
- Per-cwd session persistence under `~/.local/share/dsc/sessions/` keyed by id, with auto-resume by directory.
- JSONL audit log of every tool call under `~/.local/state/dsc/audit.log`.
- Up-arrow prompt history shared across sessions under `~/.local/state/dsc/history`.
- Slash commands: `/clear`, `/cost`, `/model`, `/yolo`, `/reasoning`, `/list`, `/resume`, `/save`, `/rename`, `/audit`, `/transcript`, `/compact`, `/edit`, `/exit`.
- `/compact` summarizes older turns into a synthetic block kept in the system prompt; the original messages move to `archivedMessages` so `/transcript` still shows them.
- ESC interrupts the running turn.
- Backslash continuation for multi-line input.
- DECSTBM-pinned status bar.
- Cross-platform packaging (`npm pack` + per-OS installer scripts).

[Unreleased]: https://github.com/EsteSystems/dsc/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/EsteSystems/dsc/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/EsteSystems/dsc/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/EsteSystems/dsc/compare/v1.0.0...v1.1.0
[1.0.1]: https://github.com/EsteSystems/dsc/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EsteSystems/dsc/compare/v0.6.0...v1.0.0
[0.6.0]: https://github.com/EsteSystems/dsc/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/EsteSystems/dsc/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/EsteSystems/dsc/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/EsteSystems/dsc/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/EsteSystems/dsc/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/EsteSystems/dsc/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/EsteSystems/dsc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/EsteSystems/dsc/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/EsteSystems/dsc/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/EsteSystems/dsc/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/EsteSystems/dsc/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/EsteSystems/dsc/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/EsteSystems/dsc/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/EsteSystems/dsc/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/EsteSystems/dsc/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/EsteSystems/dsc/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/EsteSystems/dsc/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/EsteSystems/dsc/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/EsteSystems/dsc/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/EsteSystems/dsc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/EsteSystems/dsc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/EsteSystems/dsc/releases/tag/v0.1.0
