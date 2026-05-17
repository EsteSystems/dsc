# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- README leads the install with a one-time `npm config set prefix ~/.local` + PATH export so `npm install -g` (and `/update`) work without `sudo` on Linux / macOS. Windows already uses a user-owned prefix and is unchanged.
- `scripts/install.sh` detects a root-owned npm prefix and auto-configures `~/.local` when run as a non-root user. `--system` opts out (use the existing prefix, may need sudo); `--user` forces the switch.
- `/update` on EACCES no longer just suggests `sudo`. It explains the durable fix (`npm config set prefix ~/.local` + PATH) and keeps the one-off `sudo` line as a fallback.

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

[Unreleased]: https://github.com/EsteSystems/dsc/compare/v0.4.0...HEAD
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
