<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

Real-time statusline HUD for [OpenAI Codex CLI](https://github.com/openai/codex). Lightweight, zero-config, works inside tmux.

> Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) for Claude Code.

![Codex HUD — Single Session](./doc/fig/single.svg)

## Why Codex HUD?

**Q: Codex CLI already works. Why do I need a HUD?**

Because you're flying blind without one. Codex HUD gives you a persistent dashboard at the bottom of your terminal:

- **Branch, model, permissions** — at a glance, no guessing
- **Token usage (including cache) and context remaining** — see when you're about to hit the wall
- **Current turn, tool, plan, and subagent state** — watch what Codex is actually doing
- **Rate-limit and collector-health warnings** — distinguish no data from stale or failed data
- **Approval, sandbox, Fast, MCP, and Codex skills** — security-critical state stays visible first
- **Reasoning effort level** — see the current thinking depth

**Q: I run multiple Codex sessions. Can I monitor them all?**

Yes. Click the visible `[view]` button, or run `codex-hud --toggle-mode` from the main pane;
`Prefix+H` toggles it from the Codex pane too — the wrapper installs that
binding whenever the key is unbound (`CODEX_HUD_BIND_TOGGLE=0` skips it, `1`
forces it), and the hint line names what this session actually has. The HUD
reports mouse events itself, so wheel-scrolling over it cycles the tool-detail
level instead of dropping the pane into tmux copy-mode (which used to freeze
the view on its last frame). Overview lists sessions worked
in the last 30 minutes — not only those mid-turn at that instant — sorted by
live phase, then by how recently each was touched, with context remaining as the
tiebreak. It marks the session this HUD is bound to with `▸`, and keeps that row
visible even when there are more sessions than rows. Pane findings the owning
HUD confirms — an approval wait, a stream-error-interrupted turn, an exited
Codex — travel with its published binding, so every dashboard shows
`Approval`/`Interrupted`/`Exited` instead of a stale `Thinking` or `Idle`;
exited sessions sort below idle ones. A confirmed fresh `/new` prompt travels
the same way: the row reads `New prompt` instead of the previous session's
idle state. Each row ends with the
tmux session hosting it — the name `tmux ls` and the session chooser use, so a
row you want to reach is one you can address; sessions found by the rollout scan
alone fall back to their session ID. A model column appears only when the
listed sessions do not all run the same model, and a title column — the
session's first prompt, the label `codex resume` lists it under — whenever the
width allows, because two sessions open in one project used to differ only by
the tail of an opaque tmux name; the same title sits on the single view's first
row. The account's quota window is
listed below the sessions, because it is the one number that applies to every
row at once; it takes a row from the list only once usage is high enough to be
a warning. The scan runs when the mode is entered, so the session this HUD is
bound to is listed immediately and the others join it a moment later. The wheel
over the HUD (or `t` while the pane is focused, or `codex-hud --cycle-details`
from the main pane) cycles the tool-detail level (`targets` → `full` → `off`,
wheel-up goes back) and briefly confirms the new level.

![Codex HUD — Multi-Session Overview](./doc/fig/overview.svg)

**Q: Do I need to set up tmux manually?**

No. Codex HUD auto-activates tmux for you. Just type `codex` and the HUD appears. If tmux isn't installed, the installer handles that too.

The default view keeps compact counts beside context remaining, and reserves space for approval, failure, interruption and abort states before diagnostics. `Last call` means `last_token_usage` (one model request); `Total` is the session's accumulated usage. Input/cache/output breakdowns and the longer environment inventory appear in `full` details mode. Concurrent calls keep an accurate running count even when older calls leave the recent-history list.

Control commands prefer the current tmux pane's session. Outside tmux, they auto-select only a unique candidate in the current directory; multiple candidates produce a list and require `--target <exact-session-name>` or `--target %<pane-id>`. `--all` is available only for `--kill` and `--reload`, scoped to the current directory. Clicks on content no longer switch views; use the visible `[view]` button or the existing keyboard controls.

