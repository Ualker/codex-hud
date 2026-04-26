# 会话显示修复进度

## 当前问题

- 现象：HUD 中 `Session:` 一直停留在旧值，没有随着当前 Codex 最新打开的 session 更新。
- 目标：在不扩大改动范围的前提下，让 HUD 展示与当前 Codex 实际活跃会话一致的 session。

## 当前理解与假设

- 会话选择主要集中在 `src/collectors/session-finder.ts`。
- 当前实现会优先使用 `CODEX_HUD_MAIN_PANE -> shell_snapshots -> threadId` 的绑定结果。
- 初步怀疑：当同一 pane 打开了更新的 Codex session，但旧 snapshot 仍然存在时，`SessionFinder` 会持续绑定旧 thread，导致 `Session:` 不刷新。

## 执行计划

1. 记录问题与调试假设 -> 验证：检查真实代码路径与本地会话数据是否支持该假设
2. 补会话切换失败测试 -> 验证：先看到针对性测试失败
3. 最小化修复绑定逻辑 -> 验证：让新增失败测试转绿
4. 运行构建与相关验证 -> 验证：相关测试和 `npm run build` 通过

## 当前进度

- 已确认根因：`SessionFinder.check()` 在 `CODEX_HUD_MAIN_PANE` 存在时，会优先绑定 `shell_snapshots` 里该 pane 对应的 thread。
- 本机证据（2026-04-20）：
  - `~/.codex/shell_snapshots/019daa4e-3cba-7082-ab77-3fffb6519c0b.1776690746557428000.sh` 仍绑定 `%0`
  - 但同一 cwd `/Users/zyb/Desktop/prj/codex-hud` 下，今天已有更新 rollout：
    - `21:29:32` -> `019dab14-fb62-7ac0-8964-02903bdc5b1b`
    - `21:31:01` -> `019dab16-5756-7052-86e2-3c9b57b236d6`
    - `21:32:07` -> `019dab17-5b44-7652-bcd7-a2526933ab8c`
- 结论：旧 snapshot 没刷新时，会持续压住更新的 rollout，导致 `Session:` 停在旧值。

## 候选修复方向

1. 保留 pane 绑定，但当同 cwd 存在更新且活跃的 rollout、而 pane snapshot 仍停留在旧 thread 时，允许切到更合理的新会话（推荐）
2. 始终优先当前 cwd 最新 rollout（实现最简单，但会破坏多 pane 隔离）
3. 仅依赖 HUD 启动时间挑最近 rollout（对 resume / attach 场景不够稳）

## 当前进度

- 进行中：等待确认修复策略；确认后先补失败测试，再做最小修复。
