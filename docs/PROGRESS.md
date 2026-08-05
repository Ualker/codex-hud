# 变更记录

## 2026-01-29
- 修复 HUD 会话复用失效、macOS hash 兼容、参数转义与固定高度问题。
- 修复 rollout 增量解析竞态、跨批次完成丢失与截断重复统计。
- 新增 issues 归档与索引，统一记录修复状态。
- 更新 README 预览图为 `preview.png`。
- 增加 HUD 高度自适应能力，并补充环境变量说明。
- 窄屏时对 HUD 行进行 ANSI 安全截断，避免换行导致的重复/错位显示。
- 增加刷新时清空滚动历史选项，避免滚动区堆积大量旧帧。
- 改进窄屏下模型/进度显示，优先保留进度条与百分比。

## 2026-01-30
- 取消 HUD 宽度阈值自动增高，默认 `CODEX_HUD_HEIGHT_AUTO=0` 保持固定高度。
- 更新 README 与 issues 索引，新增 HUD 自动增高无效的问题记录。

## 2026-08-04
- 会话绑定 sqlite 查询改用 MATERIALIZED CTE 固定走 ts 索引（273MB logs 库实测单次 ~40-140ms 降至 ~14ms），旧版 sqlite CLI 自动回退平铺查询。
- 渲染路径去 throw：agent 计时时钟偏差 clamp 为 0，未知状态/无效计时降级为 display error 行，避免单条坏 rollout 记录导致 HUD 整体空白。
- HUD pane resize 立即失效重绘（含全屏清理），不再等待下一个刷新周期；滚动区清理保持仅首帧一次。
- 清理死代码：render/index 的 initRenderer/render/renderSingleLine、header 的 legacy 导出、未被引用的 session-line.ts。
- 回退扫描增加 rollout 首行 cwd 缓存（已解析永久缓存，未解析按文件增长失效）；绑定稳定时探测节奏 4s 自适应放宽至上限 12s，变化/失败即回落。
- 新增 GitHub Actions CI（ubuntu，Node 20/22 矩阵，typecheck+build+unit+integration）。

## 2026-08-04（第二轮）
- 修复 compactCount 双计：codex 对同一次压缩同时写顶层 `compacted` 与 `context_compacted` 事件（38 个真实 rollout 实测 1:1），改为分别计数取 max，对只写一种记录的版本同样正确。
- 工具详情显示：read/write/edit 的路径改头部截断保留文件名；失败调用详情在窄屏不再让位给运行中工具。
- 新增运行时热键 `t` 循环工具详情 targets → full → off（环境变量仅作初始值），按键即时重绘；更新 HUD 提示文案并在运行 5 分钟后自动隐藏提示。
- stderr 污染治理：watcher 回调失败、agent 追踪错误、渲染异常不再写 stderr（会落进 HUD 帧），改为 CODEX_HUD_LOG_FILE 可选落盘；界面失败状态仍由 health/tracking 行呈现。
- overview 解析器改有界 LRU（20）保留，会话短暂离开活跃窗口后回归时增量续读而非全量重读。
- 探测用 sqlite 只读句柄常驻复用（出错即弃重开，容量上限防轮转泄漏）；jsonl 读取改 allocUnsafe；文件链接改 file:///（空 authority，兼容 iTerm2 等对主机名链接的拒开）。
- 清理 git.ts legacy execSync 函数族（保留脚本引用的 collectGitStatus）。
- 调查结论：exec_command_begin/end 事件自 2026-06 起不再写入 rollout，文本信封是 exit code 唯一来源，维持现状；ISSUES.md 对齐 011（已修复）与 014（默认关闭已缓解）状态；README（en/zh）补充 Node 22.5+ 推荐说明。
