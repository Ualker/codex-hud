# [中] HUD 切换快捷键以全局方式绑定

当前状态：已缓解。tmux 的 prefix key table 仍然属于 server；当前 wrapper 默认 `CODEX_HUD_BIND_TOGGLE=auto`，仅在 `Prefix+H` 没有被占用时安装切换命令，保留已有用户绑定。`0` 禁用安装，`1` 显式允许覆盖。提示行反映本会话实际安装成功的快捷键；也可点击 `[view]` 或执行 `codex-hud --toggle-mode`。

2026-01-30 曾尝试 `bind-key -t "$SESSION_NAME"`，但 tmux 3.5a 的 `bind-key` 不支持该参数，因此没有采用 session 级绑定。2026-08-04 的默认值曾为 `0`；该历史值不代表当前行为。

实现：`bin/codex-hud` 中的 `resolve_bind_toggle` / `prefix_h_is_free`。回归入口：`tests/integration/test-wrapper-toggle-binding.sh`，覆盖已有用户绑定、自动安装、显式强制/禁用及安装失败时的提示。