Overview retains the address, phase and numeric context before decorative columns, and abbreviates optional titles to fit. Failed scans retain the last successful rows with a warning; unreadable sessions keep their identity with `Unknown` state. Missing/dead HUD panes no longer count as open bindings. Quota snapshots and burn-rate baselines are shared only between the same resolved `CODEX_HOME` and sessions directory; the first reading after upgrading starts a fresh baseline.

## Quick Start

### macOS/Linux (`main`)

```bash
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch main
./bin/codex-hud-install

# Refresh your shell, then just type:
codex
```

### Windows (WSL) (`feature/windows-support-dual-entry`)

```powershell
git clone https://github.com/fwyc0573/codex-hud.git
cd codex-hud
git switch feature/windows-support-dual-entry
.\bin\codex-hud-install.ps1

# Open a new PowerShell or cmd window, then check:
codex --self-check

# Run with the WSL HUD:
codex
```

### Management Commands

After the first install, these are available in your shell:

| Command | Description |
|---------|-------------|
| `codex-hud-sync` | Rebuild and refresh aliases for the current checkout |
| `codex-hud-upgrade` | Build the current tracking-branch update in isolation, then fast-forward and refresh aliases |
| `codex-hud-uninstall` | Remove aliases and stop HUD sessions |
| `codex-hud --doctor` | Check Codex, Node, tmux, build output, and aliases, and print the most recent HUD diagnostics |
| `codex-hud --kill` | Kill the current tmux session, or the unique session in this directory when outside tmux (`--all`: every session here) |
| `codex-hud --reload` | Rebuild when needed, then restart the current/unique HUD pane; `--target NAME` or `--target %ID` selects explicitly |
| `codex-hud --reload --all` | Same, but reload every codex-hud session in this directory |
| `codex-hud --toggle-mode` | Toggle single/overview mode without moving focus |
| `codex-hud --cycle-details` | Cycle the tool-detail level without moving focus |
| `codex-hud --list` | List every codex-hud session with its working directory, attach state, and whether its HUD pane is still alive — a HUD process older than the build on disk is marked `HUD: outdated`, and the newest session of the current directory (the automatic launch/attach target) is marked `(newest here…)` |
| `codex-hud --hud-version` | Print the package version and checkout revision |

## What's on the HUD?

The default view uses the terminal foreground with a cyan accent, bold project names, and quieter labels and completed tools. Yellow marks permissions, approval waits or capacity pressure; red marks errors or critical capacity. Overview columns align with whitespace. The wheel or `t` switches to `full` for the complete environment inventory, Git file counts and token breakdown. Narrow panes shed the gauge and equivalent token count before the remaining percentage or bold compact count, and the header reserves space for `[view]`.

Previews: [light terminal](./doc/fig/single-light.svg) · [60-column pane](./doc/fig/single-narrow.svg). These are generated by the actual renderer with `npm run docs:previews`.

```text
my-project git:(main *)  gpt-5.6-sol high  fix the flaky e2e run  up 12m
[FULL ACCESS] · Fast: on
Ctx: ███████▁▁▁▁▁ 55% left (70.4K) · ↻3 · Total: 1.2M · Last call: 50.2K
● Thinking 42s · event 8s ago
● exec: npm test 1.4s · ✗ exec: rg pattern @other-repo exit 1 · ✓ read_file ×3
```

The context gauge is a fuel bar: filled cells show what remains, matching the
`% left` label, and the color reflects pressure (cyan → yellow → red). `Last call`
is the latest model request's token usage and `Total` the session's cumulative spend. The
title is the session's first prompt. Every glyph comes from a set
verified against a terminal font that lacks the half-filled circles and light
shades (◐ ░ ⏸ rendered wide or at the wrong height there): the activity marker
is a dot that pulses once per painted frame, the gauge track is a low block,
and a paused call is marked `▲`.

Before a Codex session is bound the HUD says `○ Waiting for a Codex session…`
rather than rendering a short frame that could be mistaken for a failure.

