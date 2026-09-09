# Repository guidance

This is a TypeScript/Node.js HUD rendered with ANSI text inside tmux. The Bash wrapper in `bin/codex-hud` launches Codex and manages HUD panes. Rendered session state comes from rollout JSONL files; SQLite/log metadata is used for session binding, not as an alternate rendering source.

- Build: `npm run build`; type check: `npm run typecheck`.
- Full validation: `npm test` (unit tests in `tests/unit`, integration tests in `tests/integration`). The suite normalizes inherited HUD/color overrides; fixtures use fake tmux or private tmux sockets. Never run legacy manual tmux/e2e scripts against an active user server.
- For wrapper/control changes, test selection with multiple sessions and verify the main Codex pane remains alive. Source/build changes do not reload existing HUD processes.
- Keep dependency versions in `package-lock.json`; install with `npm ci`. `node_modules` and `dist` are generated and ignored.
- User-facing behavior and configuration are documented in `README.md` and `README.zh.md`.
