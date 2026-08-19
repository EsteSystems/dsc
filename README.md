# dsc — Dev Shell Companion

[![npm version](https://img.shields.io/npm/v/@este.systems/dsc.svg)](https://www.npmjs.com/package/@este.systems/dsc)
[![npm downloads](https://img.shields.io/npm/dw/@este.systems/dsc.svg)](https://www.npmjs.com/package/@este.systems/dsc)
[![license](https://img.shields.io/npm/l/@este.systems/dsc.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@este.systems/dsc.svg)](https://nodejs.org)

A CLI coding agent that lives in your terminal: streams responses, calls
tools (`bash`, `read_file`, `write_file`, `edit_file`, `grep`, `glob`,
`web_fetch`, `web_search`, `task_*`), connects to MCP servers, keeps
per-cwd sessions, and runs as an [ink](https://github.com/vadimdemedes/ink)-based
TUI — prompt + status bar pinned at the bottom, finalized turns kept in
normal scrollback so they stay selectable and copy/paste-able. One-shot
mode (`dsc "prompt"`) runs the agent against stdout and exits without
rendering ink, so it pipes cleanly into scripts.

Powered by [DeepSeek](https://api-docs.deepseek.com/) (default) and
[Anthropic](https://docs.anthropic.com/) (Claude) — pick a model with
`-m` or `/model` and dsc routes to the right provider automatically.
OpenAI and Ollama are on the roadmap (the OpenAI-compatible transport is
already in place). See [Providers & models](#providers--models).

## Install

dsc requires **Node 22+** (it uses `fs.promises.glob`, stable since 22.0).

### Step 1 — install Node 22+

| Platform | One-liner |
|---|---|
| **Linux (Debian/Ubuntu)** | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install -y nodejs` |
| **Linux (Fedora/RHEL)** | `sudo dnf install -y nodejs:22/common` |
| **Linux (Arch)** | `sudo pacman -S nodejs npm` |
| **macOS** | `brew install node@22 && brew link node@22` |
| **Windows (winget)** | `winget install OpenJS.NodeJS.LTS` |
| **Windows (scoop)** | `scoop install nodejs-lts` |
| **Cross-platform (nvm)** | `nvm install 22 && nvm use 22` |

Verify: `node --version` should print `v22.x.x` or higher.

### Step 2 — install dsc

Three options. **(A)** is the standard install once the package is on npm.
Use **(B)** for a frozen tarball you can ship offline, or **(C)** if you'll
be hacking on the source.

**(A) From npm**:

On most Linux / macOS installs, `npm`'s global directory is `/usr/local`,
which is root-owned. Before installing any global npm tool — not just
dsc — point npm at a user-owned directory so `npm install -g` (and dsc's
`/update`) work without `sudo`:

```sh
# One-time setup. Skip if you've done this for another npm tool.
npm config set prefix ~/.local

# Add this to ~/.bashrc / ~/.zshrc and reopen the terminal:
export PATH="$HOME/.local/bin:$PATH"
```

Then:

```sh
npm install -g @este.systems/dsc
```

**Windows** users already get a user-owned prefix by default (`%APPDATA%\npm`).
Skip the `npm config set prefix` step and run the install directly.

After install, run `dsc`. On a fresh machine the TUI greets you with a
one-time welcome card and points you at `/api-key sk-...` for the
initial key save. To upgrade later, run `/update` inside the TUI (or
`npm install -g @este.systems/dsc@latest` from outside) — dsc also
checks npm in the background once a day and surfaces a one-line notice
when a newer version is published.

**(B) From a local tarball** *(works on all platforms with the same npm)*:

```sh
git clone https://github.com/EsteSystems/dsc.git
cd dsc
npm install
npm run package      # produces pkg/<name>-<version>.tgz
```

then on **Linux / macOS**:

```sh
scripts/install.sh                    # auto-configures user prefix if needed
scripts/install.sh --system           # use existing prefix (may need sudo)
```

or on **Windows PowerShell**:

```powershell
.\scripts\install.ps1
```

The Linux / macOS wrapper checks whether `npm config get prefix` points
at a user-writable directory. If not — and you aren't root — it sets up
`~/.local` and adds a PATH hint before installing. Pass `--system` to
opt out.

**(C) From source for development** *(live edits, no rebuild step)*:

```sh
git clone https://github.com/EsteSystems/dsc.git
cd dsc
npm install
npm link             # exposes `dsc` globally
```

The shim in `bin/dsc.mjs` runs the TypeScript sources directly through
`tsx`, so your next `dsc` launch picks up edits immediately. If `tsx`
isn't available it falls back to `dist/` (populate with `npm run build`).

### Step 3 — verify

```sh
dsc --help
```

If you get "command not found", your shell's `PATH` doesn't include npm's
global-bin directory. Find it with `npm config get prefix`; the binary
lives in `<prefix>/bin` on Linux/macOS or `<prefix>` on Windows. Add that
to your `PATH` and reopen the terminal.

## API key

**Easiest path** — launch dsc and use the slash command:

```
> /api-key sk-...
```

That writes `~/.config/dsc/config.json` with `0600` perms,
preserving any other fields (e.g. search-provider keys) already in the
file. You can also set `$DEEPSEEK_API_KEY` in your shell — it takes
priority over the file.

> **Upgrading from <1.1.0:** dsc reads from `~/.config/dsc/config.json` now.
> On first launch with the new version it will copy your existing
> `~/.config/deepseek/deepseek.json` forward automatically and print a
> one-line notice. The legacy file is left in place; delete it once you've
> confirmed everything works.

The rest of this section walks through the manual file setup if you'd
rather do it yourself. A ready-to-edit template lives at the repo
root: **[`config.json.example`](config.json.example)**. Copy it to
the config path below and replace the placeholder values:

```sh
# Linux / macOS:
mkdir -p ~/.config/dsc
cp config.json.example ~/.config/dsc/config.json
chmod 600 ~/.config/dsc/config.json
$EDITOR ~/.config/dsc/config.json
```

```powershell
# Windows PowerShell:
$dir = "$HOME\.config\dsc"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item config.json.example "$dir\config.json"
notepad "$dir\config.json"
```

The template's full contents:

```jsonc
{
  "api_key": "sk-REPLACE-WITH-YOUR-DEEPSEEK-API-KEY",

  "search": {
    "provider": "brave",
    "brave":  { "api_key": "BSA-REPLACE-WITH-YOUR-BRAVE-API-KEY" },
    "tavily": { "api_key": "tvly-REPLACE-WITH-YOUR-TAVILY-API-KEY" }
  }
}
```

You only need `api_key`. The `search` block is optional — leave it out
and `web_search` falls back to the keyless DuckDuckGo HTML scraper.

dsc reads this file from a platform-dependent path:

| Platform | Default path |
|---|---|
| Linux / macOS | `~/.config/dsc/config.json` |
| Windows | `%USERPROFILE%\.config\dsc\config.json` |

On Windows, `%USERPROFILE%` is `C:\Users\<your account name>`, so the
absolute path is e.g. `C:\Users\dann\.config\dsc\config.json`.
Set `XDG_CONFIG_HOME` to override the location on any platform.

The env var `DEEPSEEK_API_KEY` takes priority over the file when both
are set.

### Linux / macOS

```sh
mkdir -p ~/.config/dsc
cat > ~/.config/dsc/config.json <<'JSON'
{
  "api_key": "sk-..."
}
JSON
chmod 600 ~/.config/dsc/config.json
```

### Windows — PowerShell

```powershell
$dir = "$HOME\.config\dsc"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
'{"api_key":"sk-..."}' | Set-Content -Path "$dir\config.json" -Encoding utf8NoBOM
```

`-Encoding utf8NoBOM` matters: PowerShell 5.1's `Set-Content -Encoding
utf8` writes a UTF-8 BOM by default, and not every JSON parser likes
that. dsc is forgiving (it strips a leading BOM), but using the explicit
form keeps the file portable. PowerShell 7+ defaults to no-BOM.

### Windows — cmd.exe

```bat
mkdir "%USERPROFILE%\.config\dsc"
echo {"api_key":"sk-..."} > "%USERPROFILE%\.config\dsc\config.json"
```

### Or skip the file: env var

Any platform, any shell:

```sh
export DEEPSEEK_API_KEY=sk-...                          # bash / zsh
$Env:DEEPSEEK_API_KEY = "sk-..."                        # PowerShell (current session)
[Environment]::SetEnvironmentVariable(`
  "DEEPSEEK_API_KEY", "sk-...", "User")                 # PowerShell (persisted)
set DEEPSEEK_API_KEY=sk-...                             # cmd.exe (current session)
setx DEEPSEEK_API_KEY "sk-..."                          # cmd.exe (persisted)
```

### Accepted file shapes

```jsonc
{ "api_key": "sk-..." }                                   // simple
{ "DEEPSEEK_API_KEY": "sk-..." }                          // alt key
{ "env": { "DEEPSEEK_API_KEY": "sk-..." } }               // env-style
{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-..." } }           // claude-switcher compat
```

## Providers & models

dsc routes by model: each model belongs to a provider, and the active
model selects the transport, API key, and pricing automatically. Pick a
model with `-m <name>` at launch or `/model <name>` in the TUI.

| Model | Provider | Key |
|---|---|---|
| `deepseek-v4-pro` (default) | DeepSeek | `DEEPSEEK_API_KEY` / `api_key` |
| `deepseek-v4-flash` | DeepSeek | `DEEPSEEK_API_KEY` / `api_key` |
| `claude-sonnet-5` | Anthropic | `ANTHROPIC_API_KEY` / `providers.anthropic.api_key` |
| `claude-opus-5` | Anthropic | `ANTHROPIC_API_KEY` / `providers.anthropic.api_key` |
| `claude-fable-5` | Anthropic | `ANTHROPIC_API_KEY` / `providers.anthropic.api_key` |

`/model` (no arg) lists the models available **right now** — a model
only shows up once its provider has a key. DeepSeek always shows so the
first-launch flow has something to select. Switching to a model whose
key isn't set prints how to set it instead of failing on the next turn.

### Adding an Anthropic (Claude) key

Any of:

```sh
export ANTHROPIC_API_KEY=sk-ant-...        # env (any shell)
```
```
> /api-key anthropic sk-ant-...            # in the TUI → writes config
```
```jsonc
// ~/.config/dsc/config.json
{
  "api_key": "sk-...",                      // DeepSeek (unchanged)
  "providers": {
    "anthropic": { "api_key": "sk-ant-..." }
  }
}
```

Then `dsc -m claude-sonnet-5` (or `/model claude-sonnet-5`; the
`claude-opus-5` and `claude-fable-5` ids work the same way). `/api-key`
with no argument shows every provider's key status at a glance.

> OpenAI and Ollama aren't registered yet, but the OpenAI-compatible
> transport that backs DeepSeek already covers them — they're a model
> registry entry + key away.

## Quick start

```sh
dsc                                  # interactive TUI
dsc "summarize src/api.ts"           # one-shot (runs and exits)
dsc --yolo "rename Foo to Bar"       # skip approval prompts
dsc --no-resume                      # fresh session, ignore prior history
dsc -m deepseek-v4-flash             # pick a model for this launch
dsc --resume <id>                    # resume a specific session by id
```

## TUI layout

```
  ── scrollback (selectable, copy/pasteable) ──
  user                       ← prior turns rendered into <Static>
  assistant                  ← so they live in normal terminal scrollback
  ← tool: ok                 ← tool results
  ...
  ── dynamic frame (pinned to bottom) ──
  assistant                  ← currently-streaming message (rebuilds on
  …                            every chunk; rich markdown on finalize)
  ○ task one                 ← agent task list, hidden when empty / all done
  ◐ task two
  ● task three
  → bash(npm test)           ← running tool indicator
  queued (2):                ← prompts you typed while busy
  → run the tests again
  → and commit
  > _                        ← your prompt input
   deepseek-v4-pro  ▲1.4K (h:1.1K m:300) ▼820  ctx:9.2K   0:34
   ↑ status bar (model · in/out tokens · cache hit/miss · ctx · timer)
```

The streaming current-turn renders plain text so re-renders stay cheap;
once the turn finishes it moves into `<Static>` and gets the full
markdown / table / code-block rendering. Approvals appear as their own
modal-style yellow-bordered box; the prompt is greyed out underneath
until you answer.

## Slash commands

Type `/` and TAB completes to the longest unique prefix; an inline dim
ghost-text suggestion previews the match as you type.

| Command | What it does |
|---|---|
| `/api-key [provider] [key]` | No arg: show every provider's key status + signup URL. `<key>` alone saves it as the DeepSeek key (back-compat). `<provider> <key>` saves that provider's key (`deepseek` → top-level `api_key`; others → `providers.<id>.api_key`) to `~/.config/dsc/config.json` with `0600` perms. `<provider>` alone shows that provider's status + signup. |
| `/search` / `/search use <p>` / `/search key <p> [key]` | Inspect / switch the active search provider, or show / save a per-provider key. No-arg prints active provider + key status + signup URLs. `use brave\|tavily\|ddg` writes `search.provider`. `key <provider> [key]` shows signup URL when no key, saves under `search.<provider>.api_key` when given one. |
| `/update` | Force-check npm for a newer release and install it (`npm install -g @este.systems/dsc@latest`). The TUI also checks once a day in the background and surfaces a one-line "X available" notice when behind. |
| `/copy` | Copy the most recent assistant response to the OS clipboard (pbcopy / clip / wl-copy / xclip / xsel). |
| `/export [path]` | Write the current session JSON to `path` (default: cwd, with a `<name|id>-<date>.json` filename). |
| `/import <path> [--keep-cwd]` | Load a session from a JSON file as the active session. Rebinds cwd to the current directory by default so auto-resume picks it up here; `--keep-cwd` preserves the original. Mints a fresh id on collision (no overwrites). |
| `/clear` | Start a new session. Old session stays on disk. Also drops per-tool "always" approvals. |
| `/cost` | Show token usage and estimated cost so far. |
| `/model [name]` | Show or switch model (no arg lists the models available right now). Switching to a provider model whose key isn't set prints how to set it rather than silently failing. See [Providers & models](#providers--models). |
| `/yolo` | Toggle approval mode (write/edit/bash/web_fetch). |
| `/reasoning [on\|off]` | Show/hide `reasoning_content` from thinking models. Default on. |
| `/lang [name\|off]` | Force the model to reply exclusively in a named language. |
| `/auto-continue [N\|off]` | When the agent hits the per-turn tool-call cap, auto-grant up to N extra 24-call budgets. |
| `/list` | List sessions in the current cwd. The active session is marked with `*`. |
| `/resume <#\|id\|name\|last>` | Resume a session by index (from `/list`), id, name, or `last`. |
| `/save <name>` | Name the current session. Show up in `/list` by name. |
| `/rename <text>` | Override the "assistant:" label for the current session. |
| `/queue [clear]` | List or clear the type-ahead queue. |
| `/audit [path\|show N]` | Print the audit log path, or show the last N entries. |
| `/transcript` | Print the full conversation, including any messages compaction archived. |
| `/compact [N]` | Summarize older turns into a synthetic block (kept in the system prompt) and move them to the archive. Keeps the last `N` user turns verbatim (default 4). Cumulative across re-runs. |
| `/edit [text]` | Open `$VISUAL`/`$EDITOR`/`vi` on a tmp file; the saved content runs as the next prompt. |
| `/review [n]` | Critically review the last (or Nth-last) assistant response — identifies errors, omissions, and offers an improved version. |
| `/plan <description>` | Generate a step-by-step implementation plan for the task. The agent outputs a numbered task list; a compact progress indicator appears above the prompt. `/plan:show` to review, `/plan:go` to execute the next pending task, `/plan:done` to mark complete, `/plan:skip [n]` to skip, `/plan:clear` to discard. |
| `/version` | Print version (dsc, Node, platform/arch). |
| `/help` | Show the in-app help. |
| `/exit` | Quit. |

### Multi-line input

End a line with a single `\` to continue on the next line (bash-style).
`\\` is treated as a literal trailing backslash. The TUI renders the
accumulated buffer above the active prompt dim with a `… ` marker so
you can see what's queued. ESC cancels the buffer. For longer or
paste-heavy drafts, use `/edit`.

```
> please write a function\
… that takes (a, b, c)\
… and returns a + b + c
```

### Hotkeys

| Key | Where | What |
|---|---|---|
| `Up` / `Down` | Prompt | Recall past prompts (persisted across sessions in `~/.local/state/dsc/history`). |
| `Tab` | Prompt | Complete a partial `/slash` command. The TUI also previews the match as dim ghost text inline. |
| `Ctrl+A` / `Ctrl+E` | Prompt | Cursor to start / end of line. |
| `Ctrl+U` / `Ctrl+K` | Prompt | Delete to start / end of line. |
| `Ctrl+W` | Prompt | Delete the word before the cursor. |
| `y` | Approval | Approve this call. |
| `a` | Approval | Approve this call **and** auto-approve future calls of the same tool for the rest of this session (cleared by `/clear`). |
| `n` / `ESC` | Approval | Reject. |
| `ESC` | Turn busy | Abort the in-flight turn. |
| `ESC` | Multiline | Clear the accumulated backslash-continuation buffer. |
| `Ctrl+C` | Turn busy | Abort the in-flight turn. |
| `Ctrl+C` / `Ctrl+D` | Idle | Exit cleanly. |

### Agent task list

Non-trivial multi-step requests trigger the model to reach for the
`task_create` / `task_update` / `task_list` tools. The TUI renders the
list above the prompt as `○ pending` / `◐ in-progress` / `● completed`
bullets so you can watch the agent's plan execute. Hidden once every
task is `completed`. Lives only in memory — cleared by `/clear` and on
exit.

### Session scoping (per-directory)

Sessions are tied to the directory you launched dsc from — that's how
auto-resume figures out which conversation to bring back.

- Run `dsc` in `~/code/foo` → it auto-resumes the most recent session
  whose `cwd` is `~/code/foo`. If there isn't one, you start fresh.
- `cd` into `~/code/bar` and run `dsc` → you get bar's last session,
  not foo's. Project conversations stay scoped to their project; you
  can't accidentally bleed astrophysics notes into a CLI refactor.
- `/clear` starts a brand-new session **for the current cwd**. The old
  one stays on disk and shows up in `/list` next time you're back.
- `/list` shows only sessions whose `cwd` matches the current
  directory. `/resume <#>` resolves indices from that list.
- `/resume <id>` (or a `/save`'d name) **can** cross cwds — useful
  if you want to revisit a session from elsewhere; the cwd it was
  born in stays attached to it.
- `--no-resume` skips auto-resume entirely and gives you a fresh
  session this launch.

Each session is a single JSON file under
`~/.local/share/dsc/sessions/`. Open one in your editor if you want to
see exactly what got persisted, including any compacted summary and
the archived messages from `/transcript`.

## Tools the agent can use

| Tool | Approval | Notes |
|---|---|---|
| `read_file(path, offset?, limit?)` | none | 2000 lines default; long lines truncated. |
| `list_dir(path?)` | none | Non-recursive directory listing (dirs first, `/` suffix; symlinks `@`; dotfiles included). Defaults to cwd. No approval, cross-platform — prefer over `bash ls`/`dir`. |
| `grep(pattern, path?, glob?, case_insensitive?)` | none | ripgrep when available, `grep -rn` fallback. |
| `glob(pattern, path?)` | none | Node 22+ `fs.glob`, capped at 500. |
| `web_search(query, count?, freshness?)` | none | Pluggable backends (Brave / Tavily / DuckDuckGo). |
| `task_create(subject, activeForm?)` | none | Adds a pending task to the user-visible task list. |
| `task_update(id, status?, subject?, activeForm?)` | none | Moves a task between pending / in_progress / completed. |
| `task_list()` | none | Returns the current task list with statuses. |
| `write_file(path, content)` | yes (unless `--yolo`) | Side-by-side diff inside the approval dialog. |
| `edit_file(path, old_string, new_string, replace_all?)` | yes | Exact substring replace; old_string must be unique unless `replace_all=true`. |
| `multi_edit(path, edits)` | yes | Apply a sequence of edits to one file atomically (all-or-nothing). Each edit is `{old_string, new_string, replace_all?}`, applied in order; one approval shows the cumulative diff. Beats N `edit_file` calls for multi-change refactors. |
| `bash(command, description?, timeout_ms?)` | yes | `/bin/sh` on Linux/macOS, `cmd.exe` on Windows. Output capped at 16 KB. |
| `web_fetch(url)` | yes | HTML stripped to text, capped at 50 KB. |

Read-only tools never prompt. The rest do unless `--yolo` is on or
you've previously said `a` (always) for that tool this session. The
`task_*` tools mutate an in-memory list that the TUI renders above the
prompt; the model is encouraged (via the system prompt) to reach for
them on non-trivial multi-step asks so the user sees real-time progress.

## Persistent preferences

Slash commands that set a session-level toggle save their value to
`~/.config/dsc/preferences.json` (XDG-aware) so the next launch starts
the same way. Persisted settings:

| Slash | Notes |
|---|---|
| `/yolo` | Approval-mode toggle. Persists, but the next launch surfaces a red `warning: yolo is on` line so you can't silently forget it's on. `--yolo` on the command line forces it on regardless of saved state. |
| `/reasoning [on\|off]` | Show / hide `reasoning_content`. |
| `/auto-continue [N\|off]` | Per-turn MAX_TOOL_DEPTH budget. `$DSC_AUTO_CONTINUE` env var still wins over the saved value. |
| `/budget [usd\|off]` | Session cost ceiling. Next launch announces it (red `warning:` line) so an unexpected abort can't catch you off guard. |

Per-session settings (`/lang`, `/model`, `/rename`, `/save`) ride along
with the session JSON under `~/.local/share/dsc/sessions/`, so `/resume`
restores them. Preferences here are separate — they're "how I always
want dsc to start", not "what this conversation needs".

Inspect with `/preferences`; wipe with `/preferences reset` (deletes
the file; current session keeps its in-memory state).

## Per-project instructions

Drop a Markdown file at the project root (or any ancestor of your cwd)
and dsc will append it to the system prompt every turn — same idea as
`CLAUDE.md` in Claude Code, project-tested with the convergent
`AGENTS.md` convention. Use it to teach the agent project conventions
without re-typing them in every conversation.

dsc looks in three places, in this order:

| Path | Purpose |
|---|---|
| `~/.config/dsc/instructions.md` | User-global — personal preferences across all projects (default response language, "prefer ripgrep over grep", etc). |
| `AGENTS.md` | Project-level, walked up from cwd. Shared with other agents that read the convergent `AGENTS.md` convention. |
| `.dsc/instructions.md` | Project-level, dsc-only. Useful when a rule should apply when working through dsc but not when other agents look at the repo. |

Each present file is included as its own labeled section in the prompt,
so the model knows the source. The dsc-specific file appears last and
effectively overrides earlier ones on conflict. Files re-read every turn
— edit them and the next request picks up the change.

dsc also automatically indexes AGENTS.md, README.md, CHANGELOG.md,
and any files the agent has read or edited during the session. Before
each turn it searches these for keywords matching your prompt and
prepends the most relevant paragraphs so the agent has project context
without needing to grep for it. The index is in-memory and rebuilt
on `/clear`.

`/instructions` lists which files are currently active and shows their
content. Empty files are treated as absent. Files larger than 64 KB are
skipped silently — keep instruction files reasonably short, both for the
cache prefix and because the model parses them every turn.

## MCP servers

dsc can connect to remote [MCP](https://modelcontextprotocol.io) servers
at boot and expose their tools to the agent alongside the built-ins.
Configure under `mcp.servers` in `~/.config/dsc/config.json`:

```jsonc
{
  "api_key": "sk-...",
  "mcp": {
    "servers": {
      "tavily": {
        "url": "https://mcp.tavily.com/mcp/",
        "headers": { "Authorization": "Bearer ${TAVILY_API_KEY}" }
      }
    }
  }
}
```

Per-server fields:

| Field | Notes |
|---|---|
| `transport` | `"http"` or `"stdio"`. Inferred from which of `url`/`command` is set; specify when ambiguous. |
| `url` | Required for HTTP transport. Remote MCP endpoint. |
| `headers` | HTTP only. Static map merged into every request. `${VAR}` references expand against `process.env` at connect time; missing vars throw. |
| `query` | HTTP only. Appended as URL query params (e.g. `?tavilyApiKey=…`). Same `${VAR}` expansion. |
| `command` | Required for stdio transport. Executable for the local subprocess (e.g. `"npx"`). |
| `args` | stdio only. Argv list. `${VAR}` expanded. |
| `env` | stdio only. Extra env vars for the child, merged on top of `process.env` so it still sees PATH etc. `${VAR}` expanded. |
| `requireApproval` | `"always"` / `"never"` / `"auto"`. Defaults: `"always"` for stdio (local subprocesses usually touch the filesystem), `"auto"` for HTTP (heuristic on tool names — write/delete/send/run/etc trigger the dialog; read/list/search/get pass through). The `a` (always) answer adds the namespaced tool name to a session-scoped allowlist so repeats skip the prompt. |
| `enabled` | Optional, default `true`. Set to `false` to skip without removing the entry. |
| `timeoutMs` | Optional connect timeout. Default 8 s. |

Each server's tools are advertised to the model as `mcp_<server>_<tool>`,
so two servers exposing the same tool name don't collide. `/mcp` shows
the connected servers + their tools.

Example with both transports:

```jsonc
{
  "mcp": {
    "servers": {
      "tavily": {
        "url": "https://mcp.tavily.com/mcp/",
        "headers": { "Authorization": "Bearer ${TAVILY_API_KEY}" }
      },
      "fs": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"]
      }
    }
  }
}
```

## Headless mode (`dsc serve`)

`dsc serve` boots a WebSocket daemon on `127.0.0.1:9090` that exposes
the full agent loop — tools, MCP, DeepSeek streaming — over a typed
JSON protocol. Useful for editor plugins, automation, remote frontends,
or anywhere you want dsc's brain without ink's TUI in the way.

```sh
dsc serve                  # default port 9090
DSC_SERVE_PORT=9191 dsc serve
```

The daemon prints its address + pid to stderr on boot, then waits for
clients. Each client connection runs against the same daemon-global
session (multi-client coordination lands in a later 1.x release).

### Protocol

Newline-delimited JSON over WebSocket. The daemon sends a `hello`
immediately on connect with `protocol_version: 1`. Then:

| Direction | Type | Purpose |
|---|---|---|
| → client | `hello` | Sent on connect. Includes protocol version + dsc semver. |
| → client | `token` | Streaming assistant text delta. |
| → client | `thinking` | Streaming reasoning tokens (when reasoning is on). |
| → client | `tool` | Assistant is calling a tool. Carries `name` + `args`. |
| → client | `tool_result` | Tool finished. Carries `name`, `content`, `rejected`. |
| → client | `notice` | Informational message (status, error). |
| → client | `approval_request` | Daemon needs the user to approve a tool. Includes `id`, `title`, `body`. |
| → client | `turn_end` | Assistant finished generating. |
| client → | `prompt` | Send a prompt: `{ "type": "prompt", "text": "..." }`. |
| client → | `approval_response` | Answer: `{ "type": "approval_response", "id": <n>, "answer": "yes"\|"no"\|"always" }`. |
| client → | `slash` | Run a slash command: `{ "type": "slash", "command": "cost" }`. |

Source: [`src/serve_protocol.ts`](src/serve_protocol.ts).

### Quick try

```sh
# terminal A
dsc serve

# terminal B (requires `npm i -g wscat`)
wscat -c ws://127.0.0.1:9090
> {"type":"prompt","text":"list files in this repo"}
```

### Dependencies

The `ws` package is an **optional** runtime dependency — users who never
run the daemon don't pay for it. If you install with
`--omit=optional` or `--no-optional`, `dsc serve` will fail with a
clear "ws not installed" error on launch.

### Status

Phase 1: single-client baseline. Slash command dispatch, server-initiated
events (background MCP completion, version notices), approval round-trip
completion, and multi-client coordination are tracked in
[`docs/headless-serve-plan.md`](docs/headless-serve-plan.md).

## Sessions and history

Each session is a JSON file under `$XDG_DATA_HOME/dsc/sessions/`
(default `~/.local/share/dsc/sessions/`) keyed by id. It carries:

- `messages` — the active conversation log (sent to the API).
- `archivedMessages` — older messages that `/compact` has summarized away.
  Persisted on disk for `/transcript`, never sent to the API.
- `compaction` — the cumulative summary text and metadata.
- `stats` — token / cost / tool-call counters.
- `model` — last selected model.

Saves happen on every `onTurn` callback (after each assistant message,
after each tool result), with a single-in-flight, coalescing writer —
so a Ctrl+C / OOM / power loss mid-turn won't cost you the latest
committed state.

## Compaction

`/compact [N]` summarizes everything before the last `N` user turns,
stores the summary on the session, archives the original messages, and
trims `messages` to the kept tail. The summary appears in the dynamic
suffix of every subsequent system prompt (`Previously in this session:`),
so the model retains semantic context. Cumulative — re-running `/compact`
folds the prior summary into the new one.

Auto-compact runs the same routine after any successful turn whose
estimated context exceeds `DSC_AUTO_COMPACT_AT` tokens. The default is
model-aware: 10% of the active model's context window, clamped to
`32 000–96 000` (so DeepSeek models compact at 96 000 and Claude at
32 000). Set `0` / `off` / `false` to disable.

`/transcript` prints the full conversation, including archived chunks,
so nothing is lost — just absent from the prompt the model sees.

## Audit log

Every tool execution (including rejected ones) writes one JSONL line to
`$XDG_STATE_HOME/dsc/audit.log` (default `~/.local/state/dsc/audit.log`).
Each line carries `ts`, `session`, `cwd`, `tool`, `approved`, plus
tool-specific fields:

```json
{"ts":"2026-05-09T15:32:01Z","session":"…","cwd":"/home/dann/code/dsc","tool":"bash","approved":true,"command":"npm test","exit":0,"stdout_bytes":4012,"stderr_bytes":0}
```

Useful greps:

```sh
# every bash command this week
jq 'select(.tool=="bash") | "\(.ts) \(.command)"' ~/.local/state/dsc/audit.log

# things rejected at approval
jq 'select(.approved==false)' ~/.local/state/dsc/audit.log

# files written by a specific session
jq 'select(.session=="abc1234" and .tool=="write_file") | .path' \
   ~/.local/state/dsc/audit.log
```

Disable with `DSC_NO_AUDIT=1`. There's no rotation — at gigabyte scale
you'll want to truncate it yourself.

## File locations

| Path | What |
|---|---|
| `~/.config/dsc/config.json` | API key (and search-provider keys). 0600. Pre-1.1.0 dsc wrote to `~/.config/deepseek/deepseek.json`; that file is copied forward on first launch. |
| `~/.local/share/dsc/sessions/<id>.json` | One file per session. |
| `~/.local/state/dsc/history` | Up/down arrow recall (1000-line cap). |
| `~/.local/state/dsc/audit.log` | JSONL, append-only. |
| `/tmp/dsc-edit-*/prompt.md` | Transient; created by `/edit`, removed on close. |
| `<repo>/dist/` | Compiled output (only used as a fallback for the global shim). |

XDG variables observed: `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | (read from config file) | Overrides the `api_key` in `config.json`. |
| `DSC_AUTO_COMPACT_AT` | model-aware (`32000`–`96000`) | Token threshold for auto-compact. `0`/`off`/`false` disables. |
| `DSC_AUTO_COMPACT_KEEP` | `12` | User turns kept verbatim before the compact cut-point. |
| `DSC_AUTO_CONTINUE` | `0` | When the agent hits the per-turn tool-call cap, auto-grant up to N extra 24-call budgets before stopping. `0`/`off`/`false` keeps the manual "type continue" prompt. |
| `DSC_NO_AUDIT` | (off) | `1` disables the JSONL audit log. |
| `DSC_SEARCH_PROVIDER` | (config or `ddg`) | `brave`, `tavily`, or `ddg`. |
| `BRAVE_API_KEY` | (config) | Brave Search key. |
| `TAVILY_API_KEY` | (config) | Tavily key. |
| `VISUAL` / `EDITOR` | (vi) | Used by `/edit`. |
| `XDG_CONFIG_HOME` | `~/.config` | Config root. |
| `XDG_STATE_HOME` | `~/.local/state` | State root. |
| `XDG_DATA_HOME` | `~/.local/share` | Data root. |

## Search providers

Pick at runtime with `DSC_SEARCH_PROVIDER`:

- **brave** — [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com), 2000 free queries/month. Recommended.
- **tavily** — [tavily.com](https://tavily.com), 1000 free/month, agent-tuned snippets.
- **ddg** — DuckDuckGo HTML scrape, no key, brittle.

Per-provider keys live in the config:

```jsonc
{
  "api_key": "sk-...",
  "search": {
    "provider": "brave",
    "brave": { "api_key": "BSA..." }
  }
}
```

`{PROVIDER}_API_KEY` env var (e.g. `BRAVE_API_KEY`) overrides the
file value.

## Packaging and distribution

For local global install (any platform with Node 22+):

```sh
npm run package              # produces pkg/<name>-<version>.tgz
scripts/install.sh           # linux / macOS  — wraps `npm install -g pkg/*.tgz`
.\scripts\install.ps1        # Windows PowerShell — same idea
```

The build is driven by the `prepack` lifecycle hook (`scripts/build.mjs`),
which wipes `dist/` before recompiling. That keeps stale artifacts (e.g.
leftover from a branch switch) out of the tarball whether you ran
`npm pack`, `npm publish`, or `npm run package`.

What ships is controlled by the `files` field in `package.json` (currently
`bin/`, `dist/`, `README.md`, `LICENSE`). Source TypeScript and devDeps are
deliberately excluded.

### Publishing to npm

The package is configured to publish as `@este.systems/dsc` with public
access. To release:

```sh
# 1. Roll the `## [Unreleased]` section in CHANGELOG.md into a dated
#    `## [X.Y.Z] - YYYY-MM-DD` header and add the compare link at the
#    bottom. Commit the changelog edit before npm version so the bump
#    commit and the changelog entry land in the same release.

# 2. Bump the version (semver):
npm version patch                       # → 1.0.1 (creates a commit + git tag)
                                        # use `minor` or `major` for the others

# 3. Make sure you're logged in to npm:
npm whoami                              # should print your username
npm login                               # if not

# 4. (Optional) preview the tarball:
npm pack --dry-run

# 5. Publish:
npm publish                             # respects publishConfig.access=public

# 6. Push the version-bump commit and tag:
git push --follow-tags
```

Notes:

- The package name is **scoped** (`@este.systems/dsc`), so `npm publish`
  defaults to private. `publishConfig.access = "public"` in `package.json`
  overrides that. Don't drop it.
- npm now nudges hard for **2FA**. Enable with
  `npm profile enable-2fa auth-and-writes`. You'll be asked for an OTP on
  every publish.
- Once published, anyone can install with
  `npm install -g @este.systems/dsc`. The CLI binary is still just `dsc`.
- After publish, the `pkg/*.tgz` produced locally is identical to what
  you uploaded — useful for offline installs (`scripts/install.sh`).

## Development

```sh
npm run dev                  # tsx src/tui.tsx
npm run typecheck            # tsc --noEmit
npm test                     # node --test, runs tests/*.test.ts via tsx
npm run build                # compiles to dist/
npm run package              # build + npm pack into pkg/
```

Tests live under `tests/`, separate from `src/` so they don't ship in
the npm tarball. The runner is Node's built-in `node --test` invoked
through `tsx` (no extra test-framework dependency). CI runs the same
command on Linux, macOS, and Windows for every push and PR.

Source layout:

```
src/
  tui.tsx           # entry: arg parsing, session + agent wiring, slash dispatcher
  agent.ts          # tool-call loop, AgentEvents emitter, repair logic
  api.ts            # DeepSeek client, retry/abort, prompt cache rates, saveApiKey
  tools.ts          # tool schemas + executors (read/write/edit/bash/grep/glob/web_*/task_*)
  approval.ts       # confirm{Write,Edit,Bash,Fetch} + ApprovalPayload + 3-state answer
  audit.ts          # JSONL audit logger
  search.ts         # Brave / Tavily / DDG dispatch
  compact.ts        # /compact summarization routine
  history.ts        # session save/load/list, /export, /import, migrate-legacy
  repl_history.ts   # ~/.local/state/dsc/history reader/writer (prompt recall)
  ui.ts             # Spinner used by one-shot mode
  prompt.ts         # SYSTEM_PROMPT + buildSystemPrompt
  editor.ts         # $EDITOR launcher for /edit
  slash.ts          # SLASH_COMMANDS list + TAB-completion helper
  store.ts          # TUI pub/sub state container (history, agentTasks, queue, etc.)
  update.ts         # npm registry probe + `npm install -g` runner for /update
  clipboard.ts      # cross-platform clipboard write (pbcopy / clip / wl-copy / xclip / xsel)
  tui/
    App.tsx              # root layout
    History.tsx          # <Static> for finalized turns
    CurrentTurn.tsx      # in-progress streaming message
    Markdown.tsx         # markdown → ink Text-tree (incl. tables)
    AgentTaskList.tsx    # task_* bullets above the prompt
    QueuedPrompts.tsx    # dim list of pending submissions
    TaskLine.tsx         # "→ tool(...)" indicator while a tool runs
    StatusBar.tsx        # full-width inverse-video status line w/ busy spinner
    PromptInput.tsx      # backslash-continuation buffer + prompt char
    Input.tsx            # custom controlled input (cursor, history, TAB + ghost suggest)
    ApprovalDialog.tsx   # yellow-bordered modal with inline diff/command preview
    useStore.ts          # selector + equality hook over store.ts
```

The agent loop in `agent.ts` supports two output modes via a single
flag. With an `events` callback set (the interactive TUI), it emits
structured events — assistant start/content/reasoning/final, tool
start/end, notice — that the TUI pipes into the store. Without
`events` (one-shot mode), it writes the same information directly to
stdout as plain text. Same loop, same tool plumbing, just two thin
output adapters.
