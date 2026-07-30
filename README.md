<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

Real-time statusline HUD for [OpenAI Codex CLI](https://github.com/openai/codex). Lightweight, zero-config, works inside tmux.

> Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) for Claude Code.

![Codex HUD — Single Session](./doc/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

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

Yes. Click the HUD pane and press `Ctrl+T`, or run
`codex-hud --toggle-mode` from the main pane. Overview sorts sessions by
project, live phase, context remaining, and recent activity.

![Codex HUD — Multi-Session Overview](./doc/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

**Q: Do I need to set up tmux manually?**

No. Codex HUD auto-activates tmux for you. Just type `codex` and the HUD appears. If tmux isn't installed, the installer handles that too.

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
| `codex-hud --doctor` | Check Codex, Node, tmux, build output, and aliases |
| `codex-hud --reload` | Rebuild when needed, then restart only the current directory's HUD pane |
| `codex-hud --toggle-mode` | Toggle single/overview mode without moving focus |
| `codex-hud --hud-version` | Print the package version and checkout revision |

## What's on the HUD?

```text
[gpt-5.6-sol high] my-project git:(main *) | 12m
[FULL ACCESS] | Approval: full access | Sandbox: off | Fast: on | MCP configured: 3 | Codex skills: 5
Ctx: █████░░░░░░░ 55% left (70.4K) | Tokens: 50.2K | (in: 30.0K, cache: 5.0K, out: 15.2K)
◐ Thinking 42s · event 8s ago
◐ exec_command @my-project 1.4s | ✓ read_file ×3
```

| Line | Shows |
|------|-------|
| **Header** | Model + effort, project, git branch, and session duration |
| **Security/environment** | `[FULL ACCESS]`, approval/sandbox/Fast first; then MCP, Codex skills, hooks, AGENTS.md, and config sources |
| **Capacity** | Context percent/tokens remaining, input/cache/output, compact count; rate-limit reset details appear at 70% usage |
| **Health** | Stale/error state for Git, rollout, agents, environment/config, and overview; unknown protocol-event count |
| **Activity** | Thinking/Running tool/Responding/Idle, tool duration/result, plan progress, and active subagents |
| **Session** | Working directory, session ID, and CLI version; omitted first when fixed height is tight |

Tool activity stays on one physical line by default. With the default
`CODEX_HUD_TOOL_DETAILS=targets`, execution tools hide command text while file
tools show only sanitized targets. `full` enables sanitized, bounded command
summaries; `off` hides the tool line. Raw stdout/stderr and raw tool arguments
are never retained or displayed.

The renderer measures terminal cells for CJK text, emoji, combining characters,
and ANSI. It never emits more rows than the pane height and marks overflow as
`+N hidden`. Set `NO_COLOR=1` or use `TERM=dumb` to disable color, and set
`CODEX_HUD_ASCII=1` for ASCII status glyphs.

### Subagent activity

Expanded mode shows one icon-first row per visible direct child, such as `◐ codex_cli_explore 2m14s ↳2`. The name is the leaf of the typed agent path, and `↳N` is the number of visible active descendants at any depth. A completed or aborted turn disappears immediately unless an active descendant keeps its direct-child aggregate visible. Authoritative rollout or metadata failures remain visible as `✗ <name> tracking error` and retry the same typed child path until it recovers.

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

<details>
<summary>More commands</summary>

```bash
codex-hud --kill             # Kill session for current directory
codex-hud --list             # List all HUD sessions
codex-hud --attach           # Attach to existing session
codex-hud --new-session      # Force a new session
codex-hud --doctor           # Run diagnostics (--self-check alias)
codex-hud --reload           # Restart only this directory's HUD pane
codex-hud --toggle-mode      # Toggle single/overview mode
codex-hud --hud-version      # Print version and revision
```
</details>

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | `5` | HUD height in lines |
| `CODEX_HUD_MOUSE` | `1` | Enable mouse/trackpad scrolling |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | Tool detail level: `off`, `targets`, or `full` |

<details>
<summary>All environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_HEIGHT_AUTO` | `0` | Auto-adjust height based on width |
| `CODEX_HUD_HEIGHT_MIN` | `CODEX_HUD_HEIGHT` | Min height in auto mode |
| `CODEX_HUD_HEIGHT_MAX` | `12` | Max height in auto mode |
| `CODEX_HUD_AUTO_ATTACH` | `0` | Auto-attach even when Codex CLI args are provided |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | tmux alternate-screen for codex pane |
| `CODEX_HUD_BIND_TOGGLE` | `0` | Install the server-wide `Prefix+H` HUD toggle |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | Clear scrollback on first render |
| `CODEX_HUD_HISTORY_LIMIT` | `10000` | Scrollback lines for the HUD pane only; the main pane keeps its inherited value |
| `CODEX_HUD_TOOL_DETAILS` | `targets` | Hide execution commands by default; `full` shows sanitized summaries and `off` hides the tool row |
| `CODEX_HUD_SHOW_OTHER_AGENT_SKILLS` | `0` | Also show `.agents` skill count; `CODEX_HOME/skills` remains authoritative for Codex |
| `CODEX_HUD_ASCII` | `0` | Use ASCII progress and status glyphs |
| `NO_COLOR` | (unset) | Disable ANSI colors when set |
| `CODEX_HUD_AGENT_INACTIVITY_TIMEOUT_MS` | `900000` | Running-agent presentation timeout; positive safe integer milliseconds only |
| `CODEX_HUD_CWD` | (unset) | Override working directory |
| `CODEX_HOME` | `~/.codex` | Codex home directory |
| `CODEX_SESSIONS_PATH` | (unset) | Override sessions directory |

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
tmux.

| Platform | Status |
|----------|--------|
| Linux | Supported |
| macOS (Apple Silicon) | Supported |
| macOS (Intel) | Testing pending |
| Windows (WSL) | Supported on `feature/windows-support-dual-entry` |

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
