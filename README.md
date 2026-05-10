# dsc

A CLI coding agent for [DeepSeek](https://api-docs.deepseek.com/).
Streams responses, calls tools (`bash`, `read_file`, `write_file`, `edit_file`,
`grep`, `glob`, `web_fetch`, `web_search`), keeps per-cwd sessions, and runs
in your terminal as a plain readline REPL — output stays selectable / pasteable
and approvals happen inline.

## Install

Requires Node 22+ (the `glob` tool uses `fs.promises.glob`).

```sh
git clone <repo> ~/code/dsc
cd ~/code/dsc
npm install
npm link        # exposes `dsc` on PATH
```

The `dsc` shim in `bin/dsc.mjs` runs the TypeScript sources directly via
`tsx`, so your edits take effect on the next launch — no rebuild step. If
the shim can't find `node_modules/.bin/tsx` it falls back to `dist/`
(populate with `npm run build` for production-style installs).

## API key

```sh
mkdir -p ~/.config/deepseek
cat > ~/.config/deepseek/deepseek.json <<'JSON'
{
  "api_key": "sk-..."
}
JSON
chmod 600 ~/.config/deepseek/deepseek.json
```

Accepted shapes:

```jsonc
{ "api_key": "sk-..." }                                   // simple
{ "DEEPSEEK_API_KEY": "sk-..." }                          // alt key
{ "env": { "DEEPSEEK_API_KEY": "sk-..." } }               // env-style
{ "env": { "ANTHROPIC_AUTH_TOKEN": "sk-..." } }           // claude-switcher compat
```

The env var `DEEPSEEK_API_KEY` takes priority over the file when set.

## Quick start

```sh
dsc                                  # interactive REPL
dsc "summarize src/api.ts"           # one-shot
dsc --yolo "rename Foo to Bar"       # skip approval prompts
dsc -m deepseek-v4-flash             # pick a model
dsc --no-resume                      # fresh session, ignore prior history
dsc --resume <id>                    # resume a specific session id
```

## REPL commands

| Command | What it does |
|---|---|
| `/clear` | Start a new session. Old session stays on disk. |
| `/cost` | Show token usage and estimated cost so far. |
| `/model [name]` | Show or switch model. Available: `deepseek-v4-pro`, `deepseek-v4-flash`. |
| `/yolo` | Toggle approval mode (write/edit/bash/web_fetch). |
| `/reasoning [on\|off]` | Show/hide `reasoning_content` from thinking models. Default on. |
| `/list` | List sessions in the current cwd. The active session is marked with `*`. |
| `/resume <#\|id\|last>` | Resume a session by index (from `/list`), id, or `last`. |
| `/audit` | Print the path of the JSONL audit log. |
| `/transcript` | Print the full conversation, including any messages compaction archived. |
| `/compact [N]` | Summarize older turns into a synthetic block (kept in the system prompt) and move them to the archive. Keeps the last `N` user turns verbatim (default 4). Cumulative across re-runs. |
| `/edit [text]` | Open `$VISUAL`/`$EDITOR`/`vi` on a tmp file; the saved content runs as the next prompt. |
| `/exit` | Quit. |

### Multi-line input

End a line with a single `\` to continue on the next line (bash-style).
`\\` is treated as a literal trailing backslash. For longer or paste-heavy
drafts, use `/edit`.

```
> please write a function\
… that takes (a, b, c)\
… and returns a + b + c
```

### Hotkeys

`Ctrl+C` aborts the current turn (first press), exits if pressed again
within 1 second. `Ctrl+D` exits cleanly. Up / down arrows recall past
prompts (persisted across sessions).

## Tools the agent can use

| Tool | Approval | Notes |
|---|---|---|
| `read_file(path, offset?, limit?)` | none | 2000 lines default; long lines truncated. |
| `grep(pattern, path?, glob?, case_insensitive?)` | none | ripgrep when available, `grep -rn` fallback. |
| `glob(pattern, path?)` | none | Node 22+ `fs.glob`, capped at 500. |
| `web_search(query, count?, freshness?)` | none | Pluggable backends (Brave / Tavily / DuckDuckGo). |
| `write_file(path, content)` | yes (unless `--yolo`) | Side-by-side diff in the prompt. |
| `edit_file(path, old_string, new_string, replace_all?)` | yes | Exact substring replace; old_string must be unique unless `replace_all=true`. |
| `bash(command, description?, timeout_ms?)` | yes | `/bin/sh -c`, output capped at 16 KB. |
| `web_fetch(url)` | yes | HTML stripped to text, capped at 50 KB. |

Read-only tools never prompt. The rest do unless `--yolo` is on.

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
estimated context exceeds `DSC_AUTO_COMPACT_AT` tokens (default 50 000;
set `0` / `off` / `false` to disable).

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
| `~/.config/deepseek/deepseek.json` | API key (and search-provider keys). 0600. |
| `~/.local/share/dsc/sessions/<id>.json` | One file per session. |
| `~/.local/state/dsc/history` | Up/down arrow recall (1000-line cap). |
| `~/.local/state/dsc/audit.log` | JSONL, append-only. |
| `/tmp/dsc-edit-*/prompt.md` | Transient; created by `/edit`, removed on close. |
| `<repo>/dist/` | Compiled output (only used as a fallback for the global shim). |

XDG variables observed: `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | (read from config file) | Overrides the `api_key` in `deepseek.json`. |
| `DSC_AUTO_COMPACT_AT` | `50000` | Token threshold for auto-compact. `0`/`off`/`false` disables. |
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

The package is configured to publish as `@este-systems/dsc` with public
access. To release:

```sh
# 1. Bump the version (semver). For a pre-1.0 patch:
npm version patch                       # → 0.1.1, also creates a git tag

# 2. Make sure you're logged in to npm:
npm whoami                              # should print your username
npm login                               # if not

# 3. (Optional) preview the tarball:
npm pack --dry-run

# 4. Publish:
npm publish                             # respects publishConfig.access=public

# 5. Push the version-bump commit and tag:
git push --follow-tags
```

Notes:

- The package name is **scoped** (`@este-systems/dsc`), so `npm publish`
  defaults to private. `publishConfig.access = "public"` in `package.json`
  overrides that. Don't drop it.
- npm now nudges hard for **2FA**. Enable with
  `npm profile enable-2fa auth-and-writes`. You'll be asked for an OTP on
  every publish.
- Once published, anyone can install with
  `npm install -g @este-systems/dsc`. The CLI binary is still just `dsc`.
- After publish, the `pkg/*.tgz` produced locally is identical to what
  you uploaded — useful for offline installs (`scripts/install.sh`).

## Development

```sh
npm run dev                  # tsx src/index.ts
npm run typecheck            # tsc --noEmit
npm run build                # compiles to dist/
npm run package              # build + npm pack into pkg/
```

Source layout:

```
src/
  index.ts          # REPL, slash commands, signal handling
  agent.ts          # tool-call loop, status formatting, repair logic
  api.ts            # DeepSeek client, retry/abort, prompt cache rates
  tools.ts          # tool schemas + executors (read/write/edit/bash/grep/glob/web_*)
  approval.ts       # confirmWrite/Edit/Bash/Fetch
  audit.ts          # JSONL audit logger
  search.ts         # Brave / Tavily / DDG dispatch
  compact.ts        # /compact summarization routine
  history.ts        # session save/load/list/migrate-legacy
  repl_history.ts   # ~/.local/state/dsc/history reader/writer
  markdown.ts       # streaming markdown→ANSI renderer (incl. tables, HR, LaTeX→Unicode)
  ui.ts             # Spinner with stall detection; one-line StatusBar
  prompt.ts         # SYSTEM_PROMPT + buildSystemPrompt
```

The `ink-port` branch is a parked experiment — a React-based ink TUI
shell. `main` deliberately stays a plain REPL so output remains
selectable.