| Line | Shows |
|------|-------|
| **Header** | Project, git branch, model + effort, and how long the bound Codex session has run. Before the first collector round the model reads `…` and the duration is absent, because neither is known yet |
| **Security/environment** | `[FULL ACCESS]`, approval/sandbox/Fast first (cells the badge already implies are dropped, and the default `Fast: off` is omitted — the Codex footer two rows above already states it); MCP, Codex skills, hooks, AGENTS.md, and config sources appear in `full` details. When the pane is short of rows and every one of these cells fits beside row 1, the whole row moves up there instead of costing a row. Approval and sandbox come from the session's own records first, then from the launch flags on the pane's live Codex process (`--yolo`, `--ask-for-approval …` — flags override the config file, and until a 0.149 session's first message no record exists for them to have reached), and only then from config; a bound session with no records and no readable flags shows `?`/`[ACCESS ?]` rather than presenting the overridden config as fact. One exception restores the config early: an argv captured and walked to its very end with no policy flag and no profile proves the config un-overridden, so a plain launch no longer waits on `?` until its first message |
| **Capacity** | Context percent/tokens remaining, input/cache/output, session total, compact count; the quota window and its reset time are stated whenever the pane has a row to spare — as what remains (`5h 6% left`), the direction the context gauge above and the Codex footer below already use — and highlighted from 70% usage onward, while a window whose reset time has already passed is dropped rather than replayed. Rate limits are account state, so the figure comes from the newest snapshot any Codex session on this machine wrote that actually states one — once a window is spent Codex writes windowless snapshots, and taking the newest of those blanked the row at exactly 100% used. A snapshot carrying no window at all but an empty credit pool reads `credits: 0`; during such an exhaustion stretch the scan keeps walking older files until it finds a reading that still states the reset time, instead of stopping at a fixed count of windowless ones. That reading's windows are retained on the exhaustion snapshot itself, so the row keeps the one number that says when work resumes: `5h 0% left · resets in 3h47m · credits: 0` — measured 2026-08-31, the 5h window's reset time (the Codex pane's own "try again at 9:18 PM") had otherwise left the HUD for the whole 3h47m. A reset less than a day away is stated as a countdown (`resets in 2h13m`); and once a window is half spent — or a full day of readings stands behind the pace, whichever comes first — two dated readings give its burn rate, so a pace that would exhaust it before its reset is stated on the row, named for its window (`→ 7d empty ~08/22`, `→ 5h empty in 40m`). Codex 0.150 turned the single weekly window into a 5h primary with the weekly demoted to secondary; the tracker keeps one baseline per window length, so the weekly forecast survives that swap — a single-series tracker read every 5h snapshot as a stale replay of the stored weekly one and silently stopped learning. The burn-rate baseline is shared through a small per-user state file, so every HUD forecasts the account the same way — two panes used to disagree by a day — and a `--reload` no longer restarts the baseline clock |
| **Health** | Plain-language state for Git, session log, agents, project scan, config, overview, and the HUD's own display, plus counts of Codex response/event records this build does not recognize, named (`2 unrecognized Codex records: item_started`). Unknown *top-level* record types (Codex adds one with most releases, `token_usage_record` in 0.153) are a separate dim note that names them and is the first row to go, not a warning; the same note says `probes slow · tmux 5.4s` when a tmux/ps/git probe ran past two seconds, so a dashboard that is stale because the machine is loaded is not mistaken for a dead one. A collector that has not finished its first run is silent — only something that stopped working is a warning. When `dist/` is rebuilt while a HUD is running, a dim `HUD updated on disk · codex-hud --reload` line appears here, because the pane keeps executing whatever build it was spawned with |
| **Activity** | Thinking/Running tool/Responding/Idle, tool duration/result, plan progress, and active subagents. An idle session also states how long its last turn took. A turn Codex itself ends on an error (`task_complete.error`: a usage-limit hit, a model at capacity, a stream that died) reads `✗ Turn failed · usage limit · after 16m17s` — the provider's verdict and the work it cost, never a completion: measured 2026-08-31, four of twelve turns across two live sessions ended this way, one after 35 minutes, and each had read `✓ Idle · waiting for you` and paged as a completed turn. Every wrapped shell command reads `exec` — one name for one kind of activity, whether Codex sent a single command or a script of several (a wrapped tool that is not a shell command, `web_search` or `update_plan`, still surfaces its own name). The `@dir` tag appears only on a command that ran outside the session's own directory; Codex sends a workdir on every call, and tagging the session cwd itself said nothing. A command that exits non-zero is marked `✗` with its exit code, including when Codex ran it inside a script that itself succeeded. A stream error is drawn only on the Codex TUI and never written to the session log, so a turn it kills would spin as `Thinking` forever; after minutes of silence the HUD checks the Codex pane for the error banner and, only if it is there, reads `✗ Turn likely interrupted`. When Codex itself exits — quit, crash, or a declined trust prompt — the wrapper hands the pane back to your shell and nothing on disk says so; a quiet session's pane is probed for a live Codex process (Codex runs as a grandchild, so tmux's own pane command still reads as the shell), and a pane without one reads `○ Codex exited · run codex to restart` instead of claiming to wait for input nothing will consume. After `/new`, Codex 0.149 registers nothing at all until the session's first message — no rollout, no session-store row — so the previous session's last state would stand indefinitely; a quiet pane whose composer footer shows a brand-new session (`Context 100% left · Ready`) reads `○ New session at the prompt · binds on its first message` instead, and while that hint stands the previous session's context/token and tool-history rows dim, and the session row's Session/CLI/Provider cells with them (the directory and the account quota keep their color), so nothing bright on the HUD contradicts the pane's own footer |
| **Session** | Working directory, session ID, and CLI version; shown after plan and tool history so small panes keep live state visible. The ID is printed in full whenever the row has room, because it is what `codex resume`, `fork`, `archive`, and `delete` take; narrower panes fall back to the abbreviated form |

The layout adapts in both directions. With rows to spare it keeps the turn row
alongside the running-tool row, because they count different things: the turn
row measures how long Codex has been executing tools without pause, the tool row
how long the call in flight has run. When the pane cannot show every row, the
frame is built from its most compressed shape — agents collapsed into one
`● N agents` count, no turn row beside the tool row, no calm quota, the
environment cells merged onto row 1 (or just the `[FULL ACCESS]` badge when
they do not fit there), no session row — and rows are handed back by value
while they fit: expanded agents first, then the turn row, then the calm quota,
then the environment row, then the session row, and last the dim
unknown-record note. Nothing is left blank while there is state to show, and a
taller pane only ever shows more. In adaptive height mode the pane itself
follows the content: it grows to the rows the unclipped layout wants (up to
`CODEX_HUD_HEIGHT_MAX`, at most once per ten seconds) and shrinks back after
the content has stayed smaller for two minutes; a height you set by dragging is
respected until the content changes (`CODEX_HUD_HEIGHT_FIT=0` turns this off).

Narrow panes shed whole cells rather than cutting words. The header keeps the
project name and shrinks the branch; the environment row is the longest run of
its priority order that fits — permissions first, then inventory counts — and
gives its row back entirely rather than showing half a security statement.
Because it is a prefix and not a best-fit packing, widening the pane only ever
adds cells: a shorter low-priority cell can never take the slot of one that
outranks it.

Tool activity stays on one physical line by default. With the default
`CODEX_HUD_TOOL_DETAILS=targets`, execution tools show only a privacy-preserving
command head — the program name plus one known subcommand or script basename,
such as `npm test` or `sed && rg` — never flags, paths, or argument values.
Heredoc bodies are data, not commands: `python3 <<PY` reads as `python3`, its
body lines neither mint fake heads nor spend the segment budget that later real
commands need.
File tools show only sanitized targets. `full` enables sanitized, bounded
command summaries; `off` keeps running counts and failures while hiding targets. Raw stdout/stderr and raw tool
arguments are never retained or displayed.

Codex CLI 0.147 runs every tool through a single `exec` tool whose argument is a
JavaScript program rather than JSON, and reports the command's exit status only
in a separate record. The HUD reads both, so commands, working directories,
patched file names, plan steps, and non-zero exits are recovered from that shape
as well as from the older one.

The renderer measures terminal cells for CJK text, emoji, combining characters,
and ANSI. By default, the pane uses one sixth of the terminal height (bounded to
5–12 rows) and adds up to three rows on narrow terminals. Explicit
`CODEX_HUD_HEIGHT` values remain fixed unless `CODEX_HUD_HEIGHT_AUTO=1` is also
set. Existing sessions adopt the new sizing policy on the next attach or
`codex-hud --reload`. The renderer never emits more rows than the pane height
and marks overflow as `+N hidden`. Set `NO_COLOR=1` or use `TERM=dumb` to
disable color, and set `CODEX_HUD_ASCII=1` for ASCII status glyphs.

### Subagent activity

Expanded mode shows one icon-first row per visible direct child, such as `◐ codex_cli_explore 2m14s ↳2`. The name is the leaf of the typed agent path, and `↳N` is the number of visible active descendants at any depth. A completed or aborted turn disappears immediately unless an active descendant keeps its direct-child aggregate visible. Authoritative rollout or metadata failures remain visible as `✗ <name> tracking error` and retry the same typed child path until it recovers (retries back off from 1s to at most 10s between attempts).

Compact mode shows `Agents: N`, where `N` counts all visible tracked agent nodes in the root-owned tree rather than only the displayed direct-child rows. Multi-session overview excludes typed subagent sessions because their activity is already represented by the owning root session.

`CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` controls the running-turn inactivity window. It defaults to `900000` ms (15 minutes) and accepts only a positive safe integer in milliseconds; invalid, empty, zero, negative, decimal, or unsafe values fail at startup. The timeout hides stale presentation only. It does not interrupt an agent and cannot prove that an agent is hung or has crashed. `starting` and `tracking error` entries do not time out.

## Usage

```bash
codex                        # Launch with HUD
codex --model gpt-5          # Pass any Codex CLI args
codex "help me debug this"   # With prompt
cx                           # Short alias for codex
codex-resume                 # Resume last session
```

Running `codex` without Codex CLI arguments reconnects to the latest HUD tmux
session in the same directory when one exists. Use `codex-hud --new-session` to
force a separate session.

The install aliases `codex` to this wrapper, so it has to be careful about what
it hosts. A prompt, the interactive flags, `resume`, and `fork` start a session
with a HUD. Codex subcommands that do not open a session — `exec`, `login`,
`mcp`, `completion`, `apply`, `doctor`, `update`, `queue`, `migrate-rollouts`,
`agents`, `--version`, and the rest — run in place and keep their own stdout,
so `codex exec "…" | jq`, `codex queue "…"`, and
`codex completion zsh >> ~/.zshrc` behave exactly as they would without the
wrapper. `codex help` reaches the Codex CLI's own help; `codex-hud --help`
documents the wrapper.

<details>
<summary>More commands</summary>

```bash
codex-hud --kill             # Kill the current/unique session (--all: every session here)
codex-hud --list             # List all HUD sessions
codex-hud --attach           # Attach to existing session
codex-hud --new-session      # Force a new session
codex-hud --doctor           # Run diagnostics (--self-check alias)
codex-hud --reload           # Restart the current/unique HUD pane
codex-hud --reload --all     # Restart the HUD pane of every session here
codex-hud --toggle-mode      # Toggle single/overview mode
codex-hud --cycle-details    # Cycle the tool-detail level
codex-hud --hud-version      # Print version and revision
```
</details>

## Configuration

### Environment Variables

HUD display variables are captured from your shell when a session starts and
re-captured by `codex-hud --reload`. A running HUD never sees a later `export`
on its own: tmux panes inherit the tmux server's environment, not your
shell's, so the wrapper bakes every consumed variable into the pane command.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | adaptive `5–12` | One sixth of terminal height, or an explicit fixed row count |
| `CODEX_HUD_MOUSE` | `1` | Enable tmux mouse mode for the session; the HUD pane then takes clicks (toggle view) and the wheel (cycle details) itself |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | Tool detail level: `off`, `targets`, or `full` |

<details>
<summary>All environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_HEIGHT_AUTO` | adaptive: `1`; explicit height: `0` | Add up to three rows on narrow panes |
| `CODEX_HUD_HEIGHT_MIN` | adaptive: `5`; explicit height: `CODEX_HUD_HEIGHT` | Min height in auto mode |
| `CODEX_HUD_HEIGHT_MAX` | `12` | Max height in auto mode |
| `CODEX_HUD_HEIGHT_FIT` | `1` | In adaptive height mode, let the HUD grow the pane to the rows its content needs and shrink it back after two quiet minutes; an explicit `CODEX_HUD_HEIGHT` disables it |
| `CODEX_HUD_AUTO_ATTACH` | `0` | Auto-attach even when Codex CLI args are provided |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | tmux alternate-screen for codex pane |
| `CODEX_HUD_BIND_TOGGLE` | `auto` | Server-wide `Prefix+H` HUD toggle: unset installs it while the key is unbound, `1` always, `0` never |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | Clear scrollback on first render |
| `CODEX_HUD_HISTORY_LIMIT` | `10000` | Scrollback lines for the HUD pane only; the main pane keeps its inherited value |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | Show command heads (`npm test`) for execution tools by default; `full` shows sanitized summaries and `off` retains running counts and failures, hiding targets (the wheel over the HUD, the `t` key, or `codex-hud --cycle-details` cycles this at runtime). Shell builtins never count as the command: `ffmpeg … ; echo ; exit` reads `ffmpeg` |
| `CODEX_HUD_MODE` | `single` | Initial display mode: `single` or `overview` |
| `CODEX_HUD_LOG_FILE` | per-user default | Append HUD diagnostics (watcher/render/tracking errors) to this file. Defaults to `~/Library/Logs/codex-hud/hud.log` on macOS, `$XDG_STATE_HOME/codex-hud/hud.log` elsewhere; set `off` to discard them |
| `CODEX_HUD_NO_ATTACH` | `0` | Deprecated: force a new session instead of attaching |
| `CODEX_HUD_SHOW_OTHER_AGENT_SKILLS` | `0` | Also show `.agents` skill count; `CODEX_HOME/skills` remains authoritative for Codex |
| `CODEX_HUD_NOTIFY_CMD` | (unset) | Shell command run when a session starts needing a human — an approval wait, an interrupted turn, or a hit limit (`approval-needed` / `turn-interrupted` / `limit-reached`) — or finishes a turn of three minutes or longer (`turn-completed`, whose payload carries `turnDurationMs`; shorter turns end with you already watching); a turn Codex ends on an error fires `turn-failed` instead, whatever its length, with `turnDurationMs` and the provider's `error` (`code`, `message`) in the payload. The event JSON arrives on stdin and in `CODEX_HUD_EVENT_JSON`, the bare name in `CODEX_HUD_EVENT`. Fires on transitions only — the first observation after start or rebind seeds silently, and a flapping state is limited to one notification per five minutes. Example: `CODEX_HUD_NOTIFY_CMD='osascript -e "display notification \"$CODEX_HUD_EVENT\" with title \"codex-hud\""'` |
| `CODEX_HUD_ASCII` | `0` | Use ASCII progress and status glyphs |
| `NO_COLOR` | (unset) | Disable ANSI colors when set |
| `CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` | `900000` | Running-agent presentation timeout; positive safe integer milliseconds only |
| `CODEX_HUD_CWD` | (unset) | Override working directory |
| `CODEX_HOME` | `~/.codex` | Codex home directory |
| `CODEX_SESSIONS_PATH` | (unset) | Override sessions directory |

`CODEX_HUD_SESSION_START`, `CODEX_HUD_MAIN_PANE`, and `CODEX_HUD_TMUX_SESSION`
are internal wrapper→HUD plumbing and are not meant to be set manually.

</details>

### config.toml

The HUD reads from `CODEX_HOME/config.toml`:

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## System Support

Runtime requires Node.js `>=20.19.0` (matching Chokidar 5's engine contract) and
tmux. Node.js `>=22.5` is recommended: session binding then uses the built-in
`node:sqlite` instead of spawning the `sqlite3` CLI (which must be installed
separately on 20.x).

| Platform | Status |
|----------|--------|
| Linux | Supported |
| macOS (Apple Silicon) | Supported |
| macOS (Intel) | Testing pending |
| Windows (WSL) | Supported on `feature/windows-support-dual-entry` |

The previews above use synthetic data rendered by the current HUD. Regenerate them with `npm run docs:previews`.

## Development

```bash
npm install                    # Install dependencies
npm run typecheck              # Typecheck only
npm run test:unit              # Build and run unit tests
npm run test:integration       # Build and run isolated integration tests
npm test                       # Typecheck, build, and run all tests
npm run test:render            # Run the render examples
```

## Changelog

| Date | Change |
|------|--------|
| 2026-09-05 | Rollout changes paint at once (fs.watch + wake re-arms the render tick); row budget rebuilt as fill-back with the environment row merging onto row 1; content-fitted pane height; mouse reporting (click toggles, wheel cycles details, no more copy-mode freeze); session title from the first prompt on row 1 and in the overview; verified-safe glyph set and a per-frame spinner; `Turn:` label; unknown-record note names the type; slow-probe note; builtins dropped from command heads; process-tree and Codex-pid caches replace most `ps` spawns; git refresh on tool completion; shared account-quota/git snapshots across HUDs; slow collectors in-process (no worker isolate); `Prefix+H` installed while unbound; `--cycle-details`; `--list` marks the newest session; `--doctor` reports the notify hook |
| 2026-09-03 | codex 0.153 `token_usage_record` whitelisted |
| 2026-09-02 | Failed-turn phase and `turn-failed` notification; exhaustion snapshots keep their windows; quota row states what remains; 24h-baseline forecast gate |
| 2026-08-28 | Per-window burn-rate series (0.150 5h/weekly swap); `exec` display name; session row dims under a fresh prompt; same-directory workdir omitted; argv certification |
| 2026-08-24 | Token carry-over across batches; every consumed variable baked into the pane command; `/new` fresh-prompt detection; 0.149 subcommands passed through; `turn-completed` notification; shared burn-rate baseline; launch flags read off the live process |
| 2026-08-20 | Quota scan walks past degenerate snapshots; `HUD updated on disk` notice; `CODEX_HUD_NOTIFY_CMD`; reset countdown; burn-rate forecast; `Codex exited` detection |
| 2026-08-19 | Quota row survives exhaustion; `Fast: ?` resolves on a complete scan; `--kill` scoped to the newest session; last-turn duration; `--doctor` shows the log; stream-error interruption detection |
| 2026-08-13 | 0.147 code-mode tool details and exit codes; `codex` subcommands passed through; full session id; overview quota and cold-start row |
| 2026-08-12 | Quota expiry and account-wide source; row-budget layout; overview lists open HUDs; bounded first read; provisional frame; calm quota; overview addresses; `--list` details |
| 2026-08-05 | Ctrl+C in the pane; remain-on-exit; `--reload --all`; first frame before collectors; render memoization; worker respawn |
| 2026-08-04 | Command heads for execution tools in `targets` mode, parse-queue/malformed-line freeze fixes, chokidar 5 watcher repair (midnight-safe), async session probes, tracking-error backoff, OSC 8 hyperlinks, aligned overview columns |
| 2026-07-30 | Incremental protocol parsing, async collector caches, health/rate/turn state, Unicode width, privacy, and HUD controls |
| 2026-07-12 | Document authoritative subagent activity, timeout semantics, and overview filtering |
| 2026-04-09 | Add quick install/sync/upgrade/uninstall commands |
| 2026-04-09 | Bind HUD session to current tmux pane; display reasoning effort |
| 2026-02-09 | Keep Codex pane focused after resize; refine mouse-scroll defaults |
| 2026-02-09 | Update session attach defaults and scrollback config |

## License

MIT

## Credits

Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) by Jarrod Watts. Built for [OpenAI Codex CLI](https://github.com/openai/codex).
