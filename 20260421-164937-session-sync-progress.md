# 会话显示修复进度

## 当前问题

- 现象：HUD 的 `Session:` 会被旧 `shell_snapshots` 里的 thread 绑死，无法跟随当前 Codex 实际打开的新 session。
- 目标：只在 pane 绑定结果对本次 HUD 启动明显失真时，切到更合理的当前 rollout；不破坏多 pane 隔离。

## 根因判断

- `SessionFinder.check()` 只要读到 `CODEX_HUD_MAIN_PANE -> shell_snapshots -> threadId`，就会直接采用该 session。
- 这条链路没有判断该绑定是否已经落后于本次 HUD 启动时间，也不会和同 cwd 的更新 rollout 做最小一致性校验。
- 本机现象与代码一致：`%0` 对应 snapshot 仍停在 `019daa4e-3cba-7082-ab77-3fffb6519c0b`，但同 cwd 下已经有更新 rollout。
- 额外约束：HUD 运行期间用户可能继续打开更新 session，因此旧 snapshot 失真时，修复逻辑应优先回到同 cwd 的最新 rollout，而不是只找“离 HUD 启动时间最近”的 rollout。

## 执行计划

1. 先补失败测试，覆盖“旧 snapshot 压住新 rollout” -> 验证：新增单测先红
2. 最小调整 `SessionFinder` 的 pane 绑定优先级 -> 验证：新增单测转绿，原有多 pane 测试保持通过
3. 跑构建和相关单测 -> 验证：`npm run build` 与相关 `tests/unit` 通过

## 当前状态

- 已完成：
  - 新增两条单测，覆盖“旧 snapshot 压住新 rollout”以及“不能只退到离 HUD 启动最近的 rollout”
  - `SessionFinder` 在 pane 绑定明显过期时，会回退到同 cwd 的最新 active / recent rollout
  - `npm run build` 通过
  - `node tests/unit/test-session-finder-pane-binding.mjs` 通过
  - 用当前仓库实际 `~/.codex` 数据验证，`SessionFinder` 已解析到 `019daf39-584e-77a3-9ba8-0d7ec840d486`
- 当前阶段：可交付
