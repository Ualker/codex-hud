# [高] chokidar 5 不支持 glob，session/snapshot watcher 为死代码

## 概要
chokidar v4 起移除 glob 支持，`rollout-*.jsonl`、`*.sh` 这类模式被当作字面路径 watch，永不匹配任何文件。`createSessionWatcher` 与 `createShellSnapshotWatcher` 因此从不触发 add/change 事件；`/new` 会话的快速绑定路径（`noteRolloutAppeared`）从不生效，全靠 5s 轮询兜底。

另有连带缺陷：session watcher 的 `todayDir` 在构造时固化，跨午夜后（即使 glob 可用）也会指向昨天的目录。

## 影响
- `/new`、`/resume` 后的会话重绑退化为最多 5s 延迟。
- 跨午夜后 watcher 永久失效。
- 当年为绕过该问题启用的 `usePolling` 徒增开销。

## 位置
- `src/collectors/file-watcher.ts:115-133`（修复前）

## 复现步骤
1. 用 FileWatcher 分别 watch 一个 glob 模式和一个字面路径。
2. 创建匹配文件。
3. glob watcher 不触发，字面路径 watcher 触发。

## 修复
- watch sessions 根目录（而非当日目录），用 `filter` 回调按文件名 `/^rollout-.*\.jsonl$/` 过滤，天然跨午夜安全。
- shell snapshots 改为 watch 目录 + `.sh` 后缀过滤。
- 两者恢复原生 fs 事件（去掉 usePolling）。

## 验证
- `tests/unit/test-file-watcher.mjs`：watcher 启动后新建"次日"目录并写入 rollout 文件，断言 add 事件触发且非 rollout 文件被过滤。

## 修复记录
- 状态：已修复
- 修复人：claude
- 修复时间：2026-08-04
